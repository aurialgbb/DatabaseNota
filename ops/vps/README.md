# Status setup VPS Database Nota

Diverifikasi 11 September 2026. Ini status infrastruktur database, bukan pernyataan bahwa seluruh aplikasi siap production.

## Konfigurasi

- Ubuntu 24.04, 2 vCPU, RAM sekitar 4 GB, disk sekitar 60 GB.
- PostgreSQL 16 dari repositori Ubuntu. Database `nota`, schema `nota_app`, 22 tabel dari dua migrasi.
- `nota_migrator`: pemilik database untuk perubahan schema; bukan superuser dan tidak memiliki CREATEROLE setelah provisioning.
- `nota_app_runtime`: user aplikasi dengan DML terbatas, maksimum 8 koneksi; tidak bisa mengubah struktur atau ledger migrasi. Ini belum merupakan RLS antarcabang.
- PostgreSQL localhost:5432; PgBouncer transaction pooling localhost:6432. Kedua port tidak dibuka ke internet.
- TLS wajib untuk TCP database dan pooler. CA privat dipercaya secara eksplisit; tidak memakai rejectUnauthorized=false.
- Sertifikat localhost diperbarui harian jika sisa masa berlaku kurang dari 30 hari. CA privat berlaku 10 tahun, sertifikat server 90 hari.
- SSH key untuk akun ubuntu; password SSH dan login root ditolak. Password OS awal tidak diganti.
- UFW hanya membuka TCP 22 untuk SSH.
- Zona waktu server Asia/Jakarta; database UTC. Pembaruan keamanan otomatis aktif, reboot otomatis dinonaktifkan.
- Server telah direstart setelah upgrade OS; SSH, PostgreSQL, pooler, dan timer berhasil kembali aktif.
- Aplikasi lokal berhasil terkoneksi setelah reboot; sertifikat yang tidak dipercaya ditolak.
- Pemeriksaan kesehatan setiap 15 menit mencatat status ke journal (belum ada notifikasi eksternal).

## Akses lokal

Kredensial dan private key berada pada `local-data/`, yang diabaikan Git. Folder ini berada dalam OneDrive; bukan vault terenkripsi.

- `vps-admin.key`: private SSH key. Jangan hilangkan sebelum menyiapkan akses administrator pengganti.
- `vps-hostkey.sha256`: pin host key yang disimpan pada koneksi pertama (TOFU).
- `vps-database.json`: kredensial migrasi dan runtime.
- `vps-ca.crt`: CA publik untuk verifikasi database.
- `vps-backup.json`: salinan kunci enkripsi untuk pemulihan dan konfigurasi R2. Jangan unggah file ini bersama backup.
- `env-before-vps.env`: salinan konfigurasi aplikasi sebelum beralih ke VPS.

Jalankan dari folder webapp-native untuk membuka tunnel pengembangan:

```powershell
node local-data/vps-tunnel.mjs
```

Tunnel membuka localhost:15432 untuk migrasi dan localhost:15433 untuk aplikasi. `.env.local` sudah menunjuk ke port tersebut dengan TLS terverifikasi. Tunnel harus aktif saat aplikasi lokal mengakses database. Setelah restart VPS, jalankan ulang tunnel jika terputus.

Di VPS, konfigurasi runtime tersimpan root-only pada `/etc/nota/database.env`. Saat deployment webapp, berikan hanya kredensial runtime kepada akun layanan aplikasi. Kredensial migrasi tidak perlu masuk proses aplikasi.

## Backup dan pemulihan

