#!/usr/bin/env bash
# The nightly backup (clauseiq-backup.timer): a dump of the database and an
# archive of the stored originals, kept for 14 days in /opt/clauseiq/backups.
# Installed by provision.sh as /usr/local/bin/clauseiq-backup.
#
# They sit on the disk they protect: they cover a bad migration or a deleted
# document, not the loss of the server. Hetzner's backups of the whole
# server are the copy that survives that.
set -euo pipefail

DIR=/opt/clauseiq/backups
day=$(date +%F)

# The custom format restores into any database with pg_restore — the
# restore check in deploy/README.md uses a scratch one.
docker exec clauseiq-postgres-1 \
  pg_dump --username app --dbname contracts --format custom \
  >"$DIR/contracts-$day.dump.partial"
mv "$DIR/contracts-$day.dump.partial" "$DIR/contracts-$day.dump"

# A copy of MinIO's directory taken while it runs: consistent except for an
# object being written at that very moment, and nothing uploads at 03:00. It
# restores into the same MinIO release.
docker run --rm \
  -v clauseiq_miniodata:/data:ro \
  -v "$DIR":/backup \
  busybox:1.37 tar czf "/backup/minio-$day.tar.gz.partial" -C /data .
mv "$DIR/minio-$day.tar.gz.partial" "$DIR/minio-$day.tar.gz"

find "$DIR" -name 'contracts-*.dump' -mtime +14 -delete
find "$DIR" -name 'minio-*.tar.gz' -mtime +14 -delete
find "$DIR" -name '*.partial' -mtime +1 -delete
echo "backup $day: $(du -sh "$DIR" | cut -f1) in $DIR"
