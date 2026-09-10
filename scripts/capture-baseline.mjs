import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const root = path.resolve(import.meta.dirname, '..');
const source = path.resolve(root, '..', 'src');
const target = path.join(root, 'baseline');
if (fs.existsSync(path.join(target, 'manifest.json'))) throw new Error('Baseline sudah dibekukan; tidak ditimpa otomatis.');
fs.mkdirSync(target, { recursive: true });
const manifest = {};
for (const name of fs.readdirSync(source).filter(n => /\.(html|gs)$/.test(n))) {
  const bytes = fs.readFileSync(path.join(source, name));
  fs.writeFileSync(path.join(target, name), bytes);
  manifest[name] = crypto.createHash('sha256').update(bytes).digest('hex');
}
fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify({ capturedAt: new Date().toISOString(), files: manifest }, null, 2));
console.log('Baseline sumber dibekukan:', Object.keys(manifest).length, 'file.');
