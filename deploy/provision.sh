#!/usr/bin/env bash
# Prepares a fresh Ubuntu 24.04 server, as root, once (deploy/README.md):
#
#   production   scp -r deploy root@<server>:clauseiq-deploy   (with ci.pub in it)
#                ssh root@<server> bash clauseiq-deploy/provision.sh
#   load tests   scp deploy/provision.sh root@<server>:
#                ssh root@<server> bash provision.sh --measure
#
# Both: system upgrades, Docker from Docker's repository with log rotation,
# and SSH by key only. Production adds automatic security upgrades, the
# `deploy` user — whose one key is CI's and whose one command is
# clauseiq-deploy — a read-only key for cloning the repository, and the
# nightly backup. --measure adds Node 24, git, lsof and tmux instead, and
# nothing that runs on a schedule: an upgrade or a backup in the middle of a
# load series would be measured too.
set -euo pipefail

measure=false
[[ ${1:-} == --measure ]] && measure=true
here=$(cd "$(dirname "$0")" && pwd)
export DEBIAN_FRONTEND=noninteractive

if [[ $(id -u) -ne 0 ]]; then
  echo "run as root" >&2
  exit 1
fi
if ! $measure && [[ ! -s $here/ci.pub ]]; then
  echo "$here/ci.pub is missing: the public half of the key CI deploys with" >&2
  exit 1
fi

echo "== packages"
apt-get update -q
apt-get upgrade -y -q
apt-get install -y -q ca-certificates curl git python3

echo "== Docker"
install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
# shellcheck source=/dev/null # the system's release file, for VERSION_CODENAME
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" \
  >/etc/apt/sources.list.d/docker.list
apt-get update -q
apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
# Without rotation a container's log grows until the disk is full.
cat >/etc/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
EOF
systemctl restart docker

echo "== SSH: keys only"
cat >/etc/ssh/sshd_config.d/10-clauseiq.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
sshd -t
systemctl reload ssh || true

if $measure; then
  echo "== Node 24, lsof, tmux"
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y -q nodejs lsof tmux
  node --version
  echo
  echo "Ready for load tests. Next (deploy/README.md, 'The measurement host'):"
  echo "  ssh -A root@<this server>, clone the repository, npm ci, npm run eval:fetch"
  exit 0
fi

echo "== automatic security upgrades, rebooting at 04:30 when one needs it"
apt-get install -y -q unattended-upgrades
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
cat >/etc/apt/apt.conf.d/52clauseiq-reboot <<'EOF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:30";
EOF

echo "== the deploy user"
id deploy >/dev/null 2>&1 || useradd --create-home --shell /bin/bash deploy
usermod -aG docker deploy
install -d -o deploy -g deploy -m 0700 /home/deploy/.ssh
# CI's key runs clauseiq-deploy and nothing else: no shell, no forwarding.
printf 'command="/usr/local/bin/clauseiq-deploy",restrict %s\n' "$(cat "$here/ci.pub")" \
  >/home/deploy/.ssh/authorized_keys
# The key the server clones with — read-only, added to the repository's
# deploy keys — and GitHub's host keys, from GitHub's API over HTTPS.
[[ -f /home/deploy/.ssh/github ]] ||
  ssh-keygen -q -t ed25519 -N '' -C "clauseiq-deploy@$(hostname)" -f /home/deploy/.ssh/github
curl -fsSL https://api.github.com/meta |
  python3 -c 'import json, sys; print("\n".join("github.com " + key for key in json.load(sys.stdin)["ssh_keys"]))' \
    >/home/deploy/.ssh/known_hosts
cat >/home/deploy/.ssh/config <<'EOF'
Host github.com
  IdentityFile ~/.ssh/github
  IdentitiesOnly yes
EOF
chown -R deploy:deploy /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys /home/deploy/.ssh/config /home/deploy/.ssh/github

echo "== /opt/clauseiq, the deploy command and the nightly backup"
install -d -o deploy -g deploy -m 0750 /opt/clauseiq /opt/clauseiq/backups
# Copies, not links into the checkout: a deploy replaces the checkout while
# bash is still reading the script that runs it.
install -m 0755 "$here/deploy.sh" /usr/local/bin/clauseiq-deploy
install -m 0755 "$here/backup.sh" /usr/local/bin/clauseiq-backup
install -m 0644 "$here/clauseiq-backup.service" "$here/clauseiq-backup.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now clauseiq-backup.timer

echo
echo "Done. Add this key to the repository as a read-only deploy key"
echo "(GitHub → Settings → Deploy keys), then continue with deploy/README.md:"
echo
cat /home/deploy/.ssh/github.pub
