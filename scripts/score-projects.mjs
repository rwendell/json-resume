#!/usr/bin/env node
/**
 * Explain how project candidates are scored for a job or the generic resume.
 *
 * Usage:
 *   aube run score-projects -- --generic
 *   aube run score-projects -- job.md
 *   aube run score-projects -- --title "Go Platform Engineer" --description job.txt
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { readJobInput } from './lib/job-input.mjs';
import {
  loadGithub,
  loadLocal,
  rankProjects,
} from './lib/github-projects.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const SELECT_LIMIT = 12;

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  printHelp();
  process.exit(0);
}

const careerPath = resolve(rootDir, 'data/career.yml');
const career = parseYaml(readFileSync(careerPath, 'utf8'));

const job = await resolveJob(options);
if (!job.body && !job.title) {
  console.error('score-projects: provide a job description/title or use --generic.');
  process.exit(1);
}

const github = loadGithub(resolve(rootDir, 'data/github.json'));
const local = loadLocal(resolve(rootDir, 'data/local-projects.json'));
if (!github && !local) {
  console.error(
    'score-projects: no project metadata found. Run `aube run sync-github` first.',
  );
  process.exit(1);
}

const { tokens, scored, selected } = rankProjects(
  github,
  local,
  career,
  job,
  SELECT_LIMIT,
);
const selectedNames = new Set(selected.map((candidate) => candidate.name));
const limit = options.all ? scored.length : options.limit;
const visible = scored.slice(0, limit);

if (options.json) {
  console.log(
    JSON.stringify(
      {
        job: {
          title: job.title,
          company: job.company || '',
          source: job.source || 'job',
        },
        tokens,
        selectionLimit: SELECT_LIMIT,
        selected: [...selectedNames],
        candidates: scored.map((entry, index) => ({
          rank: index + 1,
          name: entry.repo.name,
          evidence: entry.repo.evidence,
          source: entry.repo.source,
          score: entry.score,
          baseScore: entry.baseScore,
          pinned: entry.pinned,
          matched: entry.matched,
          selected: selectedNames.has(entry.repo.name),
        })),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

console.log(
  `score-projects: ${job.title}${job.company ? ` at ${job.company}` : ''}${job.source === 'generic' ? ' (generic)' : ''}`,
);
console.log(`tokens: ${tokens.join(', ')}`);
console.log(
  'rank\tscore\tbase\tpin\tsource\tproject\tevidence\tmatched',
);

visible.forEach((entry, index) => {
  console.log(
    [
      index + 1,
      entry.score,
      entry.baseScore,
      entry.pinned ? 'yes' : 'no',
      entry.repo.source,
      entry.repo.name,
      entry.repo.evidence,
      entry.matched.join(', ') || '-',
    ].join('\t'),
  );
});

console.log(`selected: ${[...selectedNames].join(', ') || '(none)'}`);

async function resolveJob(opts) {
  if (opts.generic) {
    const generic = career.generic ?? {};
    return {
      title: opts.title || generic.title || 'Software Engineer',
      company: opts.company || '',
      url: opts.url || '',
      body:
        opts.description ||
        generic.description ||
        'General-purpose software engineering resume.',
      source: 'generic',
    };
  }

  if (!opts.input && !opts.description && !opts.title) {
    console.error('score-projects: provide a job file/URL, --description, or --generic.');
    process.exit(1);
  }

  return readJobInput(opts);
}

function parseArgs(argv) {
  const parsed = { limit: 20, all: false, json: false, generic: false };
  const positionals = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--help':
      case '-h':
        parsed.help = true;
        break;
      case '--generic':
        parsed.generic = true;
        break;
      case '--json':
        parsed.json = true;
        break;
      case '--all':
        parsed.all = true;
        break;
      case '--limit':
        parsed.limit = Number(argv[++i]);
        break;
      case '--title':
        parsed.title = argv[++i];
        break;
      case '--company':
        parsed.company = argv[++i];
        break;
      case '--url':
        parsed.url = argv[++i];
        break;
      case '--description':
        parsed.description = argv[++i];
        break;
      default:
        if (arg.startsWith('-')) {
          console.error(`score-projects: unknown option ${arg}`);
          process.exit(1);
        }
        positionals.push(arg);
    }
  }

  parsed.input = positionals[0];
  return parsed;
}

function printHelp() {
  console.log(`Usage:
  aube run score-projects -- --generic
  aube run score-projects -- <job-url | job-file>
  aube run score-projects -- --title "<title>" --description <file|text>

Options:
  --generic              Score against data/career.yml generic criteria
  --title <text>         Job title
  --company <text>       Company
  --description <value>  Job description text, file, or URL
  --limit <n>            Rows to display (default 20)
  --all                  Display every candidate
  --json                 Emit machine-readable JSON
  --help, -h             Show this help

Score = number of distinct job-description tokens found in the project name,
description, topics, languages, local commits, and README. Pinned repos only
break ties; they do not add points. The top ${SELECT_LIMIT} are passed to the
resume model; the model chooses among them.`);
}
