# Database Nota native — dalam pengerjaan

Target: UI lama termasuk mobile, Vercel melalui Git, PostgreSQL Sumopod, Firebase Auth, R2 privat, dan OCR melalui Vercel Workflows. Data transaksi/foto lama tetap di Firebase/Drive. Tidak ada proses migrasi data lama yang dijalankan.

## Status aktual

- 35 file sumber lama dibekukan dengan checksum; UI dibangun dari sumber tersebut.
- Inventaris 74 aksi tersedia di generated/routes.json.
- Skema PostgreSQL, sesi cookie, dasar upload R2, perhitungan nota, idempotensi dan outbox telah ditulis.
- Tes lokal PostgreSQL memakai PGlite: migrasi, rollback, idempotensi, akses pekerjaan, pembatasan cabang, origin dan diskon lulus.
- API login/sesi, upload dan baca status pekerjaan terhubung.
- RPC 74 aksi belum selesai dihubungkan. Approval, sinkronisasi dua arah spreadsheet, pemulihan, pengelolaan akun/master, dan alur input lama belum lengkap.
- Worker OCR sudah ditulis tetapi belum diuji terhadap layanan cloud maupun dihubungkan sepenuhnya.
- Tampilan mobile diwarisi dari baseline; belum dilakukan pengujian browser dan perangkat.
- Belum siap digunakan operasional. Build berhasil tidak membuktikan seluruh fitur sudah berfungsi.

## Persiapan layanan

Layanan belum dibuat. Tidak perlu mengirim password atau secret lewat chat.

1. Buat PostgreSQL Sumopod dengan koneksi TLS dan alamat yang dapat diakses backend Vercel. Catat batas koneksi dan region; gunakan pool kecil.
2. Buat bucket R2 Standard privat, token terbatas bucket, dan aturan CORS untuk origin aplikasi. Foto diunggah langsung agar tidak melewati batas ukuran API.
3. Siapkan proyek Vercel dari repository privat dengan Root Directory . (folder aplikasi ini adalah root repository). Pisahkan konfigurasi preview dan production.
4. Firebase Auth tetap proyek yang disepakati. Profil/role aplikasi baru harus disiapkan di PostgreSQL; jangan menyalin transaksi atau sesi lama.
5. Siapkan spreadsheet baru sesuai template dan OAuth pemilik untuk akses Google Sheets. Daftar ID spreadsheet baru menjadi allowlist.
6. Isi variabel dari .env.example melalui pengaturan layanan atau .env.local yang tidak masuk Git. Jangan commit service account, berkas bisnis, atau direktori induk secara keseluruhan.

## Menjalankan lokal

Gunakan Node 22 atau lebih baru.

```sh
npm ci
npm run build:ui
npm test
npm run typecheck
npm run dev
```

Tes database lokal tidak membutuhkan PostgreSQL Sumopod. Login dan penyimpanan foto sungguhan membutuhkan konfigurasi layanan.

Migrasi database dijalankan terpisah dari build: npm run db:migrate. Database boleh dipakai bersama aplikasi lain: seluruh tabel, indeks dan ledger migrasi aplikasi ini berada pada schema `nota_app`. Query menggunakan nama schema secara eksplisit, termasuk saat memakai transaction pooler. Migrasi tidak memindahkan tabel lama atau mengubah schema `public` maupun schema aplikasi lain. Seluruh migrasi dalam satu transaksi dengan transaction advisory lock.

Isi `DATABASE_ADMIN_URL` di `.env.local` untuk migrasi (utamakan direct/session connection), dan `DATABASE_URL` untuk runtime. Command migrasi membaca `.env.local` otomatis. Kredensial migrasi membutuhkan izin membuat schema; akun runtime terpisah sebaiknya hanya diberi USAGE pada `nota_app`, SELECT/INSERT/UPDATE/DELETE pada tabelnya, serta USAGE/SELECT pada sequence-nya. Schema memisahkan nama tabel, tetapi hak akses tetap ditentukan oleh user database. Pembuatan role dan pemberian izin harus menyesuaikan akun Sumopod yang tersedia; belum diterapkan pada cloud.

Deployment produksi menunggu RPC lengkap, pengujian mobile, kesetaraan OCR, integrasi Sheets/R2, pengujian beban, serta verifikasi backup dan pemulihan.

## Kriteria penerimaan

Semua 74 aksi dipetakan dan diuji dengan hasil yang setara. Prompt/model OCR serta alokasi diskon/pembagian tetap dibandingkan dengan baseline. Ukuran layar 360, 390, 430, 768 piksel, keyboard, kamera, background/resume, dan perpindahan akun diperiksa. Pengujian 50 pengguna dilakukan setelah layanan tersedia; target kecepatan belum merupakan hasil pengukuran.

## Setup database bersama

Jalankan npm run db:setup dari folder aplikasi setelah DATABASE_ADMIN_URL menunjuk endpoint yang dapat dihubungi. Command ini membuat schema nota_app, menerapkan migrasi, membuat role nota_app_runtime tanpa hak DDL/admin, dan menyimpan DATABASE_URL lokal dengan password acak. Nilai rahasia tidak dicetak. DATABASE_SSL=true dipertahankan; endpoint yang menolak TLS menghentikan proses sebelum autentikasi.

Setup menolak mengambil alih role atau schema yang tidak dikenali dan membatalkan perubahan bila hak PUBLIC memungkinkan runtime mengakses aplikasi lain. Ia tidak mencabut izin global milik aplikasi lain. Bila proses terputus setelah perubahan database, berkas pemulihan lokal local-data/provisioned.env harus diperiksa sebelum mencoba ulang; skrip menolak menimpanya.

Pemeriksaan endpoint lokal pada 11 September 2026: server menolak TLS. Schema dan role cloud belum dibuat. CRON_SECRET sudah dibuat lokal. Tes provisioning lokal lulus; hasil ini bukan verifikasi layanan cloud.
