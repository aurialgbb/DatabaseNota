# Template impor Excel

Rilis 3c2e37e mengganti unduhan CSV cabang dengan XLSX. Template cabang dan akun menggunakan judul biru, petunjuk pengisian, header Indonesia di baris 7, baris input mulai 8, dropdown, filter, serta header beku.

Tab Import Cabang kosong agar contoh tidak ikut diterapkan. Panduan memuat contoh Tambah/Ubah/Hapus; Referensi Cabang memuat ID dan data cabang saat file diunduh. Import Akun memuat cabang aktif dengan username/password kosong, beserta baris TAX dan ADMIN. Sel input berformat Teks untuk mempertahankan nol di depan.

Importer memilih tab Import Cabang/Import Akun berdasarkan nama, mengenali header baru dan header template lama, melewati baris kosong, mempertahankan nomor baris sumber pada error cabang, dan tetap mendukung CSV dengan koma/titik koma serta quoted fields. Semua perubahan cabang tetap melalui preview dan konfirmasi.

Audit menemukan dua input file Excel/CSV pada UI: cabang dan akun. Keduanya telah diperbarui. Upload foto bukan template spreadsheet.

Verifikasi: 20 tes lulus sebelum penyesuaian blank cell; empat tes template kembali lulus setelah penyesuaian. Typecheck dan build Linux berhasil. Workbook hasil generator dirender dan diperiksa. Uji publik membuktikan kedua unduhan merupakan XLSX yang dapat dibaca, berisi dropdown, dan preview impor cabang mengenali baris 8 dengan benar. Pengujian publik tidak menerapkan perubahan cabang atau akun. Web, worker, database, Sheets dan pemeriksaan backup sehat setelah deployment.

File dasar XLSX di assets/import-templates dibuat menggunakan Artifact Tool. Namespace XML spreadsheet dinormalisasi dari prefiks x ke default namespace untuk kompatibilitas pembaca ExcelJS server; konten dan formatting dipertahankan. ExcelJS mengisi referensi cabang terbaru dan validasi saat unduhan dibuat.
