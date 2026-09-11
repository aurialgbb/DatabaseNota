# Status setup VPS Database Nota

Diverifikasi 11 September 2026. Webapp dan database sudah berjalan di VPS. Ini belum merupakan pernyataan bahwa seluruh fitur aplikasi siap production.

## Konfigurasi

- Ubuntu 24.04, 2 vCPU, RAM sekitar 4 GB, disk sekitar 60 GB.
- PostgreSQL 16 dari repositori Ubuntu. Database `nota`, schema `nota_app`, 22 tabel dari dua migrasi.
- `nota_migrator`: pemilik database untuk perubahan schema; bukan superuser dan tidak memiliki CREATEROLE setelah provisioning.
- `nota_app_runtime`: user aplikasi dengan DML terbatas, maksimum 8 koneksi; tidak bisa mengubah struktur atau ledger migrasi. Ini belum merupakan RLS antarcabang.
- PostgreSQL localhost:5432; PgBouncer transaction pooling localhost:6432. Kedua port tidak dibuka ke internet.
- TLS wajib untuk TCP database dan pooler. CA privat dipercaya secara eksplisit; tidak memakai rejectUnauthorized=false.
- Sertifikat localhost diperbarui harian jika sisa masa berlaku kurang dari 30 hari. CA privat berlaku 10 tahun, sertifikat server 90 hari.
- SSH key untuk akun ubuntu; password SSH dan login root ditolak. Password OS awal tidak diganti.
- UFW membuka TCP 22, 80, dan 443. Port aplikasi 3000, PostgreSQL 5432, dan pooler 6432 hanya mendengarkan localhost.
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

- Webapp dideploy dengan HTTPS; admin awal dan Better Auth sudah disiapkan. OCR dan integrasi Google Sheets belum lengkap.
- Penyelesaian backend/auth/OCR/Google Sheets serta pengujian semua peran masih diperlukan.
- Tidak ada failover/HA; aplikasi dan database satu VPS berbagi titik kegagalan.
- Pemeriksaan kesehatan lokal tidak mengirim notifikasi ke manusia; tujuan notifikasi belum ditetapkan.
- Untuk penggunaan dari Vercel nanti, rancang endpoint TLS publik dan pembatasan akses terlebih dahulu; jangan langsung membuka 5432 atau mengganti URL localhost menjadi IP publik.

## Penjadwal pekerjaan aplikasi

`vercel.json` tidak lagi mendaftarkan cron setiap menit yang ditolak Vercel Hobby. Endpoint GET `/api/internal/dispatch` sekarang memeriksa bearer `CRON_SECRET` sebelum mengakses database. Ini tidak mengaktifkan penjadwalan otomatis dengan sendirinya.

File `nota-dispatch.py`, `.service`, dan `.timer` menyiapkan penjadwal systemd satu menit. Pasang skrip sebagai `/usr/local/bin/nota-dispatch` (0755) dan kedua unit di `/etc/systemd/system/`. Setelah URL aplikasi siap, buat `/etc/nota/dispatch.json` root-only (0600) berisi `origin` dan `secret` yang sama dengan `CRON_SECRET` aplikasi. Gunakan HTTPS untuk origin jarak jauh; HTTP hanya diizinkan untuk localhost. Redirect ditolak agar bearer token tidak diteruskan ke alamat lain. Setelah uji manual unit berhasil, aktifkan timernya. Belum ada penjadwal aplikasi aktif di VPS saat catatan ini dibuat.

Endpoint dispatch masih menggunakan Workflow SDK yang ada pada proyek. Untuk deployment seluruh aplikasi di VPS, runtime workflow dan worker harus disiapkan serta diuji sesuai mode self-hosted sebelum memproses nota sungguhan. Menghapus cron Vercel tidak menyelesaikan pekerjaan tersebut.

