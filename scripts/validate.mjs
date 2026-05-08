import { execSync } from 'child_process';
import { readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

const file = process.argv[2];

function resolveFile(f) {
  if (!f) return null;
  if (f === 'all') return 'all';
  const name = f.endsWith('.json') ? f : `${f}.json`;
  if (name.includes('/')) return name;
  return `src/${name}`;
}

if (!file) {
  console.error('Usage: node scripts/validate.mjs <resume | all>');
  console.error('  e.g.: node scripts/validate.mjs barista');
  console.error('  e.g.: node scripts/validate.mjs all');
  process.exit(1);
}

const resolved = resolveFile(file);

if (resolved === 'all') {
  const resumes = readdirSync(resolve(rootDir, 'src'))
    .filter(f => f.endsWith('.json'))
    .map(f => `src/${f}`);
  for (const r of resumes) {
    const src = resolve(rootDir, r);
    console.log(`validating: ${r}`);
    execSync(`npx resumed validate "${src}"`, { cwd: rootDir, stdio: 'inherit' });
  }
} else {
  const src = resolve(rootDir, resolved);
  console.log(`validating: ${resolved}`);
  execSync(`npx resumed validate "${src}"`, { cwd: rootDir, stdio: 'inherit' });
}