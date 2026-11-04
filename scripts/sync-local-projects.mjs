#!/usr/bin/env node
/**
 * Discover local projects under ~/projects that are not already represented by
 * GitHub metadata. Writes data/local-projects.json.
 *
 * Usage:
 *   node scripts/sync-local-projects.mjs [--root ~/projects] [--out data/local-projects.json]
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCareer } from './lib/career.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

const args = process.argv.slice(2);
function flag(name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

let career = {};
try {
  career = loadCareer(rootDir, { optional: true }).career;
} catch (error) {
  console.error(`local: ${error.message}`);
  process.exit(1);
}
const localConfig = career.local ?? {};
const githubConfig = career.github ?? {};
const githubUser = githubConfig.username || '';

const localRoot = resolve(
  String(flag('--root', localConfig.root || join(homedir(), 'projects'))).replace(
    /^~/,
    homedir(),
  ),
);
const outPath = resolve(
  rootDir,
  flag('--out', 'data/local-projects.json'),
);
const readmeChars = Number(flag('--readme-chars', '5000'));
const maxFiles = Number(flag('--max-files', '2500'));

const exclude = new Set(
  (localConfig.exclude ?? []).map((name) => String(name).toLowerCase()),
);
const include = new Set(
  (localConfig.include ?? []).map((name) => String(name).toLowerCase()),
);

const githubPath = resolve(rootDir, 'data/github.json');
const github = existsSync(githubPath)
  ? JSON.parse(readFileSync(githubPath, 'utf8'))
  : { repos: [], orgs: [] };
const githubFullNames = new Set(
  (github.repos ?? []).map((repo) =>
    String(repo.fullName || repo.name).toLowerCase(),
  ),
);
const gitEmail = gitConfig('user.email');
const gitName = gitConfig('user.name');
const authorArgs = [
  ...new Set(
    [gitEmail, githubUser ? `${githubUser}@users.noreply.github.com` : '']
      .filter(Boolean)
      .flatMap((email) => [`--author=${email}`]),
  ),
];
if (gitName) authorArgs.push(`--author=${gitName}`);

console.log(`local: scanning ${localRoot}`);

const projects = [];
for (const entry of readdirSync(localRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  if (entry.name.startsWith('.')) continue;
  if (exclude.has(entry.name.toLowerCase())) continue;

  const fullPath = join(localRoot, entry.name);
  if (!existsSync(fullPath)) continue;
  const project = inspectProject(entry.name, fullPath);
  if (project) projects.push(project);
}

projects.sort((a, b) => {
  if (a.included !== b.included) return a.included ? -1 : 1;
  return String(b.lastCommit).localeCompare(String(a.lastCommit));
});

writeFileSync(
  outPath,
  `${JSON.stringify(
    {
      root: localRoot,
      syncedAt: new Date().toISOString(),
      projects,
    },
    null,
    2,
  )}\n`,
);

console.log(
  `local: wrote ${projects.length} project(s) (${projects.filter((project) => project.included).length} eligible) to ${outPath}`,
);

function inspectProject(name, fullPath) {
  const readme = readReadme(fullPath).slice(0, readmeChars);
  const manifest = readManifest(fullPath);
  const languages = detectLanguages(fullPath, manifest);
  const description =
    manifest.description || descriptionFromReadme(readme) || '';
  const displayName = firstHeading(readme) || manifest.name || name;
  const remote = git(fullPath, ['remote', 'get-url', 'origin']);
  const remoteFullName = parseGithubRemote(remote);
  const userCommits = git(fullPath, [
    'log',
    ...authorArgs,
    '--format=%s',
    '-10',
  ])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const userCommitCount =
    Number(
      git(fullPath, ['rev-list', '--count', ...authorArgs, 'HEAD']),
    ) || 0;
  const lastCommit =
    git(fullPath, ['log', '-1', '--format=%cI']) ||
    statSync(fullPath).mtime.toISOString();

  const reasons = [];
  if (exclude.has(name.toLowerCase())) {
    reasons.push('excluded in data/career.yml or data/career.private.yml');
  }
  if (!readme && !description && languages.length === 0) {
    reasons.push('no README or project manifest');
  }
  if (remoteFullName && githubFullNames.has(remoteFullName.toLowerCase())) {
    reasons.push('already tracked via GitHub');
  }
  if (
    remoteFullName &&
    !githubFullNames.has(remoteFullName.toLowerCase()) &&
    userCommitCount === 0 &&
    !include.has(name.toLowerCase())
  ) {
    reasons.push('upstream clone with no local commits');
  }

  const included = reasons.length === 0;

  return {
    name,
    displayName,
    source: 'local',
    evidence: `local:${name}`,
    path: fullPath,
    remote: remote || '',
    remoteFullName,
    url: remoteFullName ? `https://github.com/${remoteFullName}` : '',
    description,
    languages,
    topics: manifest.keywords,
    readme,
    localCommits: userCommits,
    userCommitCount,
    lastCommit,
    included,
    reasons,
  };
}

function readReadme(fullPath) {
  for (const name of ['README.md', 'readme.md', 'README', 'README.txt']) {
    const file = join(fullPath, name);
    if (existsSync(file) && statSync(file).isFile()) {
      return cleanReadme(readFileSync(file, 'utf8'));
    }
  }
  return '';
}

function readManifest(fullPath) {
  const result = { name: '', description: '', keywords: [], languages: [] };
  const packagePath = join(fullPath, 'package.json');
  if (existsSync(packagePath)) {
    try {
      const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
      result.name = pkg.name || '';
      result.description = pkg.description || '';
      result.keywords = Array.isArray(pkg.keywords) ? pkg.keywords : [];
      result.languages.push(
        existsSync(join(fullPath, 'tsconfig.json')) ? 'TypeScript' : 'JavaScript',
      );
    } catch {
      // Ignore malformed manifests.
    }
  }

  const manifests = [
    ['go.mod', 'Go'],
    ['Cargo.toml', 'Rust'],
    ['pyproject.toml', 'Python'],
    ['requirements.txt', 'Python'],
    ['Gemfile', 'Ruby'],
    ['pom.xml', 'Java'],
    ['build.gradle', 'Java'],
    ['build.gradle.kts', 'Kotlin'],
    ['flake.nix', 'Nix'],
    ['project.godot', 'GDScript'],
  ];
  for (const [file, language] of manifests) {
    if (existsSync(join(fullPath, file))) result.languages.push(language);
  }

  for (const entry of readdirSync(fullPath, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.csproj')) {
      result.languages.push('C#');
    }
  }

  result.languages = [...new Set(result.languages)];
  return result;
}

function detectLanguages(fullPath, manifest) {
  const counts = new Map();
  const extensions = {
    '.ts': 'TypeScript',
    '.tsx': 'TypeScript',
    '.js': 'JavaScript',
    '.jsx': 'JavaScript',
    '.svelte': 'Svelte',
    '.vue': 'Vue',
    '.go': 'Go',
    '.rs': 'Rust',
    '.py': 'Python',
    '.kt': 'Kotlin',
    '.java': 'Java',
    '.cs': 'C#',
    '.rb': 'Ruby',
    '.nix': 'Nix',
    '.gd': 'GDScript',
    '.lua': 'Lua',
    '.c': 'C',
    '.cpp': 'C++',
  };
  let files = 0;

  walk(fullPath, 0);
  function walk(dir, depth) {
    if (depth > 3 || files >= maxFiles) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files >= maxFiles) return;
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      if (entry.name === 'dist' || entry.name === 'build') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path, depth + 1);
      } else if (entry.isFile()) {
        files += 1;
        const ext = entry.name.slice(entry.name.lastIndexOf('.'));
        const language = extensions[ext.toLowerCase()];
        if (language) counts.set(language, (counts.get(language) || 0) + 1);
      }
    }
  }

  const detected = [...counts.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([language]) => language);

  return [...new Set([...manifest.languages, ...detected])];
}

function descriptionFromReadme(text) {
  const lines = text.split('\n');
  for (const line of lines) {
    const value = line.trim();
    if (!value) continue;
    if (
      value.startsWith('#') ||
      value.startsWith('<') ||
      value.startsWith('!') ||
      value.startsWith('[') ||
      value.startsWith('|') ||
      value.startsWith('```') ||
      value.startsWith('---')
    ) {
      continue;
    }
    return value
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[*_`]/g, '')
      .slice(0, 240);
  }
  return '';
}

function firstHeading(text) {
  const match = text.match(/^#\s+(.+)$/m);
  return match ? match[1].replace(/[*_`]/g, '').trim() : '';
}

function parseGithubRemote(remote) {
  const match = String(remote).match(
    /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/i,
  );
  return match ? `${match[1]}/${match[2]}` : '';
}

function git(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 5 * 1024 * 1024,
    }).trim();
  } catch {
    return '';
  }
}

function gitConfig(key) {
  try {
    return execFileSync('git', ['config', '--global', key], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function cleanReadme(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/<img[^>]*>/gi, '')
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
