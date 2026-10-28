FROM postgres:18-alpine
RUN apk add --no-cache age rclone curl
# rclone's B2 defaults buffer 4 x 96 MiB of a streamed upload in memory; the pilot has 961 MB
ENV RCLONE_B2_CHUNK_SIZE=5Mi RCLONE_B2_UPLOAD_CONCURRENCY=1
# the remote is configured by RCLONE_CONFIG_BACKUP_* alone; without a file rclone logs a notice
# on every call
ENV RCLONE_CONFIG=/dev/null
COPY *.sh /opt/binarius-backup/
RUN mkdir -p /run/backup && for c in backup-now restore-check restore fetch-env; do printf '#!/bin/sh\nexec sh /opt/binarius-backup/entrypoint.sh %s "$@"\n' "$c" > "/usr/local/bin/$c" && chmod 755 "/usr/local/bin/$c"; done
ENTRYPOINT ["sh", "/opt/binarius-backup/entrypoint.sh"]
CMD ["loop"]
