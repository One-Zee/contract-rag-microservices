# Deployment

ClauseIQ in production runs on one Ubuntu 24.04 server:

- the six services, from the image CI publishes for each commit on `master`;
- the infrastructure and the observability stack;
- Caddy in front, the only container on a public interface.

The final load figures come from a second, short-lived server (the last
section of this document).

```
push to master → CI: lint, unit, e2e → image ghcr.io/one-zee/clauseiq:<sha>
              → deploy job (environment `production`, approved by you)
              → ssh deploy@server "<sha>" → clauseiq-deploy: checkout <sha>, pull, up --wait
```

The server's `.env` holds every secret. It lives on the server only. CI
holds a key that can do one thing there, deploy a commit, and the job token
it pulls the image with expires when the job ends.

## The server

1. **Hetzner Cloud:** CX33 (4 vCPU, 8 GB), Ubuntu 24.04, x86, Nürnberg or
   Falkenstein, your SSH key, and **Backups** on (daily images of the whole
   server, kept off it).
2. **Firewall** (Hetzner Cloud Firewall, applied to the server). Inbound:
   - 22/tcp;
   - 80/tcp;
   - 443/tcp;
   - 443/udp.

   Docker writes its own iptables rules past `ufw`, so the firewall belongs in
   front of the server, not on it.
3. **The key CI deploys with**, on your machine:
   ```bash
   ssh-keygen -t ed25519 -N '' -C clauseiq-ci -f clauseiq-ci
   ```
4. **Provision:**
   ```bash
   cp clauseiq-ci.pub deploy/ci.pub
   scp -r deploy root@<ip>:clauseiq-deploy && rm deploy/ci.pub
   ssh root@<ip> bash clauseiq-deploy/provision.sh
   ```
   It ends by printing a public key. Add it to the repository as a deploy
   key: Settings → Deploy keys, **read-only**.

## GitHub

1. Settings → Environments → **`production`**. Add yourself as a required
   reviewer, so that every deploy waits for your approval.
2. Secrets of that environment:

   | Secret | Value |
   |---|---|
   | `DEPLOY_HOST` | the server's IP address |
   | `DEPLOY_SSH_KEY` | the private key `clauseiq-ci` (then delete the file) |
   | `DEPLOY_KNOWN_HOSTS` | the output of `ssh-keyscan -t ed25519 <ip>` |

   For `DEPLOY_KNOWN_HOSTS`, first compare the fingerprint
   (`ssh-keygen -lf` on that line) with the one the server itself reports. Run
   `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` in the Hetzner console.
   A mismatch means you are not talking to your server.

## The server's `.env`

```bash
ssh root@<ip>
sudo -u deploy git clone git@github.com:One-Zee/contract-rag-microservices.git /opt/clauseiq/repo
sudo -u deploy install -m 600 /opt/clauseiq/repo/deploy/production.env.example /opt/clauseiq/repo/.env
sudo -u deploy nano /opt/clauseiq/repo/.env      # the comments say how to generate each value
```

## The first deploy

Merge `dev` into `master`. CI then:

1. runs the checks;
2. publishes the image;
3. waits for your approval, and deploys.

Afterwards:

```bash
curl -k https://<ip>/health        # -k until Caddy's root is trusted, below
```

Every later merge into `master` deploys the same way.

**Rollback** to any commit deployed within the last week (its image is
still on the server):

```bash
sudo -u deploy clauseiq-deploy <sha>
```

An older one goes through CI. Revert, then merge.

## The first accounts

Registration is closed in production. Open it just long enough to create the
accounts:

1. In `.env`, set `AUTH_REGISTRATION_ENABLED=true`, then redeploy:
   `sudo -u deploy clauseiq-deploy $(cat /opt/clauseiq/deployed)`.
2. Register through `POST /auth/register` (Swagger: `https://<ip>/api/docs`).
3. Make your account an admin:
   ```bash
   docker exec clauseiq-postgres-1 psql -U app -d contracts \
     -c "UPDATE users SET role = 'admin' WHERE email = 'you@example.com'"
   ```
4. Set `AUTH_REGISTRATION_ENABLED=false` and redeploy. `POST /auth/register` now answers 403.

