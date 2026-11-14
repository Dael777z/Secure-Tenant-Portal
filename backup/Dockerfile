# The backup job: the same Postgres as the db service (so pg_dump matches it) plus restic.
FROM postgres:16-alpine
RUN apk add --no-cache restic
COPY backup.sh /usr/local/bin/backup.sh
ENV RESTIC_CACHE_DIR=/tmp/restic-cache
USER postgres
ENTRYPOINT ["sh", "/usr/local/bin/backup.sh"]
