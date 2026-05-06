import { execSync } from 'child_process';
import { readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(__dirname, '..', 'src');
const rootDir = resolve(__dirname, '..');

const files = readdirSync(srcDir).filter(f => f.endsWith('.json'));

for (const file of files) {
  const src = resolve(srcDir, file);
  console.log(`Validating: ${file}`);
  execSync(`npx resumed validate "${src}"`, { cwd: rootDir, stdio: 'inherit' });
}