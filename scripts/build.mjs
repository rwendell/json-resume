import { execSync } from 'child_process';
import { mkdirSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

const command = process.argv[2];
const file = process.argv[3];
const theme = process.argv[4];

if (!command || !file) {
  console.error('Usage: node scripts/build.mjs <render|pdf> <src/resume.json> [theme]');
  console.error('  e.g.: node scripts/build.mjs pdf src/barista-resume.json');
  console.error('  e.g.: node scripts/build.mjs render src/barista-resume.json jsonresume-theme-even');
  process.exit(1);
}

const base = basename(file, '.json');
const src = resolve(rootDir, file);
const outDir = resolve(rootDir, 'dist', base);
const ext = command === 'pdf' ? 'pdf' : 'html';
const out = resolve(outDir, `${base}.${ext}`);
const themeFlag = theme ? `-t ${theme}` : '';

mkdirSync(outDir, { recursive: true });

const cmd = command === 'pdf'
  ? `npx resumed export "${src}" -o "${out}" ${themeFlag}`
  : `npx resumed render "${src}" -o "${out}" ${themeFlag}`;

console.log(`${command}: ${file} -> dist/${base}/${base}.${ext}`);
execSync(cmd, { cwd: rootDir, stdio: 'inherit' });