- Backup aplikasi menggunakan pg_dump custom format, tanpa pemilik/grant role. Tidak mencakup password role, SSH private key, atau CA private key.
- Arsip dienkripsi AES-256-GCM dan disimpan di `/var/lib/nota-backup/`.
- Jadwal harian pukul 19:00 UTC (02:00 WIB), ditambah jeda acak hingga 15 menit, retensi lokal 7 hari.
- Kunci enkripsi `/etc/nota/backup-key`, salinan pemulihan lokal pada `local-data/vps-backup.json`. Kunci wajib disimpan terpisah dari cadangan.
- Uji restore mendekripsi arsip, memeriksa checksum, memulihkan ke database sementara berawalan nota_restore_, memeriksa 22 tabel dan versi migrasi, lalu menghapus database uji.
- Pemulihan penuh ke server pengganti perlu provisioning ulang role/izin dan konfigurasi server, karena arsip tidak menyimpan keduanya.

```sh
sudo /usr/local/sbin/nota-backup --restore-test
sudo cat /var/lib/nota-backup/last-restore-test.json
sudo systemctl status nota-backup.timer
sudo journalctl -u nota-backup.service
```

Backup offsite R2 sudah diaktifkan dengan persetujuan eksplisit pengguna pada 11 September 2026. Tujuan: bucket `databasenota`, prefix `database-backups/nota/`. Hanya dump aplikasi terenkripsi yang dikirim; tidak ada password role, private key SSH/CA, atau kunci dekripsi. Retensi R2 30 hari dan lokal 7 hari. Backup dari R2 sudah diunduh, diperiksa checksum-nya, didekripsi, dan dipulihkan ke database uji; 22 tabel dan kedua migrasi cocok. Konfigurasi akses R2 ada di `/etc/nota/backup-r2.json` (root-only).

## Batas saat ini

- Webapp belum dideploy; belum ada domain dan HTTPS web publik.
- Penyelesaian backend/auth/OCR/Google Sheets serta pengujian semua peran masih diperlukan.
- Tidak ada failover/HA; aplikasi dan database satu VPS berbagi titik kegagalan.
- Pemeriksaan kesehatan lokal tidak mengirim notifikasi ke manusia; tujuan notifikasi belum ditetapkan.
- Untuk penggunaan dari Vercel nanti, rancang endpoint TLS publik dan pembatasan akses terlebih dahulu; jangan langsung membuka 5432 atau mengganti URL localhost menjadi IP publik.

## Penjadwal pekerjaan aplikasi

`vercel.json` tidak lagi mendaftarkan cron setiap menit yang ditolak Vercel Hobby. Endpoint GET `/api/internal/dispatch` sekarang memeriksa bearer `CRON_SECRET` sebelum mengakses database. Ini tidak mengaktifkan penjadwalan otomatis dengan sendirinya.

File `nota-dispatch.py`, `.service`, dan `.timer` menyiapkan penjadwal systemd satu menit. Pasang skrip sebagai `/usr/local/bin/nota-dispatch` (0755) dan kedua unit di `/etc/systemd/system/`. Setelah URL aplikasi siap, buat `/etc/nota/dispatch.json` root-only (0600) berisi `origin` dan `secret` yang sama dengan `CRON_SECRET` aplikasi. Gunakan HTTPS untuk origin jarak jauh; HTTP hanya diizinkan untuk localhost. Redirect ditolak agar bearer token tidak diteruskan ke alamat lain. Setelah uji manual unit berhasil, aktifkan timernya. Belum ada penjadwal aplikasi aktif di VPS saat catatan ini dibuat.

Endpoint dispatch masih menggunakan Workflow SDK yang ada pada proyek. Untuk deployment seluruh aplikasi di VPS, runtime workflow dan worker harus disiapkan serta diuji sesuai mode self-hosted sebelum memproses nota sungguhan. Menghapus cron Vercel tidak menyelesaikan pekerjaan tersebut.

Database VPS tetap hanya localhost; deployment Vercel tidak bisa memakai DATABASE_URL lokal/tunnel dari laptop. Untuk production Vercel diperlukan endpoint TLS yang dapat dijangkau dari Vercel. Alternatifnya deploy aplikasi dan worker di VPS, sesuai rancangan koneksi internal saat ini.
