# Verifikasi backend 11 September 2026

Status: belum siap produksi untuk seluruh fitur.

Lulus: 10 tes otomatis dan build Linux; API publik untuk CRUD Nota Listrik, Nota Umum dan History Deteksi, posting kategori tanpa duplikasi, paginasi/filter/total, kontrol listrik bulanan, serta Master Link dengan pemeriksaan versi. Browser sudah diuji untuk membuka ketiga menu, kontrol transaksi, refresh, dan pilihan jumlah baris.

Alur publik input manual akun toko juga lulus: unggah R2, finalisasi, submit ke Bank Nota, klaim review, edit dengan pemeriksaan versi, dan foto privat. Data uji telah dibersihkan.

Google Sheets: service account berhasil membaca, menulis, mengedit dan menghapus sel pada tab sementara di spreadsheet pengujian pengguna. Tab sementara dihapus dan daftar tab awal tetap utuh.

OCR: prompt dan normalisasi tetap berasal dari baseline. Gemini dari komputer lokal berhasil membaca nota sintetis Rp40.000 sampai tersimpan sebagai Pending. Namun panggilan dari VPS ditolak HTTP 400 FAILED_PRECONDITION: `User location is not supported for the API use.` Kunci lokal dan VPS telah dibandingkan dan identik. Negara yang dianggap Google belum diketahui. Indonesia dan Singapura ada di daftar wilayah resmi: https://ai.google.dev/gemini-api/docs/available-regions

Pekerja OCR VPS aktif dengan dua pekerjaan bersamaan. Kesiapan OCR publik ditandai false sampai kendala lokasi IP terselesaikan. Penyedia VPS perlu memeriksa geolokasi IP, atau pemrosesan perlu ditempatkan pada layanan di wilayah yang diterima Gemini. Respons kesalahan ditampilkan tanpa kredensial.

Pekerjaan kode yang belum selesai:
- Approval ke Spreadsheet, rekonsiliasi hasil tulis, dan pemulihan pekerjaan.
- Kontrol Data Terkirim/Tarik Data: pemetaan Mandiri dan Central Kitchen, perubahan/eliminasi/pindah tanggal dan sinkronisasi.
- Kelola cabang massal dan unduhan template Excel akun.
- Menu pemeliharaan/indeks lama dan backup manual melalui UI. Backup terjadwal VPS tetap layanan terpisah yang sudah tersedia.

PostgreSQL, R2, Better Auth, service account Google dan kunci Gemini sudah tersedia. Kekurangan implementasi tersebut tidak boleh disebut kekurangan API key.

Schema tetap `nota_app`; rilis ini tidak mengubah struktur database. Kredensial tidak masuk Git. Layanan `nota-worker.service` membaca environment privat server dan perlu direstart saat rilis diganti.
