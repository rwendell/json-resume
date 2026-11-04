#!/usr/bin/env node
/**
 * Pull the private career PII overlay from a secret GitHub gist.
 *
 * Usage:
 *   aube run pull-private
 *   aube run pull-private -- --gist <id|url>
 *
 * Resolution order:
 *   1. --gist
 *   2. CAREER_PRIVATE_GIST_ID
 *   3. the newest secret gist containing career.private.yml
 *
 * The file is written to data/career.private.yml, which is gitignored.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { loadCareer } from './lib/career.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const options = parseArgs(process.argv.slice(2));

if (options.help) {
  printHelp();
  process.exit(0);
}

const fileName = options.file || 'career.private.yml';
const outputPath = resolve(rootDir, 'data', 'career.private.yml');

let gist;
try {
  gist = resolveGist({
    requested: options.gist,
    fileName,
    allowPublic: options.allowPublic,
  });
} catch (error) {
  fail(error.message);
}

let content;
try {
  content = execFileSync(
    'gh',
    ['gist', 'view', gist.id, '--filename', fileName, '--raw'],
    { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
  );
} catch (error) {
  fail(formatGhError(`Could not read ${fileName} from gist ${gist.id}`, error));
}

content = `${content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trimEnd()}\n`;

const parsed = parseYaml(content);
if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
  fail(`${fileName} is not a YAML object.`);
}
if (!parsed.basics || typeof parsed.basics !== 'object') {
  fail(`${fileName} does not contain a basics object.`);
}
if (
  !['name', 'email', 'phone', 'location'].some(
    (key) => parsed.basics[key] != null,
  )
) {
  fail(`${fileName} does not look like the private PII overlay.`);
}

const existing = existsSync(outputPath)
  ? readFileSync(outputPath, 'utf8')
  : null;

if (existing === content) {
  console.log(
    `pull-private: already up to date (${gist.public ? 'public' : 'secret'} gist)`,
  );
  reportMerge();
  process.exit(0);
}

if (existing) {
  const backupDir = resolve(rootDir, '.cache', 'pull-private');
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = join(backupDir, `career.private-${stamp}.yml`);
  writeFileSync(backupPath, existing);
  console.log(`pull-private: backed up the previous file to ${backupPath}`);
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, content);
console.log(
  `pull-private: wrote ${outputPath} (${gist.public ? 'public' : 'secret'} gist)`,
);
reportMerge();

function resolveGist({ requested, fileName: target, allowPublic }) {
  if (requested) {
    return loadGist(parseGistId(requested), target, allowPublic);
  }

  const envId = process.env.CAREER_PRIVATE_GIST_ID;
  if (envId) {
    return loadGist(parseGistId(envId), target, allowPublic);
  }

  const gists = listGists();
  const matches = gists.filter((item) => item.files?.[target]);
  const secretMatches = allowPublic
    ? matches
    : matches.filter((item) => item.public === false);

  if (secretMatches.length === 0) {
    if (matches.length > 0) {
      throw new Error(
        `Only public gist(s) contain ${target}. Refusing to pull PII from a public gist; pass --allow-public only if you accept that risk.`,
      );
    }
    throw new Error(
      `No gist containing ${target} was found. Pass --gist <id|url>, set CAREER_PRIVATE_GIST_ID, or create one with "gh gist create data/career.private.yml".`,
    );
  }

  secretMatches.sort(
    (a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at),
  );
  if (secretMatches.length > 1) {
    throw new Error(
      `Multiple secret gists contain ${target}. Run "gh gist list" or pass --gist to choose one.`,
    );
  }

  return loadGist(secretMatches[0].id, target, allowPublic);
}

function loadGist(id, target, allowPublic) {
  const gist = fetchGist(id);
  if (gist.public && !allowPublic) {
    throw new Error(
      `Gist ${id} is public. Refusing to pull PII from a public gist; pass --allow-public only if you accept that risk.`,
    );
  }
  if (!gist.files?.[target]) {
    const available = Object.keys(gist.files ?? {});
    throw new Error(
      `Gist ${id} does not contain ${target}. Available file(s): ${available.join(', ') || '(none)'}.`,
    );
  }
  return { id, public: gist.public === true };
}

function listGists() {
  let raw;
  try {
    raw = execFileSync(
      'gh',
      ['api', 'gists?per_page=100', '--paginate'],
      { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 },
    );
  } catch (error) {
    throw new Error(formatGhError('Could not list gists', error));
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Could not parse the gist list: ${error.message}`);
  }
  if (!Array.isArray(data)) {
    throw new Error('GitHub returned an unexpected gist list.');
  }
  return data;
}

function fetchGist(id) {
  let raw;
  try {
    raw = execFileSync('gh', ['api', `gists/${id}`], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(formatGhError(`Could not read gist ${id}`, error));
  }

  try {
    const gist = JSON.parse(raw);
    if (!gist?.id) throw new Error('missing id');
    return gist;
  } catch (error) {
    throw new Error(`Could not parse gist ${id}: ${error.message}`);
  }
}

function parseGistId(value) {
  const text = String(value ?? '').trim();
  const urlMatch = text.match(
    /gist\.github\.com\/(?:[^/]+\/)?([a-f0-9]+)/i,
  );
  if (urlMatch) return urlMatch[1];
  if (/^[a-f0-9]+$/i.test(text)) return text;
  throw new Error(`Invalid gist id or URL: ${text || '(empty)'}`);
}

function formatGhError(prefix, error) {
  if (error?.code === 'ENOENT') {
    return `${prefix}: the gh CLI was not found. Install GitHub CLI and run "gh auth login".`;
  }
  const stderr = error?.stderr ? String(error.stderr).trim() : '';
  return `${prefix}: ${stderr || error?.message || String(error)}`;
}

function reportMerge() {
  try {
    const { career } = loadCareer(rootDir);
    const achievements = (career.roles ?? []).reduce(
      (sum, role) => sum + (role.achievements?.length ?? 0),
      0,
    );
    console.log(
      `pull-private: merged ${career.roles?.length ?? 0} role(s), ${achievements} achievement(s)`,
    );
  } catch (error) {
    fail(`Pulled the file, but the merged career failed to load: ${error.message}`);
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--help':
      case '-h':
        parsed.help = true;
        break;
      case '--gist': {
        const value = argv[++i];
        if (!value) fail('Provide a gist id or URL with --gist.');
        parsed.gist = value;
        break;
      }
      case '--file': {
        const value = argv[++i];
        if (!value) fail('Provide a filename with --file.');
        parsed.file = value;
        break;
      }
      case '--allow-public':
        parsed.allowPublic = true;
        break;
      default:
        fail(`Unknown option: ${arg}. Run with --help for usage.`);
    }
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage:
  aube run pull-private
  aube run pull-private -- --gist <id|url>

Options:
  --gist <id|url>   Gist to pull (default: CAREER_PRIVATE_GIST_ID or auto-discover)
  --file <name>     Gist filename (default: career.private.yml)
  --allow-public    Permit a public gist; not recommended for PII
  --help            Show this help

The file is written to data/career.private.yml, which is gitignored. A changed
local file is backed up under .cache/pull-private/.
`);
}

function fail(message) {
  console.error(`pull-private: ${message}`);
  process.exit(1);
}
