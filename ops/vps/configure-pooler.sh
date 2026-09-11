#!/usr/bin/env bash
set -euo pipefail
[ "$(id -u)" = 0 ]
cp --update=none /etc/pgbouncer/pgbouncer.ini /root/nota-setup/pgbouncer.before
cat > /etc/pgbouncer/pgbouncer.ini <<'CONF'
[databases]
nota = host=localhost port=5432 dbname=nota
[pgbouncer]
listen_addr = 127.0.0.1
listen_port = 6432
unix_socket_dir = /var/run/postgresql
pidfile = /var/run/postgresql/pgbouncer.pid
logfile = /var/log/postgresql/pgbouncer.log
auth_type = scram-sha-256
auth_file = /etc/pgbouncer/userlist.txt
pool_mode = transaction
max_client_conn = 80
default_pool_size = 5
reserve_pool_size = 1
max_db_connections = 6
server_idle_timeout = 60
query_wait_timeout = 30
client_tls_sslmode = require
client_tls_cert_file = /etc/postgresql/nota-tls/server.crt
client_tls_key_file = /etc/postgresql/nota-tls/server.key
server_tls_sslmode = verify-full
server_tls_ca_file = /etc/postgresql/nota-tls/ca.crt
CONF
runuser -u postgres -- psql -X -At -d postgres -c "SELECT chr(34)||rolname||chr(34)||' '||chr(34)||rolpassword||chr(34) FROM pg_authid WHERE rolname='nota_app_runtime'" > /etc/pgbouncer/userlist.txt
chown postgres:postgres /etc/pgbouncer/pgbouncer.ini /etc/pgbouncer/userlist.txt
chmod 640 /etc/pgbouncer/pgbouncer.ini
chmod 600 /etc/pgbouncer/userlist.txt
systemctl restart pgbouncer
systemctl enable pgbouncer
systemctl is-active pgbouncer
ss -lnt | awk 'NR==1 || /:6432/'
DEBIAN_FRONTEND=noninteractive apt-get install -y python3-boto3 python3-cryptography >/root/nota-setup/backup-packages.log 2>&1
printf 'BACKUP_DEPENDENCIES_READY\n'
