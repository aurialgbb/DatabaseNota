import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
const root = path.resolve(import.meta.dirname, '..');
const baseline = path.join(root, 'baseline');
const publicDir = path.join(root, 'public');
const runtimeDir = path.join(publicDir, 'runtime');
fs.mkdirSync(runtimeDir, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(baseline, 'manifest.json'), 'utf8'));
const sha = v => crypto.createHash('sha256').update(v).digest('hex');
const read = name => {
  const bytes = fs.readFileSync(path.join(baseline, name));
  if (sha(bytes) !== manifest.files[name]) throw new Error('Checksum baseline berubah: ' + name);
  const editable = path.join(root, 'ui', name);
  if (fs.existsSync(editable)) return fs.readFileSync(editable, 'utf8');
  return bytes.toString('utf8');
};
const nativeTransport = source => source
  .replaceAll('window.google', 'window.PortalNative')
  .replaceAll('typeof google', 'typeof PortalNative')
  .replaceAll('google.script', 'PortalNative.script')
  .replaceAll('Panggilan ke Google Apps Script gagal tanpa rincian. Muat ulang halaman dengan akun Google yang memiliki akses ke aplikasi.', 'Server belum merespons. Periksa koneksi dan status pekerjaan.')
  .replaceAll('Fungsi ini hanya tersedia dari Google Apps Script.', 'Transport aplikasi belum termuat.');
function emit(name, code) {
  const file = name + '.' + sha(code).slice(0, 12) + '.js';
  fs.writeFileSync(path.join(runtimeDir, file), code);
  return '/runtime/' + file;
}
let loader = read('runtime_loader.html').replace(/^<script>\s*/, '').replace(/<\/script>\s*$/, '');
const assignment = loader.match(/window\.__gbbRuntimeModules = (\[[^\r\n]+\]);/);
if (!assignment) throw new Error('Manifest runtime tidak ditemukan.');
const modules = JSON.parse(assignment[1]).map(module => {
  const code = nativeTransport(Buffer.from(module.code, 'base64').toString('utf8'));
  new vm.Script(code, { filename: module.name });
  return { name: module.name, group: module.group, url: emit(module.name, code) };
});
loader = loader.replace(assignment[0], 'window.__gbbRuntimeModules = ' + JSON.stringify(modules) + ';');
const start = loader.indexOf('window.__gbbLoadRuntimeGroup =');
const end = loader.indexOf('window.loadGbbVendorRuntime =', start);
if (start < 0 || end < 0) throw new Error('Loader baseline tidak dikenali.');
loader = loader.slice(0, start) + `
window.__gbbLoadRuntimeGroup = function(group) {
  if (window.__gbbRuntimeLoaded[group]) return Promise.resolve(true);
  if (window.__gbbRuntimePromises[group]) return window.__gbbRuntimePromises[group];
  return window.__gbbRuntimePromises[group] = (async function() {
    for (const module of window.__gbbRuntimeModules.filter(m => m.group === group)) {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = module.url; script.onload = resolve;
        script.onerror = () => reject(new Error('Modul gagal dimuat: ' + module.name));
        document.head.appendChild(script);
      });
    }
    window.__gbbRuntimeLoaded[group] = true;
    return true;
  })().catch(error => { delete window.__gbbRuntimePromises[group]; throw error; });
};
` + loader.slice(end);
function expand(source, stack = []) {
  return source.replace(/<\?!=\s*include_\('([^']+)'\)\s*\?>/g, (_, name) => {
    if (stack.includes(name)) throw new Error('Include melingkar.');
    if (name === 'runtime_loader') return '<script src="' + emit('loader', nativeTransport(loader)) + '"></script>';
    if (name === 'portal_js_compat') return '<script src="' + emit('portal', nativeTransport(read('portal_js.html').replace(/^<script>\s*/, '').replace(/<\/script>\s*$/, ''))) + '"></script>';
    return expand(read(name + '.html'), stack.concat(name));
  });
}
let html = expand(read('index.html'));
const buildId = 'native-' + sha(JSON.stringify(manifest.files)).slice(0, 12);
html = html.replaceAll('<?= buildId ?>', buildId);
html = html.replace('<head>', '<head>\n<script src="/native-transport.js"></script>');
html = html.replace('</head>', '<link rel="icon" href="/brand/nota-mark.svg" type="image/svg+xml"><link rel="stylesheet" href="/brand/identity.css"><link rel="stylesheet" href="/brand/workspace.css"><script src="/brand/menu-banners.js" defer></script></head>');
if (/<\?/.test(html)) throw new Error('Template GAS tersisa.');
fs.writeFileSync(path.join(publicDir, 'portal.html'), html);
// The preview uses real page markup but never loads the application or auth runtime.
const inert = value => value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/\s+on[\w]+\s*=\s*(?:"[^"]*"|'[^']*')/gi, '');
const previewHead = inert(html.match(/<head>([\s\S]*?)<\/head>/)[1]);
const previewShell = inert(html.match(/<aside id="sidebar"[\s\S]*?<\/main>/)[0]);
fs.writeFileSync(path.join(publicDir, 'workspace-preview.html'), `<!doctype html><html lang="id"><head>${previewHead}<link rel="stylesheet" href="/brand/workspace-preview.css"><script src="/brand/workspace-preview.js" defer></script><script src="/brand/menu-banners.js" defer></script></head><body class="portal-ui-v3 portal-authenticated nota-preview"><header class="nota-preview-bar"><strong>Pratinjau UI</strong><span>Data dan aksi simpan tidak aktif.</span><label for="previewPage">Menu</label><select id="previewPage"></select><a href="/">Login</a></header>${previewShell}</body></html>`);
fs.writeFileSync(path.join(publicDir, 'baseline-manifest.json'), JSON.stringify({ buildId, files: manifest.files }));
console.log('UI statis:', buildId, 'runtime modules:', modules.length);
