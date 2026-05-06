import { execSync } from 'child_process';
import { readdirSync, mkdirSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(__dirname, '..', 'src');
const distDir = resolve(__dirname, '..', 'dist');
const rootDir = resolve(__dirname, '..');

const command = process.argv[2]; // 'render' or 'pdf'

if (!command || (command !== 'render' && command !== 'pdf')) {
  console.error('Usage: node scripts/build.mjs <render|pdf> [theme]');
  process.exit(1);
}

const themeArg = process.argv[3] ? `-t ${process.argv[3]}` : '';
mkdirSync(distDir, { recursive: true });

const files = readdirSync(srcDir).filter(f => f.endsWith('.json'));

for (const file of files) {
  const base = basename(file, '.json');
  const src = resolve(srcDir, file);
  const ext = command === 'pdf' ? 'pdf' : 'html';
  const out = resolve(distDir, `${base}.${ext}`);

  const cmd = command === 'pdf'
    ? `npx resumed export "${src}" -o "${out}" ${themeArg}`
    : `npx resumed render "${src}" -o "${out}" ${themeArg}`;

  console.log(`${command}: ${file} -> ${base}.${ext}`);
  execSync(cmd, { cwd: rootDir, stdio: 'inherit' });
}