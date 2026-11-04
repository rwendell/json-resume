#!/usr/bin/env node
/**
 * Sync GitHub repository metadata, including repos in orgs the user contributes
 * to, plus local projects under ~/projects.
 *
 * Usage:
 *   node scripts/sync-github.mjs [--user <login>] [--out data/github.json]
 *
 * Flags:
 *   --public-only   Exclude private org repositories
 *   --skip-orgs     Only sync the user's personal repositories
 *   --skip-local    Do not scan local projects
 *
 * Requires the GitHub CLI (`gh`) to be installed and authenticated.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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
  console.error(`github: ${error.message}`);
  process.exit(1);
}
const githubConfig = career.github ?? {};

const user = flag('--user', githubConfig.username || null);
const outPath = resolve(rootDir, flag('--out', 'data/github.json'));
const limit = Number(flag('--limit', '100'));
const readmeChars = Number(flag('--readme-chars', '5000'));
const publicOnly = args.includes('--public-only');
const skipOrgs = args.includes('--skip-orgs');
const skipLocal = args.includes('--skip-local');
const excluded = new Set(
  (githubConfig.exclude ?? []).map((name) => String(name).toLowerCase()),
);

const JSON_FIELDS =
  'name,nameWithOwner,owner,description,isFork,isArchived,isPrivate,primaryLanguage,repositoryTopics,pushedAt,createdAt,url,homepageUrl,stargazerCount';

function gh(args, options = {}) {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    }).trim();
  } catch (error) {
    if (error.code === 'ENOENT') {
      error.message =
        'GitHub CLI (`gh`) not found. Install it from https://cli.github.com and run `gh auth login`.';
    }
    throw error;
  }
}

function ghJson(args) {
  const output = gh(args);
  return output ? JSON.parse(output) : null;
}

if (!user) {
  console.error(
    'No GitHub username. Pass --user <login> or set github.username in data/career.yml.',
  );
  process.exit(1);
}

console.log(`github: syncing repositories for ${user}`);

let pinned = [];
try {
  const query = `
    query($login: String!) {
      user(login: $login) {
        pinnedItems(first: 6, types: REPOSITORY) {
          nodes { ... on Repository { name } }
        }
      }
    }
  `;
  const result = ghJson([
    'api',
    'graphql',
    '-f',
    `query=${query}`,
    '-f',
    `login=${user}`,
  ]);
  pinned = (result?.data?.user?.pinnedItems?.nodes ?? []).map(
    (repo) => repo.name,
  );
} catch {
  console.warn('github: could not fetch pinned repositories; continuing');
}

const personalRepos = listRepos(user).filter(
  (repo) => !repo.isFork && !repo.isArchived && !repo.isPrivate,
);

const orgs = skipOrgs ? [] : getOrgs();
const orgRepos = [];

for (const org of orgs) {
  const contributed = getContributedRepos(org, user);
  if (contributed.size === 0) continue;

  const listed = listRepos(org).filter((repo) => {
    if (repo.isFork || repo.isArchived) return false;
    if (publicOnly && repo.isPrivate) return false;
    return contributed.has(repo.nameWithOwner.toLowerCase());
  });

  if (listed.length > 0) {
    console.log(
      `github: ${org} — ${listed.length} contributed repo(s)${listed.some((repo) => repo.isPrivate) ? ' (includes private)' : ''}`,
    );
  }
  orgRepos.push(...listed);
}

const allRepos = [
  ...personalRepos.map((repo) => ({ repo, source: 'github' })),
  ...orgRepos.map((repo) => ({ repo, source: 'org' })),
];

const seen = new Set();
const synced = [];

for (const { repo, source } of allRepos) {
  const fullName = repo.nameWithOwner || `${repo.owner?.login}/${repo.name}`;
  const key = fullName.toLowerCase();
  if (seen.has(key)) continue;
  seen.add(key);

  const reasons = [];
  if (
    excluded.has(repo.name.toLowerCase()) ||
    excluded.has(fullName.toLowerCase())
  ) {
    reasons.push('excluded in data/career.yml or data/career.private.yml');
  }

  let readme = '';
  try {
    const encoded = gh([
      'api',
      `repos/${fullName}/readme`,
      '--jq',
      '.content',
    ]);
    readme = Buffer.from(encoded, 'base64').toString('utf8');
  } catch {
    reasons.push('no README');
  }

  let languages = {};
  try {
    languages = ghJson(['api', `repos/${fullName}/languages`]) ?? {};
  } catch {
    // Language metadata is optional.
  }

  readme = cleanReadme(readme).slice(0, readmeChars);

  if (!readme && !repo.description) {
    reasons.push('no README or description');
  }

  const owner = repo.owner?.login || fullName.split('/')[0];
  synced.push({
    name: repo.name,
    fullName,
    owner,
    source,
    visibility: repo.isPrivate ? 'private' : 'public',
    evidence:
      source === 'org'
        ? `github:${fullName}`
        : `github:${repo.name}`,
    url: repo.url,
    homepage: repo.homepageUrl || '',
    description: repo.description || '',
    topics: (repo.repositoryTopics ?? []).map((topic) => topic.name),
    languages: Object.entries(languages)
      .sort(([, a], [, b]) => b - a)
      .map(([name]) => name),
    stars: repo.stargazerCount ?? 0,
    pushedAt: repo.pushedAt,
    createdAt: repo.createdAt,
    pinned: source === 'github' && pinned.includes(repo.name),
    included: reasons.length === 0,
    reasons,
    readme,
  });
}

synced.sort((a, b) => {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (a.included !== b.included) return a.included ? -1 : 1;
  return String(b.pushedAt).localeCompare(String(a.pushedAt));
});

const output = {
  owner: user,
  syncedAt: new Date().toISOString(),
  orgs,
  pinned,
  repos: synced,
};

writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(
  `github: wrote ${synced.length} repos (${synced.filter((repo) => repo.included).length} eligible; ${orgRepos.length} from orgs) to ${outPath}`,
);
if (excluded.size > 0) {
  console.log(
    `github: excluded ${excluded.size} repo(s) from data/career.yml or data/career.private.yml`,
  );
}

if (!skipLocal) {
  const local = spawnSync(
    process.execPath,
    [resolve(__dirname, 'sync-local-projects.mjs')],
    { cwd: rootDir, stdio: 'inherit' },
  );
  if (local.status !== 0) {
    console.warn('github: local project sync failed; continuing');
  }
}

function listRepos(owner) {
  try {
    return ghJson([
      'repo',
      'list',
      owner,
      '--limit',
      String(limit),
      '--json',
      JSON_FIELDS,
    ]);
  } catch (error) {
    console.error(
      `github: could not list repositories for ${owner}: ${error.message}`,
    );
    return [];
  }
}

function getOrgs() {
  try {
    const output = gh([
      'api',
      'user/orgs',
      '--paginate',
      '--jq',
      '.[].login',
    ]);
    return output.split('\n').map((line) => line.trim()).filter(Boolean);
  } catch (error) {
    console.warn(`github: could not list organizations: ${error.message}`);
    return [];
  }
}

function getContributedRepos(org, login) {
  const repos = new Set();

  try {
    const output = gh([
      'api',
      '-X',
      'GET',
      'search/commits',
      '-f',
      `q=author:${login} org:${org}`,
      '--paginate',
      '--jq',
      '.items[].repository.full_name',
    ]);
    for (const name of output.split('\n')) {
      if (name.trim()) repos.add(name.trim().toLowerCase());
    }
  } catch {
    // Search can fail on permissions or rate limits; try PRs next.
  }

  try {
    const output = gh([
      'api',
      '-X',
      'GET',
      'search/issues',
      '-f',
      `q=author:${login} org:${org} type:pr`,
      '--paginate',
      '--jq',
      '.items[].repository_url',
    ]);
    for (const url of output.split('\n')) {
      const match = url.trim().match(/repos\/([^/]+\/[^/]+)$/);
      if (match) repos.add(match[1].toLowerCase());
    }
  } catch {
    // PR search is optional.
  }

  return repos;
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
