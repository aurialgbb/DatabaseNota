# Verifikasi backend 11 September 2026

Status: fungsi pengelolaan dan sinkronisasi sudah diimplementasikan; OCR publik masih tertahan penolakan lokasi oleh Gemini. Belum menyatakan seluruh aplikasi siap produksi sampai OCR dari VPS berhasil diuji.

## Hasil pemeriksaan

- 17 tes otomatis lulus, termasuk kesamaan prompt OCR dengan baseline, otorisasi, idempotensi, isolasi schema, CRUD, template akun, dan pembatasan akses relay OCR.
- API publik: login Better Auth, Nota Listrik/Umum/History, paginasi/filter/total, kontrol listrik bulanan, Master Link dengan pemeriksaan versi, unggah R2, submit manual, klaim/edit review, dan foto privat telah diuji.
- Approval publik diproses worker VPS: permintaan koreksi, penolakan, template akun XLSX, dan validasi kelola cabang massal lulus.
- Approval Mandiri dan CK: penulisan ke tab sementara, verifikasi ulang, status SQL, dan pengulangan tanpa duplikasi lulus.
- Tarik Data: edit nominal beserta total nota, eliminasi seluruh nota, pindah tanggal, reset/hapus seluruh nota, pemakaian ulang baris kosong, tambah/hapus arsip transaksi, serta penggantian/penghapusan asosiasi foto lulus.
- Simulasi koneksi terputus setelah penulisan: database tidak diperbarui sebelum hasil terverifikasi; pemulihan melanjutkan hasil tulis tanpa duplikasi.
- Pemulihan prioritas Spreadsheet: perubahan manual nominal menjadi 42.000 di tab pengujian diterapkan ke database, bukan ditimpa nominal rencana sebelumnya.
- Distribusi CK diuji dengan sumber, tujuan Mandiri, dan link pada tab sementara. Skenario gangguan lintas spreadsheet yang berbeda belum diuji menyeluruh.
- Pengujian tulis Google Sheets hanya memakai tab sementara pada spreadsheet pengujian pengguna. Interceptor menolak setiap request tulis ke sheetId lain. Fixture SQL dan tab sementara dibersihkan.

## Implementasi dan batasan

Pekerjaan approval dan sinkronisasi dijalankan oleh worker VPS, dengan rencana tersimpan dan penguncian sumber daya. Pembatalan hanya tersedia sebelum penulisan dimulai. Setelah penulisan dimulai, pekerjaan harus dipulihkan agar database dan Spreadsheet dapat diselaraskan. Konflik identitas, rumus, versi, dan kepemilikan distribusi diperiksa. Google Sheets tidak menyediakan transaksi bersama PostgreSQL; perubahan manusia pada saat yang sama tetap dapat memerlukan pemeriksaan manual.

Semua aksi UI yang ditemukan untuk pengelolaan akun/cabang, approval, dan Tarik Data sudah memiliki handler. Hook pemeliharaan Firebase lama yang tidak dipanggil UI bukan menu aktif; backup terjadwal VPS dan indeks PostgreSQL menggantikan kebutuhan tersebut. Pemeriksaan aksi tidak menggantikan pengujian setiap kombinasi data produksi.

Schema tetap `nota_app`, tanpa migrasi struktur baru pada rilis ini. Data aplikasi lama tidak dimigrasi atau diubah. Kredensial tidak masuk Git. Layanan `nota-worker.service` perlu direstart bersama aplikasi saat rilis diganti.

## OCR yang belum selesai

Prompt dan normalisasi tetap dari baseline. Kunci Gemini lokal dan VPS telah dibandingkan dan identik. Komputer lokal berhasil membaca nota sintetis Rp40.000, sedangkan VPS ditolak HTTP 400 FAILED_PRECONDITION: `User location is not supported for the API use.` Pemeriksaan IP pihak lain menunjukkan Indonesia; klasifikasi Google sendiri belum diketahui. Indonesia dan Singapura tercantum sebagai wilayah yang didukung: https://ai.google.dev/gemini-api/docs/available-regions

Relay Cloudflare telah disiapkan dengan autentikasi server, daftar model terbatas, dan endpoint Google tetap. Relay belum diaktifkan: membutuhkan token deployment Cloudflare, lalu panggilan Gemini melalui relay harus berhasil dari VPS. `OCR_REGION_BLOCKED=true` dipertahankan sampai verifikasi itu selesai. URL GAS lama tidak digunakan sebagai relay dan tidak diubah.
