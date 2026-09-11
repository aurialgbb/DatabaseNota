#!/usr/bin/env bash
set -euo pipefail
[ "$(id -u)" = 0 ]
export DEBIAN_FRONTEND=noninteractive
apt-get install -y nginx python3-venv curl xz-utils >/root/nota-setup/web-packages.log 2>&1
id nota-web >/dev/null 2>&1 || useradd --system --home-dir /var/lib/nota-web --create-home --shell /usr/sbin/nologin nota-web
id nota-build >/dev/null 2>&1 || useradd --system --home-dir /var/lib/nota-build --create-home --shell /usr/sbin/nologin nota-build
install -d -m 755 /srv/nota /srv/nota/releases /var/www/nota-acme
install -d -o nota-web -g nota-web -m 750 /var/lib/nota-web/workflow /var/lib/nota-web/cache
install -d -m 755 /opt/nodejs
python3 - <<'PY'
import hashlib,pathlib,re,tarfile,urllib.request
base='https://nodejs.org/dist/latest-v24.x/'
checks=urllib.request.urlopen(base+'SHASUMS256.txt',timeout=30).read().decode()
line=next(x for x in checks.splitlines() if re.fullmatch(r'[a-f0-9]{64}\s+node-v24\.\d+\.\d+-linux-x64\.tar\.xz',x))
checksum,name=line.split()
version=name.removesuffix('-linux-x64.tar.xz').removeprefix('node-')
archive=pathlib.Path('/root/nota-setup')/name
with urllib.request.urlopen('https://nodejs.org/dist/'+version+'/'+name,timeout=60) as response,open(archive,'wb') as out:
    while block:=response.read(1024*1024):out.write(block)
with open(archive,'rb') as inp:
    if hashlib.file_digest(inp,'sha256').hexdigest()!=checksum:raise SystemExit('NODE_CHECKSUM_MISMATCH')
with tarfile.open(archive) as tar:tar.extractall('/opt/nodejs',filter='data')
path=pathlib.Path('/opt/nodejs/current')
if path.is_symlink():path.unlink()
path.symlink_to('/opt/nodejs/'+name.removesuffix('.tar.xz'))
print('NODE_INSTALLED',version)
PY
python3 -m venv /opt/nota-certbot
/opt/nota-certbot/bin/pip install --disable-pip-version-check 'certbot>=5.4,<6' >/root/nota-setup/certbot-install.log 2>&1
/opt/nota-certbot/bin/certbot --version
/opt/nodejs/current/bin/node --version
cat > /etc/nginx/sites-available/nota <<'NGINX'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    server_tokens off;
    location ^~ /.well-known/acme-challenge/ { root /var/www/nota-acme; }
    location / { return 503; }
}
NGINX
if [ -L /etc/nginx/sites-enabled/default ]; then unlink /etc/nginx/sites-enabled/default; fi
ln -sfn /etc/nginx/sites-available/nota /etc/nginx/sites-enabled/nota
nginx -t
systemctl enable --now nginx
systemctl reload nginx
ufw allow 80/tcp comment 'Web and certificate validation'
ufw allow 443/tcp comment 'HTTPS webapp'
