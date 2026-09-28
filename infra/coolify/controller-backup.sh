#!/usr/bin/env bash
set -euo pipefail
umask 077

state=/var/lib/reltide-controller-backup
install -d -m 0700 "$state"
exec 9>"$state/lock"
flock -n 9 || exit 0
work=$(mktemp -d "$state/work.XXXXXXXX")
trap 'rm -rf -- "$work"' EXIT

docker exec coolify-db sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner' > "$work/coolify.dmp"
test -s "$work/coolify.dmp"
docker inspect coolify coolify-db coolify-redis coolify-realtime \
  --format '{{.Name}} {{.Config.Image}} {{.Image}}' > "$work/images.txt"
date -u +%FT%TZ > "$work/created-at.txt"

# Include the matching APP_KEY and dedicated keys, never just the SQL dump.
# Application databases and volumes are outside this controller backup.
tar --exclude=data/coolify/ssh/mux -czf "$work/controller.tar.gz" \
  -C "$work" coolify.dmp images.txt created-at.txt \
  -C / data/coolify/source/.env data/coolify/source/docker-compose.yml \
  data/coolify/source/docker-compose.prod.yml data/coolify/source/docker-compose.custom.yml \
  data/coolify/ssh data/coolify/proxy root/.ssh/authorized_keys \
  etc/reltide etc/docker/daemon.json \
  etc/systemd/system/docker.service.d/reltide-firewall.conf \
  etc/systemd/system/reltide-controller-backup.service \
  etc/systemd/system/reltide-controller-backup.timer \
  etc/systemd/system/reltide-private-firewall.service \
  etc/systemd/system/reltide-monitor.service etc/systemd/system/reltide-monitor.timer \
  usr/local/sbin/reltide-controller-backup usr/local/sbin/reltide-private-firewall \
  usr/local/sbin/reltide-monitor
age -r "$(cat /etc/reltide/recovery-recipient.txt)" \
  -o "$work/controller.tar.gz.age" "$work/controller.tar.gz"

python3 - "$work/controller.tar.gz.age" "$state" <<'PY'
import datetime
import hashlib
import json
import pathlib
import sys

import boto3

archive, state = map(pathlib.Path, sys.argv[1:])
size = archive.stat().st_size
if size > 128 * 1024 * 1024:
    raise RuntimeError("Controller backup exceeded the 128 MiB budget; review growth")
config = json.loads(pathlib.Path('/etc/reltide/controller-backup.json').read_text())
endpoint = f"https://{config['account_id']}.eu.r2.cloudflarestorage.com"
client = boto3.client('s3', endpoint_url=endpoint, region_name='auto',
                      aws_access_key_id=config['access_key_id'],
                      aws_secret_access_key=config['secret_access_key'])
now = datetime.datetime.now(datetime.timezone.utc)
sha = hashlib.sha256(archive.read_bytes()).hexdigest()
key = f"controller/{now:%Y/%m/%d/%H%M%S}-{sha[:12]}.tar.gz.age"
client.upload_file(str(archive), config['bucket'], key,
                   ExtraArgs={'ContentType': 'application/octet-stream', 'Metadata': {'sha256': sha}})
head = client.head_object(Bucket=config['bucket'], Key=key)
if head['ContentLength'] != size or head['Metadata'].get('sha256') != sha:
    raise RuntimeError('Uploaded backup metadata did not match')
record = {'completed_at': now.isoformat(), 'bucket': config['bucket'],
          'key': key, 'bytes': size, 'sha256': sha}
temporary = state / 'last-success.json.new'
temporary.write_text(json.dumps(record, indent=2) + '\n')
temporary.replace(state / 'last-success.json')
print(json.dumps(record))
PY
