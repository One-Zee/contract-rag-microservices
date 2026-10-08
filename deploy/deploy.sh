#!/usr/bin/env bash
# Deploys one commit: the checkout of that commit's compose files, the image
# CI published for it, `up --wait`. Installed by provision.sh as
# /usr/local/bin/clauseiq-deploy — a copy, because the checkout below replaces
# this file while bash is still reading it — and the forced command of CI's
# key on the `deploy` user:
#
#   CI          printf %s "$TOKEN" | ssh deploy@<server> "<sha> <registry user>"
#   by hand     sudo -u deploy clauseiq-deploy <sha>
#
# CI's job token arrives on stdin: enough to pull this one image, and expired
# soon after, so the server keeps no registry credential. By hand there is no
# token, and the image must still be on the server — a rollback within the
# week images are kept for.
set -euo pipefail

REPOSITORY=git@github.com:One-Zee/contract-rag-microservices.git
IMAGE=ghcr.io/one-zee/clauseiq
HOME_DIR=/opt/clauseiq
CHECKOUT=$HOME_DIR/repo

# Over SSH the arguments arrive in SSH_ORIGINAL_COMMAND; by hand, as $@.
read -r -a words <<<"${SSH_ORIGINAL_COMMAND:-$*}"
sha=${words[0]:-}
registry_user=${words[1]:-deploy}
if [[ ! $sha =~ ^[0-9a-f]{40}$ ]]; then
  echo "usage: clauseiq-deploy <40-character commit sha> [registry user]" >&2
  exit 2
fi

if [[ ! -d $CHECKOUT/.git ]]; then
  git clone --quiet "$REPOSITORY" "$CHECKOUT"
fi
cd "$CHECKOUT"
git fetch --quiet origin
git checkout --quiet --detach "$sha"
if [[ ! -f .env ]]; then
  echo "$CHECKOUT/.env is missing — see deploy/production.env.example" >&2
  exit 1
fi

export CLAUSEIQ_IMAGE=$IMAGE:$sha
compose() {
  docker compose --project-name clauseiq --env-file .env \
    -f docker/docker-compose.yaml \
    -f docker/docker-compose.observability.yaml \
    -f docker/docker-compose.services.yaml \
    -f docker/docker-compose.prod.yaml "$@"
}

token=
[[ -t 0 ]] || token=$(cat)
if [[ -n $token ]]; then
  printf '%s' "$token" |
    docker login ghcr.io --username "$registry_user" --password-stdin >/dev/null
  trap 'docker logout ghcr.io >/dev/null' EXIT
  compose pull --quiet
fi

compose up -d --wait --remove-orphans
echo "$sha" >"$HOME_DIR/deployed"
# What no container uses and is older than a week goes: the images of
# earlier deploys stay that long, for a rollback without the registry.
docker image prune --all --force --filter until=168h >/dev/null
echo "deployed $sha"
