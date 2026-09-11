#!/usr/bin/env bash
set -euo pipefail
[ "$(id -u)" = 0 ]
install -d -m 700 /root/nota-setup/ca
install -d -m 750 -o postgres -g postgres /etc/postgresql/nota-tls
if [ ! -f /root/nota-setup/ca/ca.key ]; then
 openssl req -x509 -newkey rsa:3072 -nodes -days 3650 -keyout /root/nota-setup/ca/ca.key -out /root/nota-setup/ca/ca.crt -subj '/CN=Database Nota Private CA' >/dev/null 2>&1
 chmod 600 /root/nota-setup/ca/ca.key
fi
cat > /usr/local/sbin/nota-renew-db-tls <<'RENEW'
#!/bin/bash
set -euo pipefail
cert=/etc/postgresql/nota-tls/server.crt
if [ -f "$cert" ] && openssl x509 -checkend 2592000 -noout -in "$cert" >/dev/null; then exit 0; fi
work=$(mktemp -d /root/nota-setup/tls.XXXXXX)
trap 'rm -rf -- "$work"' EXIT
openssl req -new -newkey rsa:3072 -nodes -keyout "$work/server.key" -out "$work/server.csr" -subj '/CN=localhost' >/dev/null 2>&1
printf 'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyEncipherment\nbasicConstraints=CA:FALSE\n' > "$work/extensions"
openssl x509 -req -days 90 -in "$work/server.csr" -CA /root/nota-setup/ca/ca.crt -CAkey /root/nota-setup/ca/ca.key -CAcreateserial -extfile "$work/extensions" -out "$work/server.crt" >/dev/null 2>&1
openssl verify -CAfile /root/nota-setup/ca/ca.crt "$work/server.crt"
install -m 600 -o postgres -g postgres "$work/server.key" /etc/postgresql/nota-tls/server.key
install -m 644 -o postgres -g postgres "$work/server.crt" "$cert"
install -m 644 -o postgres -g postgres /root/nota-setup/ca/ca.crt /etc/postgresql/nota-tls/ca.crt
systemctl is-active --quiet postgresql@16-main && systemctl reload postgresql@16-main || true
if systemctl is-active --quiet pgbouncer; then systemctl reload pgbouncer; fi
RENEW
chmod 700 /usr/local/sbin/nota-renew-db-tls
/usr/local/sbin/nota-renew-db-tls
cp -n /etc/postgresql/16/main/pg_hba.conf /root/nota-setup/pg_hba.before || true
cat > /etc/postgresql/16/main/conf.d/nota.conf <<'CONF'
listen_addresses = 'localhost'
max_connections = 40
shared_buffers = '256MB'
effective_cache_size = '1536MB'
work_mem = '4MB'
maintenance_work_mem = '64MB'
password_encryption = 'scram-sha-256'
ssl = on
ssl_cert_file = '/etc/postgresql/nota-tls/server.crt'
ssl_key_file = '/etc/postgresql/nota-tls/server.key'
ssl_min_protocol_version = 'TLSv1.2'
timezone = 'UTC'
log_timezone = 'UTC'
log_min_duration_statement = -1
log_statement = 'none'
log_min_error_statement = 'panic'
idle_in_transaction_session_timeout = '60s'
CONF
cat > /etc/postgresql/16/main/pg_hba.conf <<'HBA'
local all postgres peer
local all all peer
hostssl nota nota_migrator 127.0.0.1/32 scram-sha-256
hostssl nota nota_migrator ::1/128 scram-sha-256
hostssl nota nota_app_runtime 127.0.0.1/32 scram-sha-256
hostssl nota nota_app_runtime ::1/128 scram-sha-256
host all all 0.0.0.0/0 reject
host all all ::/0 reject
HBA
chown postgres:postgres /etc/postgresql/16/main/pg_hba.conf /etc/postgresql/16/main/conf.d/nota.conf
chmod 640 /etc/postgresql/16/main/pg_hba.conf
systemctl restart postgresql@16-main
systemctl enable postgresql
cat > /etc/systemd/system/nota-db-tls-renew.service <<'UNIT'
[Unit]
Description=Renew local PostgreSQL TLS certificate
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/nota-renew-db-tls
UMask=0077
UNIT
cat > /etc/systemd/system/nota-db-tls-renew.timer <<'UNIT'
[Unit]
Description=Check PostgreSQL TLS certificate daily
[Timer]
OnCalendar=daily
RandomizedDelaySec=1h
Persistent=true
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now nota-db-tls-renew.timer
runuser -u postgres -- psql -X -At -c "SELECT version(); SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL;"
ss -lnt | awk 'NR==1 || /:5432/'