## HTTPS without a domain

`SITE_ADDRESS` is the IP address and `CADDY_TLS=internal`. The certificate
comes from Caddy's own certificate authority, so a browser warns until that
authority's root is trusted:

```bash
docker cp clauseiq-caddy-1:/data/caddy/pki/authorities/local/root.crt clauseiq-root.crt
# import it into the system or browser trust store, or: curl --cacert clauseiq-root.crt https://<ip>/health
```

**With a domain:**

1. Point an A record at the server.
2. Set `SITE_ADDRESS=<domain>` and `CADDY_TLS=<your e-mail>`, and redeploy.
   Caddy then obtains a Let's Encrypt certificate.
3. Only then add `Strict-Transport-Security` to `docker/Caddyfile`.

## What is not public

Grafana is at `https://<ip>/grafana/`, behind its own login (`admin` and
`GRAFANA_ADMIN_PASSWORD`).

Jaeger, Prometheus, RabbitMQ's console, Postgres and MinIO listen on the
server's loopback only. Reach them through a tunnel:

```bash
ssh -L 16686:127.0.0.1:16686 -L 9090:127.0.0.1:9090 -L 15672:127.0.0.1:15672 root@<ip>
# Jaeger http://localhost:16686 · Prometheus http://localhost:9090 · RabbitMQ http://localhost:15672
```

## Backups

`clauseiq-backup.timer` runs every night at 03:00, server time. It writes a
`pg_dump` and an archive of MinIO's data to `/opt/clauseiq/backups` and keeps
14 days of them. Run it now and then check it with
`systemctl status clauseiq-backup`:

```bash
systemctl start clauseiq-backup
```

**Restore check:** restore into a scratch database and compare the counts:

```bash
dump=$(ls -t /opt/clauseiq/backups/contracts-*.dump | head -1)
docker exec clauseiq-postgres-1 createdb -U app contracts_restore
docker exec -i clauseiq-postgres-1 pg_restore -U app -d contracts_restore < "$dump"
for db in contracts contracts_restore; do
  docker exec clauseiq-postgres-1 psql -U app -d $db -tAc \
    "SELECT '$db', (SELECT count(*) FROM users), (SELECT count(*) FROM documents),
            (SELECT count(*) FROM chunks), (SELECT count(*) FROM queries)"
done
docker exec clauseiq-postgres-1 dropdb -U app contracts_restore
```

These copies sit on the server's own disk. Hetzner's Backups are the copy
that survives losing it.

## The measurement host

The final load figures come from a server with **dedicated** cores (CCX33:
8 vCPU, 32 GB). It is billed by the hour and deleted after the series, which
takes about 3.6 hours (`npm run load:series -- --dry-run`). It runs from a
pushed commit, after `npm run load:calibrate` has been committed.

```bash
scp deploy/provision.sh root@<ip>: && ssh root@<ip> bash provision.sh --measure
ssh -A root@<ip>                       # your agent, for the clone; nothing stays on the server
git clone git@github.com:One-Zee/contract-rag-microservices.git && cd contract-rag-microservices
git checkout <sha> && npm ci && npm run eval:fetch
cp .env.example .env                   # then JWT_PRIVATE_KEY / JWT_PUBLIC_KEY as in production.env.example
tmux new -s load 'npm run load:series' # detach with Ctrl-b d; it survives a dropped connection
```

Every provider is a stub there, so `.env` needs no API keys.

**Afterwards, on your machine:**

1. Move the old `eval/results/load/raw/` aside.
2. Copy the results back:
   ```bash
   rsync -a root@<ip>:contract-rag-microservices/eval/results/load/raw/ eval/results/load/raw/
   ```
3. Run `npm run load:summary`. Check that its provenance names one machine,
   one commit and one image, and that the CPU steal is near 0.
4. Delete the server in the Hetzner console. Billing stops with it.

**One server for both** (a CX43 instead of a CCX33) works with the same
commands:

1. Stop production first:
   `docker compose --project-name clauseiq ... down`, with the same `-f`
   files as `clauseiq-deploy`.
2. Run the series from a separate checkout.
3. Redeploy afterwards.

The shared cores show up as CPU steal in the summary.
