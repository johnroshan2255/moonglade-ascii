// Packages dist/ for itch.io: index.html at the zip root, relative paths, license notices.
// Usage: npm run itch   ->  release/hollow-wick-web.zip
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dist = path.join(root, 'dist');
const out = path.join(root, 'release');
if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error('dist/index.html missing: run vite build first');

// third-party notices (PlayCanvas is MIT and asks for its notice to ship with copies)
const pcLicense = fs.readFileSync(path.join(root, 'node_modules/playcanvas/LICENSE'), 'utf8');
fs.writeFileSync(path.join(dist, 'THIRD-PARTY-LICENSES.txt'),
  `Hollow Wick uses the PlayCanvas engine (https://github.com/playcanvas/engine)\n\n${pcLicense}\n`);

// sanity: every asset path in index.html must be relative (itch serves from a sub-path)
const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
const absolute = [...html.matchAll(/(?:src|href)="(\/[^"]*)"/g)].map((m) => m[1]);
if (absolute.length) throw new Error(`absolute paths in index.html: ${absolute.join(', ')}`);

fs.mkdirSync(out, { recursive: true });
const zip = path.join(out, 'hollow-wick-web.zip');
if (fs.existsSync(zip)) fs.unlinkSync(zip);
execFileSync('zip', ['-r', '-X', '-9', zip, '.', '-x', '.DS_Store', '*/.DS_Store'], { cwd: dist, stdio: 'inherit' });

let total = 0;
const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); const s = fs.statSync(p); if (s.isDirectory()) walk(p); else total += s.size; } };
walk(dist);
console.log(`\n${zip}\n  zip: ${(fs.statSync(zip).size / 1024).toFixed(0)} KB   unpacked: ${(total / 1024).toFixed(0)} KB`);
