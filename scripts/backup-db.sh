#!/usr/bin/env bash
#
# Nightly PostgreSQL backup for Cinewatch (production).
#
# Dumps the `cineplex_watcher` database out of the Dockerized Postgres,
# gzips it, and keeps the last KEEP_DAYS days of dumps in /opt/backups.
# Designed to run unattended from cron; every run appends a timestamped
# line to /opt/backups/backup.log so you can audit that it is working.
#
# Install (on the server, once):
#   chmod +x /opt/cinewatch/scripts/backup-db.sh
#   sudo mkdir -p /opt/backups && sudo chown ubuntu:ubuntu /opt/backups
#   crontab -e
#     15 9 * * * /opt/cinewatch/scripts/backup-db.sh >> /opt/backups/backup.log 2>&1
#
# Restore (practice this at least once — an untested backup is a hope):
#   gunzip -c /opt/backups/cinewatch-YYYY-MM-DD.sql.gz \
#     | docker compose -f /opt/cinewatch/docker-compose.prod.yml \
#         exec -T postgres psql -U postgres -d cineplex_watcher

set -euo pipefail

# Cron runs with a minimal PATH; make sure `docker` resolves.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

BACKUP_DIR=/opt/backups
COMPOSE="docker compose -f /opt/cinewatch/docker-compose.prod.yml"
DB_NAME=cineplex_watcher
DB_USER=postgres
KEEP_DAYS=7

stamp() { date '+%Y-%m-%dT%H:%M:%S%z'; }
log()   { echo "$(stamp) $*"; }

# On any failure, leave a clearly-marked line in the log so a human (or a
# future log-scraping monitor) can tell a backup did NOT happen.
trap 'log "ERROR: backup FAILED (see output above)"' ERR

mkdir -p "$BACKUP_DIR"

today="$(date +%F)"                                   # e.g. 2026-07-16
final="$BACKUP_DIR/cinewatch-${today}.sql.gz"
tmp="$BACKUP_DIR/.cinewatch-${today}.sql.gz.tmp"

log "starting backup -> $final"

# Dump into a TEMP file first. With `pipefail`, if pg_dump exits non-zero the
# whole pipeline fails and `set -e` aborts here — so a broken dump never
# overwrites a good one and never triggers the retention prune below.
$COMPOSE exec -T postgres pg_dump -U "$DB_USER" "$DB_NAME" | gzip > "$tmp"

# A pg_dump that "succeeds" but produces an empty file is still a failed
# backup. Refuse to promote a zero-byte dump.
if [ ! -s "$tmp" ]; then
  log "ERROR: dump produced an empty file; not promoting"
  rm -f "$tmp"
  exit 1
fi

# Atomic move: the final backup either exists complete or not at all.
mv "$tmp" "$final"
log "backup OK: $(du -h "$final" | cut -f1) -> $final"

# Retention: delete dumps older than KEEP_DAYS. Only reached on success.
deleted="$(find "$BACKUP_DIR" -name 'cinewatch-*.sql.gz' -mtime "+$KEEP_DAYS" -print -delete | wc -l)"
log "retention: removed $deleted dump(s) older than ${KEEP_DAYS}d"
