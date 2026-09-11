(function () {
  'use strict';
  const menus = {
    inputPage: ['Input Transaksi', 'Baca foto nota, lalu periksa item dan nominal sebelum menyimpan.', 'capture'],
    historyPage: ['History Deteksi', 'Temukan hasil pembacaan nota dan periksa kembali rincian transaksi.', 'records'],
    listrikPage: ['Nota Listrik', 'Lihat nota listrik yang tercatat untuk setiap cabang dan periode.', 'records'],
    umumPage: ['Nota Umum', 'Telusuri bank nota umum dalam tampilan daftar atau matriks harian.', 'records'],
    taxBankPage: ['Bank Nota', 'Bandingkan foto dengan rincian nota sebelum memberi keputusan.', 'review'],
    taxReceiptEntryPage: ['Riwayat Pengajuan', 'Lihat nota yang diajukan pada bulan terpilih dan status pemeriksaan terakhirnya.', 'review'],
    taxMasterLinksPage: ['Master Link', 'Atur tujuan spreadsheet sesuai cabang dan periode pencatatan.', 'admin'],
    taxAccountsPage: ['Kelola Akun', 'Atur akun, peran, dan akses cabang untuk pengguna aplikasi.', 'admin'],
    tokoAccountPage: ['Akun', 'Periksa profil dan kelola password akun yang sedang digunakan.', 'admin'],
    tokoDashboardPage: ['Beranda Cabang', 'Pantau nota cabang dan periksa nota yang membutuhkan koreksi.', 'records'],
    tokoUploadPage: ['Upload Nota', 'Ambil foto yang jelas, lalu periksa hasil pembacaan sebelum mengirim.', 'capture'],
    tokoHistoryPage: ['Riwayat Nota', 'Telusuri nota cabang dan lihat hasil pemeriksaannya.', 'records']
  };
  function banner(id, content) {
    const section = document.createElement('section');
    section.className = 'nota-menu-banner';
    section.dataset.kind = content[2];
    section.setAttribute('aria-label', 'Panduan ' + content[0]);
    const copy = document.createElement('div');
    const title = document.createElement('h1');
    title.textContent = content[0];
    const description = document.createElement('p');
    description.textContent = content[1];
    copy.append(title, description);
    const picture = document.createElement('img');
    picture.src = '/brand/banners/' + id + '.svg';
    picture.alt = '';
    picture.width = 190; picture.height = 90; picture.loading = 'lazy';
    section.append(copy, picture);
    return section;
  }
  function mount() {
    for (const [id, content] of Object.entries(menus)) {
      const page = document.getElementById(id);
      if (page && !page.querySelector(':scope > .nota-menu-banner')) {
        const oldTitle = page.querySelector('h1');
        if (oldTitle) {
          oldTitle.classList.add('nota-replaced-heading');
          const description = oldTitle.nextElementSibling;
          if (description?.tagName === 'P') description.classList.add('nota-replaced-heading');
        }
        page.prepend(banner(id, content));
      }
    }
  }
  document.addEventListener('DOMContentLoaded', () => {
    mount();
    let queued = false;
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; mount(); });
    }).observe(document.body, {childList:true, subtree:true});
    const gallery = document.getElementById('notaBannerGallery');
    if (gallery) for (const [id, content] of Object.entries(menus)) gallery.append(banner(id, content));
  });
})();
