#!/bin/sh
# Portal's backups: the whole database (uploaded files live in it too) as an encrypted
# restic snapshot in off-host storage. Run by the `backup` service in compose.yaml.
#   (no argument)            back up now, then every hour
#   once                     back up now
#   restore-test             restore the latest snapshot into a scratch database and compare it with the live one
#   restore [snapshot id]    replace the live database with a snapshot (the latest unless one is named)
#   anything else            passed to restic: snapshots, check, ...
set -eu -o pipefail
: "${RESTIC_REPOSITORY:?set RESTIC_REPOSITORY in the settings file (README, Backups)}"
: "${RESTIC_PASSWORD:?set RESTIC_PASSWORD in the settings file (README, Backups)}"
DUMP=/portal.dump

# One && chain: called from the loop's `if`, where `set -e` is off, a failed step must still stop the rest.
backup() {
    { restic cat config >/dev/null 2>&1 || restic init; } &&
    # --stdin-from-command: a pg_dump that fails part-way fails the snapshot, instead of saving half a dump.
    # --compress=0: restic compresses and deduplicates itself, so each hour stores only what changed.
    restic backup --host portal --stdin-filename "$DUMP" --stdin-from-command -- pg_dump --format=custom --compress=0 &&
    # The alert is this ping NOT arriving, so only a finished backup sends it.
    { [ -z "${BACKUP_PING_URL:-}" ] || wget -q -O /dev/null "$BACKUP_PING_URL" || echo "backup: could not reach BACKUP_PING_URL"; }
}

restore_test() {
    scratch=portal_restore_test
    dropdb --if-exists "$scratch"
    createdb "$scratch"
    restic snapshots --host portal --latest 1
    restic dump --host portal latest "$DUMP" | pg_restore --exit-on-error --no-owner --dbname "$scratch"
    bad=0
    for table in Tenants Lease Charge Payment Documents Lease_Documents Maintenance_T Messages; do
        live=$(psql -At -c "SELECT count(*) FROM $table")
        restored=$(psql -At -d "$scratch" -c "SELECT count(*) FROM $table")
        echo "  $table: live $live, restored $restored"
        # The snapshot is up to an hour old, so fewer rows is normal; none where the live table has some is not.
        [ "$restored" -gt 0 ] || [ "$live" -eq 0 ] || bad=1
    done
    dropdb "$scratch"
    [ "$bad" -eq 0 ] || { echo "restore-test: FAILED, a table came back empty"; exit 1; }
    echo "restore-test: passed"
}

case "${1:-loop}" in
    loop)
        while true; do
            if backup; then echo "backup: done $(date -u +%FT%TZ)"; else echo "backup: FAILED $(date -u +%FT%TZ)"; fi
            # Once a day: thin out old snapshots (hourly for 2 days, daily for 2 weeks, weekly for 2 months, monthly for a year).
            [ "$(date -u +%H)" != 09 ] || restic forget --host portal --keep-hourly 48 --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune || echo "backup: could not prune old snapshots"
            sleep 3600
        done ;;
    once) backup ;;
    restore-test) restore_test ;;
    # --clean --create drops and recreates the database, so nothing else may be connected (portal.mjs stops the app first).
    restore) restic dump --host portal "${2:-latest}" "$DUMP" | pg_restore --clean --if-exists --create --exit-on-error --dbname postgres ;;
    *) exec restic "$@" ;;
esac
