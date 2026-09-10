(() => {
  const select = document.getElementById('previewPage');
  const buttons = [...document.querySelectorAll('#sidebar [data-page]')];
  const pages = [...document.querySelectorAll('.page-section')];
  const localButtons = new Set();
  const notice = document.createElement('dialog');
  notice.className = 'nota-preview-notice';
  const noticeTitle = document.createElement('h2');
  noticeTitle.textContent = 'Aksi belum tersedia di preview';
  const noticeCopy = document.createElement('p');
  const closeNotice = document.createElement('button');
  closeNotice.textContent = 'Mengerti';
  closeNotice.type = 'button';
  closeNotice.addEventListener('click', () => notice.close());
  notice.append(noticeTitle, noticeCopy, closeNotice);
  document.body.append(notice);
  localButtons.add(closeNotice);
  document.querySelectorAll('button').forEach(button => {
    button.disabled = false;
    button.addEventListener('click', () => {
      if (localButtons.has(button)) return;
      const label = button.getAttribute('aria-label') || button.textContent.trim() || button.title || 'Aksi ini';
      noticeCopy.textContent = label + ' membutuhkan layanan aplikasi yang belum terhubung di preview ini. Tidak ada data yang disimpan atau diubah.';
      notice.showModal();
    });
  });
  document.querySelectorAll('input[type="file"],input[type="submit"]').forEach(input => { input.disabled = true; });
  document.querySelectorAll('form').forEach(form => form.addEventListener('submit', event => event.preventDefault()));
  const textNodes = document.createTreeWalker(document.getElementById('mainContent'), NodeFilter.SHOW_TEXT);
  while (textNodes.nextNode()) {
    const node = textNodes.currentNode;
    if (!['STYLE','SCRIPT'].includes(node.parentElement.tagName) && /^Memuat[^\n]*\.{3}$/.test(node.textContent.trim())) node.textContent = 'Data tidak dimuat dalam preview.';
  }
  const seen = new Set();
  buttons.forEach(button => {
    const id = button.dataset.page;
    if (seen.has(id)) { button.remove(); return; }
    seen.add(id);
    button.classList.remove('portal-hidden', 'hidden');
    button.disabled = false;
    localButtons.add(button);
    select.add(new Option(button.textContent.trim(), id));
    button.addEventListener('click', () => show(id));
  });
  function show(id) {
    if (!seen.has(id)) id = 'inputPage';
    pages.forEach(page => { page.classList.toggle('hidden', page.id !== id); page.classList.toggle('portal-hidden', page.id !== id); });
    buttons.forEach(button => { button.classList.toggle('active-page', button.dataset.page === id); if (button.dataset.page === id) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
    select.value = id;
    const menuTrigger = document.getElementById('previewPage');
    if (menuTrigger?.tagName === 'BUTTON') menuTrigger.textContent = select.selectedOptions[0]?.textContent || id;
    document.getElementById('mainContent').scrollTop = 0;
    history.replaceState(null, '', '#' + id);
  }
  select.addEventListener('change', () => show(select.value));
  [['btnTabTarik','tabInputTarik'],['btnTabUpload','tabInputUpload']].forEach(([buttonId, panelId]) => {
    const button = document.getElementById(buttonId);
    button.disabled = false;
    localButtons.add(button);
    button.addEventListener('click', () => {
      ['tabInputTarik','tabInputUpload'].forEach(id => document.getElementById(id).classList.toggle('hidden', id !== panelId));
      ['btnTabTarik','btnTabUpload'].forEach(id => document.getElementById(id).setAttribute('aria-pressed', String(id === buttonId)));
    });
  });
  const electricityTabs = [['btnTabDetail','tabListrikDetail'],['btnTabKontrol','tabListrikKontrol']];
  electricityTabs.forEach(([buttonId, panelId], index) => {
    const button = document.getElementById(buttonId);
    localButtons.add(button);
    button.addEventListener('click', () => {
      electricityTabs.forEach(([id, panel]) => {
        document.getElementById(panel).classList.toggle('hidden', panel !== panelId);
        document.getElementById(id).setAttribute('aria-pressed', String(id === buttonId));
      });
      document.getElementById('listrikSlideBg').style.transform = `translateX(${index * 100}%)`;
    });
  });
  function nativeSelect(id, items, label) {
    const original = document.getElementById(id);
    if (!original) return;
    const input = document.createElement('select');
    input.id = id;
    input.className = original.className;
    input.setAttribute('aria-label', label);
    items.forEach(value => input.add(new Option(value, value)));
    original.replaceWith(input);
    return input;
  }
  const type = nativeSelect('btnTarikTipe', ['Central Kitchen','Cabang'], 'Tipe data');
  type?.addEventListener('change', () => {
    document.getElementById('tarikCKContainer')?.classList.toggle('hidden', type.value !== 'Central Kitchen');
    document.getElementById('tarikCabangContainer')?.classList.toggle('hidden', type.value === 'Central Kitchen');
  });
  nativeSelect('btnTarikBulan', ['Pilih Bulan', ...Array.from({length:12}, (_, i) => new Intl.DateTimeFormat('id', {month:'long'}).format(new Date(2026,i,1)))], 'Bulan');
  nativeSelect('btnTarikTahun', ['Pilih Tahun', ...Array.from({length:6}, (_, i) => String(new Date().getFullYear() - i))], 'Tahun');
  document.querySelectorAll('input[data-portal-date],#dateInput').forEach(input => { input.type = 'date'; input.readOnly = false; });
  const navigation = document.querySelector('#sidebar nav');
  for (const [role, label] of [['TAX','Tax · Transaksi'],['ADMIN','Administrator'],['STORE','Cabang']]) {
    const heading = document.createElement('p');
    heading.className = 'nota-preview-nav-heading';
    heading.textContent = label;
    navigation.append(heading);
    buttons.filter(button => button.isConnected && button.dataset.portalRole === role).forEach(button => navigation.append(button));
  }
  document.querySelectorAll('.legacy-limit-trigger').forEach(trigger => {
    const menu = document.getElementById(trigger.getAttribute('aria-controls'));
    const values = trigger.id === 'yearDropdownBtn'
      ? Array.from({length:6}, (_, i) => String(new Date().getFullYear() - i))
      : [...(menu?.querySelectorAll('[role="option"]') || [])].map(option => option.textContent.trim());
    if (!values.length) return;
    const replacement = nativeSelect(trigger.id, values, trigger.id === 'yearDropdownBtn' ? 'Tahun kontrol transaksi' : 'Baris per halaman');
    const current = trigger.querySelector('span')?.textContent.trim();
    if (values.includes(current)) replacement.value = current;
    menu?.remove();
  });
  let closeDropdown = () => {};
  document.querySelectorAll('select').forEach((source, index) => {
    const id = source.id || 'previewSelect' + index;
    const trigger = document.createElement('button');
    trigger.type = 'button'; trigger.className = 'nota-select-trigger'; trigger.id = id;
    trigger.setAttribute('role', 'combobox'); trigger.setAttribute('aria-haspopup', 'listbox'); trigger.setAttribute('aria-expanded', 'false');
    const label = source.getAttribute('aria-label') || source.labels?.[0]?.textContent.trim() || source.closest('label')?.querySelector('span')?.textContent || 'Pilih opsi';
    trigger.setAttribute('aria-label', label);
    source.id = id + 'Native'; source.hidden = true; source.style.display = 'none';
    source.after(trigger); localButtons.add(trigger);
    const menu = document.createElement('div'); menu.className = 'nota-select-menu'; menu.id = id + 'Options'; menu.hidden = true;
    menu.setAttribute('role', 'listbox'); menu.setAttribute('aria-label', label);
    trigger.setAttribute('aria-controls', menu.id); document.body.append(menu);
    function sync() { trigger.textContent = source.selectedOptions[0]?.textContent || 'Pilih opsi'; }
    sync(); source.addEventListener('change', sync);
    const close = () => { menu.hidden = true; trigger.setAttribute('aria-expanded','false'); };
    function open() {
      closeDropdown(); closeDropdown = close;
      menu.replaceChildren();
      [...source.options].forEach(option => {
        const item = document.createElement('button'); item.type = 'button'; item.textContent = option.textContent;
        item.setAttribute('role','option'); item.setAttribute('aria-selected',String(option.selected)); item.disabled = option.disabled;
        item.addEventListener('click', () => { source.value = option.value; source.dispatchEvent(new Event('change', {bubbles:true})); close(); trigger.focus(); });
        menu.append(item);
      });
      const rect = trigger.getBoundingClientRect(); menu.hidden = false;
      menu.style.width = Math.min(Math.max(rect.width,180), innerWidth - 24) + 'px';
      menu.style.left = Math.max(12, Math.min(rect.left, innerWidth - menu.offsetWidth - 12)) + 'px';
      menu.style.top = Math.max(12, Math.min(rect.bottom + 6, innerHeight - menu.offsetHeight - 12)) + 'px';
      trigger.setAttribute('aria-expanded','true');
      (menu.querySelector('[aria-selected="true"]') || menu.firstElementChild)?.focus();
    }
    trigger.addEventListener('click', () => menu.hidden ? open() : close());
    trigger.addEventListener('keydown', event => { if (['ArrowDown','ArrowUp'].includes(event.key)) { event.preventDefault(); open(); } });
    menu.addEventListener('keydown', event => {
      const items = [...menu.querySelectorAll('button:not(:disabled)')]; const current = items.indexOf(document.activeElement);
      if (event.key === 'Escape' || event.key === 'Tab') { close(); if(event.key === 'Escape') { event.preventDefault(); trigger.focus(); } }
      if (['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
        event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }
    });
    document.addEventListener('pointerdown', event => { if (!menu.contains(event.target) && !trigger.contains(event.target)) close(); });
  });
  document.getElementById('mainContent').addEventListener('scroll', () => closeDropdown(), {passive:true});
  window.addEventListener('resize', () => closeDropdown());
  document.querySelectorAll('[id$="PaginationControls"],#paginationControls,.portal-pagination').forEach(container => {
    if (container.children.length) return;
    const message = document.createElement('span'); message.textContent = 'Belum ada halaman · data belum terhubung';
    message.className = 'nota-preview-page-status'; container.append(message);
  });
  document.querySelectorAll('#mainContent tbody').forEach(body => {
    if (body.children.length) return;
    const row = body.insertRow(); const cell = row.insertCell();
    cell.colSpan = body.closest('table').querySelector('thead tr:last-child')?.children.length || 1;
    cell.textContent = 'Data belum terhubung di preview.';
    cell.style.cssText = 'padding:28px 16px;text-align:left;color:#657186;font-size:12px';
  });
  window.addEventListener('hashchange', () => show(location.hash.slice(1)));
  show(location.hash.slice(1));
})();