Database VPS tetap hanya localhost; deployment Vercel tidak bisa memakai DATABASE_URL lokal/tunnel dari laptop. Untuk production Vercel diperlukan endpoint TLS yang dapat dijangkau dari Vercel. Alternatifnya deploy aplikasi dan worker di VPS, sesuai rancangan koneksi internal saat ini.

## Deployment webapp pada VPS

Alamat aplikasi: https://43.173.14.17/ . Preview tampilan: https://43.173.14.17/workspace-preview.html . Preview tidak membuktikan bahwa seluruh tindakan backend telah tersedia.

- Node.js 24.21.0 dan Next.js dibangun di Linux dari commit aplikasi `427055a`. Release pertama: `/srv/nota/releases/release-20260911022257374`, dengan symlink aktif `/srv/nota/current`.
- Proses build memakai akun `nota-build`; proses aplikasi memakai akun `nota-web`, terpisah dari administrator. Kode release dimiliki root. Hanya direktori `/var/lib/nota-web` yang dapat ditulis layanan aplikasi.
- `nota-web.service` otomatis berjalan saat boot dan restart jika proses gagal. Nginx menerima HTTPS dan meneruskan ke localhost:3000.
- Environment production berada pada `/etc/nota/web.env`, mode 0600 root. Systemd memuatnya sebelum menjalankan aplikasi sebagai nota-web. Tidak ada kredensial migrasi atau private SSH key di environment aplikasi.
- Database aplikasi melalui PgBouncer localhost:6432 dengan verifikasi CA. Parameter startup `statement_timeout` diabaikan pooler; batas query 15 detik tetap ditetapkan pada role database.
- URL internal workflow dan dispatch ditolak oleh Nginx dari internet. Penjadwal dispatch belum diaktifkan karena runtime workflow production belum disiapkan. Mode workflow lokal yang tersimpan sekarang bukan jaminan ketahanan pekerjaan production.
- Sertifikat IP publik Let's Encrypt `nota-ip` menggunakan profil shortlived, sekitar 160 jam. Certbot 5.8 memeriksa pembaruan dua kali sehari melalui `nota-web-cert-renew.timer`; sesudah renewal Nginx direload. Domain sendiri belum diperlukan untuk akses HTTPS ini. Dukungan login OAuth pada alamat IP tetap perlu ditinjau terpisah saat auth diselesaikan.
- Health check turut memeriksa layanan web, koneksi database melalui API aplikasi, dan sisa masa berlaku sertifikat publik minimal 24 jam. Hasil masih hanya tercatat di journal.

`install-web-runtime.sh` adalah bootstrap awal dan mengganti konfigurasi Nginx dengan halaman sementara. Jangan jalankan ulang untuk update aplikasi rutin.

Untuk update berikutnya: arsipkan commit Git yang sudah diverifikasi tanpa file rahasia, transfer melalui SSH dengan host key terpin, periksa SHA-256, lalu ekstrak ke direktori release baru. Jalankan `npm ci` dan `npm run build` sebagai nota-build menggunakan Node dari `/opt/nodejs/current`. Setelah build berhasil, jadikan kode milik root, pindahkan cache Next ke `/var/lib/nota-web/cache/<release>`, alihkan symlink current, dan restart nota-web. Periksa HTTPS serta `databaseReady` pada `/api/setup`. Jika gagal, kembalikan symlink ke release sebelumnya dan restart. Perubahan schema memerlukan rencana kompatibilitas/rollback tersendiri. Push Git belum otomatis melakukan deployment VPS.

Pemeriksaan operator:

```sh
sudo systemctl status nota-web nginx nota-web-cert-renew.timer
sudo journalctl -u nota-web --no-pager -n 50
sudo /usr/local/sbin/nota-health
sudo /opt/nota-certbot/bin/certbot renew --cert-name nota-ip --dry-run --run-deploy-hooks --deploy-hook '/usr/sbin/nginx -t && /usr/bin/systemctl reload nginx' --no-random-sleep-on-renew
```

