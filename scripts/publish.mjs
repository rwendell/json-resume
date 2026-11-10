#!/usr/bin/env node
/**
 * Publish a generated JSON Resume into src/ and rebuild the site.
 *
 * Usage:
 *   aube run publish -- /path/to/resume.json
 *   aube run publish -- resume.json --name acme-data-engineer
 *   aube run publish -- /path/to/resume.pdf
 *   aube run publish -- resume.json --dry-run
 *   aube run publish -- resume.json --no-build
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

const options = parseArgs(process.argv.slice(2));
if (!options.input) {
  fail(
    'Usage: aube run publish -- <resume.json|resume.pdf> [--name <name>] [--dry-run] [--no-build]',
  );
}

const inputPath = resolveInput(options.input);
const resume = readResume(inputPath);
const slug =
  slugify(options.name || resume.basics?.label || basename(inputPath, '.json')) ||
  'resume';
const target = resolve(rootDir, 'src', `${slug}.json`);

console.log(`publish: ${inputPath}`);
console.log(`publish: target src/${slug}.json`);
if (options.dryRun) {
  console.log('publish: dry run; no files written');
  process.exit(0);
}

validate(inputPath);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(resume, null, '\t')}\n`);
console.log(`publish: wrote ${target}`);

if (options.build) {
  const result = spawnSync('aube', ['run', 'build'], {
    cwd: rootDir,
    stdio: 'inherit',
  });
  if (result.status !== 0) fail('Build failed.');
}

console.log('');
console.log('Next:');
console.log(`  git add src/${slug}.json`);
console.log(`  git commit -m "Publish ${slug} resume"`);
console.log('  git push');

function parseArgs(argv) {
  const parsed = { build: true, dryRun: false };
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--name':
        parsed.name = argv[++index];
        break;
      case '--dry-run':
        parsed.dryRun = true;
        break;
      case '--no-build':
        parsed.build = false;
        break;
      case '--help':
      case '-h':
        parsed.help = true;
        break;
      default:
        if (arg.startsWith('-')) fail(`Unknown option: ${arg}`);
        positionals.push(arg);
    }
  }
  if (parsed.help) {
    console.log(
      'Usage: aube run publish -- <resume.json|resume.pdf> [--name <name>] [--dry-run] [--no-build]',
    );
    process.exit(0);
  }
  parsed.input = positionals[0];
  return parsed;
}

function resolveInput(value) {
  const expanded = expandHome(value);
  const direct = resolve(process.cwd(), expanded);
  if (existsSync(direct)) {
    return direct.toLowerCase().endsWith('.pdf')
      ? direct.replace(/\.pdf$/i, '.json')
      : direct;
  }

  const slug = slugify(value.replace(/\.(json|pdf)$/i, ''));
  for (const candidate of [
    resolve(process.cwd(), `resume-${slug}.json`),
    resolve(process.cwd(), `${value}.json`),
  ]) {
    if (existsSync(candidate)) return candidate;
  }

  fail(`Resume not found: ${value}`);
}

function readResume(path) {
  if (!existsSync(path)) fail(`Resume not found: ${path}`);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`Could not parse ${path}: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(`${path} must contain a JSON Resume object.`);
  }
  return parsed;
}

function validate(path) {
  const result = spawnSync(
    'aube',
    ['exec', '--no-install', '--', 'resumed', 'validate', path],
    { cwd: rootDir, stdio: 'inherit' },
  );
  if (result.error || result.status !== 0) {
    fail('JSON Resume validation failed.');
  }
}

function expandHome(value) {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return resolve(homedir(), value.slice(2));
  return value;
}

function slugify(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70);
}

function fail(message) {
  console.error(`publish: ${message}`);
  process.exit(1);
}
