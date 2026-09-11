#!/usr/bin/env bash
set -euo pipefail
systemctl is-active --quiet ssh postgresql@16-main pgbouncer
systemctl is-active --quiet nota-backup.timer nota-db-tls-renew.timer
/usr/sbin/sshd -t
openssl x509 -checkend 604800 -noout -in /etc/postgresql/nota-tls/server.crt >/dev/null
if [ -f /etc/systemd/system/nota-web.service ]; then
    systemctl is-active --quiet nota-web nginx nota-web-cert-renew.timer
    openssl x509 -checkend 86400 -noout -in /etc/letsencrypt/live/nota-ip/fullchain.pem >/dev/null
    curl --fail --silent --show-error --max-time 15 http://127.0.0.1:3000/api/setup | python3 -c 'import json,sys; data=json.load(sys.stdin); sys.exit(0 if data.get("result",{}).get("databaseReady") is True else "WEB_DATABASE_NOT_READY")'
    if [ -f /etc/systemd/system/nota-worker.service ]; then
        systemctl is-active --quiet nota-worker
    fi
    echo WEB_HEALTH_OK
fi
python3 - <<'PY'
import datetime,json,pathlib,shutil
p=pathlib.Path('/var/lib/nota-backup/last-success.json')
record=json.loads(p.read_text())
age=datetime.datetime.now(datetime.timezone.utc)-datetime.datetime.fromisoformat(record['at'])
if age.total_seconds()>36*3600: raise SystemExit('BACKUP_STALE')
disk=shutil.disk_usage('/')
if disk.used/disk.total>0.85: raise SystemExit('DISK_ABOVE_85_PERCENT')
if not record.get('offsite') or not record.get('remote_readback'): raise SystemExit('OFFSITE_BACKUP_NOT_VERIFIED')
print('DATABASE_HEALTH_OK; OFFSITE_BACKUP_VERIFIED')
PY
