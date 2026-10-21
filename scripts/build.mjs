import { execSync } from 'child_process';
import { mkdirSync, readdirSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

const command = process.argv[2];
const file = process.argv[3];
const theme = process.argv[4];

if (!command) {
  console.error('Usage: node scripts/build.mjs <render|pdf|render-all|pdf-all|build-all> [resume] [theme]');
  console.error('  e.g.: node scripts/build.mjs pdf barista');
  console.error('  e.g.: node scripts/build.mjs render barista jsonresume-theme-even');
  console.error('  e.g.: node scripts/build.mjs build-all');
  process.exit(1);
}

function resolveFile(file) {
  const name = file.endsWith('.json') ? file : `${file}.json`;
  if (name.includes('/')) return name;
  return `src/${name}`;
}

function buildOne(cmd, file, theme) {
  const base = basename(file, '.json');
  const src = resolve(rootDir, file);
  const outDir = resolve(rootDir, 'dist', base);
  const ext = cmd === 'pdf' ? 'pdf' : 'html';
  const out = resolve(outDir, `${base}.${ext}`);
  const themeFlag = theme ? `-t ${theme}` : '';

  mkdirSync(outDir, { recursive: true });

  const shell = cmd === 'pdf'
    ? `npx resumed export "${src}" -o "${out}" ${themeFlag} --puppeteer-arg=--no-sandbox`
    : `npx resumed render "${src}" -o "${out}" ${themeFlag}`;

  console.log(`${cmd}: ${file} -> dist/${base}/${base}.${ext}`);
  execSync(shell, { cwd: rootDir, stdio: 'inherit' });
}

function getAllResumes() {
  return readdirSync(resolve(rootDir, 'src'))
    .filter(f => f.endsWith('.json'))
    .map(f => `src/${f}`);
}

if (command.endsWith('-all')) {
  const cmd = command.replace('-all', '') || 'render';
  const resumes = getAllResumes();
  for (const r of resumes) {
    if (cmd === 'pdf' || command === 'build-all') buildOne('pdf', r, theme);
    if (cmd === 'render' || command === 'build-all') buildOne('render', r, theme);
  }
} else {
  if (!file) {
    console.error('Usage: node scripts/build.mjs <render|pdf> <resume> [theme]');
    process.exit(1);
  }
  buildOne(command, resolveFile(file), theme);
}
