import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

const file = process.argv[2];

if (!file) {
  console.error('Usage: node scripts/validate.mjs <src/resume.json>');
  console.error('  e.g.: node scripts/validate.mjs src/barista-resume.json');
  process.exit(1);
}

const src = resolve(rootDir, file);

console.log(`validating: ${file}`);
execSync(`npx resumed validate "${src}"`, { cwd: rootDir, stdio: 'inherit' });