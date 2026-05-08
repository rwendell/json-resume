import { exec } from 'child_process';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

const input = process.argv[2];

if (!input) {
  console.error('Usage: node scripts/watch.mjs <resume>');
  console.error('  e.g.: node scripts/watch.mjs barista');
  process.exit(1);
}

const resolvedFile = input.includes('/') ? (input.endsWith('.json') ? input : `${input}.json`) : `src/${input.endsWith('.json') ? input : `${input}.json`}`;
const base = basename(resolvedFile, '.json');
const src = resolve(rootDir, resolvedFile);
const outDir = resolve(rootDir, 'dist', base);
const outFile = resolve(outDir, `${base}.html`);

console.log(`Watching ${resolvedFile} -> dist/${base}/${base}.html`);

import { watch } from 'fs';
watch(src, (eventType) => {
  if (eventType === 'change') {
    console.log('\nRebuilding...');
    exec(`npx resumed render "${src}" -o "${outFile}"`, { cwd: rootDir, shell: true }, (err, stdout, stderr) => {
      if (err) console.error(stderr?.trim());
      else if (stdout) console.log(stdout.trim());
    });
  }
});