Build Linux berhasil. Uji publik memeriksa halaman utama dan preview (200), sesi tanpa login (401), endpoint internal dan file environment (404), redirect HTTP ke HTTPS (308), dan koneksi database aplikasi (true). Halaman login juga diperiksa di browser publik; versi awal memiliki login terkunci; pembaruan Better Auth memisahkan login dari kesiapan OCR.
Uji simulasi renewal sertifikat publik beserta deploy hook Nginx berhasil pada 11 September 2026. Health check web, database, dan backup offsite juga lulus sesudah restart aplikasi.

## Better Auth dan akun awal

Login menggunakan Better Auth 1.7.4, tanpa Firebase. Empat tabel `auth_user`, `auth_account`, `auth_session`, `auth_verification` ditambahkan melalui `003_better_auth.sql`; semuanya berada pada schema `nota_app` (total 26 tabel). Password di-hash menggunakan fungsi scrypt bawaan Better Auth. Sesi cookie HttpOnly/Secure/SameSite=Strict disimpan di database dan diperiksa ulang terhadap profil aktif.

`BETTER_AUTH_SECRET` dibuat acak dan disimpan di environment server, bukan di Git. Secret Google Sheets terpisah dari autentikasi aplikasi. Registrasi publik tidak disediakan. Endpoint Better Auth tidak dipasang langsung; API aplikasi memanggil metode server Better Auth untuk login, logout, sesi, dan penggantian password. Pembuatan akun berada di menu admin dan hanya memakai role ADMIN. Akun TOKO wajib memiliki cabang aktif.

Admin pertama dibuat satu kali dari server/tool administrator, dengan guard database yang menolak bootstrap jika admin sudah ada. Kredensial awal lokal: `local-data/LOGIN-ADMIN.txt`, diabaikan Git. Gunakan password manager untuk penyimpanan selanjutnya. Untuk instalasi baru: terapkan migrasi, grant CRUD tabel auth ke runtime, lalu jalankan `npx tsx scripts/bootstrap-admin.ts <file-json-lokal>` dengan environment database tersedia. Jangan menjalankan bootstrap melalui endpoint publik.

Pengaturan role runtime pada database nota: `search_path=nota_app,pg_catalog`. Query Better Auth juga memakai Kysely `withSchema('nota_app')`, sehingga tidak menulis ke schema aplikasi lain. Untuk VPS yang sudah dibuat, role diatur oleh administrator melalui ALTER ROLE setelah migrasi; jangan mengirim parameter startup search_path melalui transaction pooler.

Login tidak mensyaratkan Gemini/R2/Google Sheets. Menu akun mendukung daftar, pembuatan akun, edit, status aktif, serta reset password. Penonaktifan/reset/perubahan akun mencabut sesi pengguna yang bersangkutan. Perubahan password sendiri meminta password saat ini. Akun admin tidak boleh menonaktifkan dirinya sendiri atau menghapus peran admin aktif terakhir.

Daftar nota, kategori, dashboard cabang, serta pemetaan cabang/spreadsheet per periode sudah memiliki handler pembacaan PostgreSQL. Tambah/perbarui cabang dan link tersedia; ini belum menjalankan sinkronisasi Google Sheets. Menu transaksi legacy, OCR/approval, dan operasi lain yang belum dipindahkan mengembalikan pesan fitur belum tersambung tanpa mengubah data. Ini masih tahap pemeriksaan fitur, bukan kelengkapan production seluruh menu.

Uji sebelum deployment: typecheck, build, 8 tes regresi; uji integrasi langsung Better Auth untuk login, logout, penolakan password salah, batas peran TOKO, penonaktifan, reset password, dan pencabutan sesi. Dependency nanoid/undici milik runtime workflow memakai override patch keamanan; npm audit setelah pemasangan melaporkan 0 temuan yang diketahui.
