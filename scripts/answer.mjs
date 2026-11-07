#!/usr/bin/env node
/**
 * Answer an application or interview question using the same sources as a
 * tailored resume: the career fact bank, GitHub candidates, and the generated
 * resume/trace when one exists.
 *
 * Usage:
 *   aube run answer -- https://example.com/job --question "Why this role?"
 *   aube run answer -- acme-forward-deployed-engineer --question "..."
 *   aube run answer -- job.md --question question.txt
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify as stringifyYaml } from 'yaml';
import { loadCareer } from './lib/career.mjs';
import {
  formatJobMarkdown,
  readJobInput,
  slugify,
} from './lib/job-input.mjs';
import {
  loadGithub,
  loadLocal,
  selectProjects,
  shouldSyncGithub,
  shouldSyncLocal,
} from './lib/github-projects.mjs';
import { copyToClipboard } from './lib/clipboard.mjs';
import { extractNumbers } from './lib/numbers.mjs';
import {
  findCacheByPdf,
  findCachedJobByAlias,
  listCachedJobs,
} from './lib/output-paths.mjs';
import { LlmError, runAgent } from './lib/llm.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const resumeOutputDir = resolve(rootDir, 'generated', 'resumes');
const answersOutputDir = resolve(rootDir, 'generated', 'answers');
const cacheRoot = resolve(rootDir, '.cache', 'tailor');

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  printHelp();
  process.exit(0);
}

let career;
try {
  career = loadCareer(rootDir).career;
} catch (error) {
  fail(error.message);
}

const question = readTextInput(options.question);
if (!question) {
  fail('Provide a question with -q "<text>" or -q question.txt.');
}

const hint = readHints(options.hints);

let resolved;
try {
  resolved = await resolveJob(options);
} catch (error) {
  fail(error.message);
}

const { job } = resolved;
if (!job.title) {
  fail(
    'Could not determine a job title. Pass --title, or use a job URL/file with a title.',
  );
}

const slug =
  resolved.slug ||
  slugify([job.company, job.title].filter(Boolean).join(' ')) ||
  'application';

mkdirSync(answersOutputDir, { recursive: true });

const cacheDir = join(cacheRoot, `resume-${slug}`);
mkdirSync(cacheDir, { recursive: true });

const savedJobPath = join(cacheDir, 'job.md');
const resumePath = join(cacheDir, 'resume.json');
const tracePath = join(cacheDir, 'trace.json');
const candidatesPath = join(cacheDir, 'github-candidates.json');

if (!existsSync(savedJobPath)) {
  writeFileSync(savedJobPath, formatJobMarkdown(job));
}
const resume = readOptionalJson(resumePath);
const trace = readOptionalJson(tracePath);
let candidates = readOptionalJson(candidatesPath);

if (!candidates) {
  candidates = await resolveGithubCandidates(options, career, job);
  if (candidates.length > 0) {
    writeFileSync(
      candidatesPath,
      `${JSON.stringify(candidates, null, '\t')}\n`,
    );
  }
}

const questionSlug = options.name
  ? slugify(options.name).slice(0, 70) || 'question'
  : answerSlug(question);
const answerBase = join(
  answersOutputDir,
  `resume-${slug}.answer-${questionSlug}`,
);
const markdownPath = `${answerBase}.md`;
const jsonPath = `${answerBase}.json`;

const prompt = buildPrompt({
  career,
  job,
  slug,
  question,
  hint,
  candidates,
  resume,
  trace,
});

console.log(`answer: ${job.company ? `${job.company} — ` : ''}${job.title}`);
console.log(`answer: ${truncate(question, 100)}`);
console.log(
  `answer: using ${resume ? 'the tailored resume, ' : ''}${candidates.length} GitHub candidate(s)`,
);

let generated;
try {
  generated = runAgent({
    prompt,
    agent: 'job-answerer',
    title: `Answer: ${slug}`,
    timeout: options.timeout,
    cwd: rootDir,
    provider: options.provider,
    model: options.model,
    accept: (value) =>
      value && typeof value.answer === 'string' && value.answer.trim(),
    onAttempt: ({ phase, label, reason, index, total }) => {
      if (phase !== 'failed') return;
      const next = index + 1 < total ? '; trying the next provider' : '';
      console.warn(`answer: ${label} failed: ${reason}${next}`);
    },
  });
} catch (error) {
  const raw = error.raw || '';
  if (raw || options.debug) {
    writeFileSync(`${answerBase}.opencode-output.jsonl`, raw);
  }
  if (!(error instanceof LlmError)) fail(error.message);

  const saved = raw
    ? ` Raw output saved to ${answerBase}.opencode-output.jsonl.`
    : '';
  fail(`${error.message}${saved}`);
}

const output = generated.output;
if (typeof output.answer !== 'string' || !output.answer.trim()) {
  fail('Model response is missing a non-empty "answer" string.');
}

const providerLabel = generated.model
  ? `${generated.provider.label} (${generated.model})`
  : `${generated.provider.label} (default model)`;
console.log(`answer: draft from ${providerLabel}`);
if (generated.stats?.cost > 0) {
  const tokens =
    generated.stats.input != null
      ? `, ${generated.stats.input} in / ${generated.stats.output ?? '?'} out tokens`
      : '';
  console.log(`answer: model cost $${generated.stats.cost.toFixed(4)}${tokens}`);
}

const verification = verifyAnswer({ output, career, candidates, hint });
if (verification.errors.length > 0) {
  writeFileSync(`${answerBase}.opencode-output.jsonl`, generated.raw || '');
  for (const error of verification.errors) console.error(`  error: ${error}`);
  for (const warning of verification.warnings) {
    console.error(`  warning: ${warning}`);
  }
  fail(`Answer failed verification. Raw output saved to ${answerBase}.opencode-output.jsonl.`);
}

if (options.debug) {
  writeFileSync(`${answerBase}.prompt.txt`, prompt);
  writeFileSync(`${answerBase}.opencode-output.jsonl`, generated.raw || '');
}

writeFileSync(markdownPath, `${output.answer.trim()}\n`);
writeFileSync(
  jsonPath,
  `${JSON.stringify(
    {
      job: {
        company: job.company,
        title: job.title,
        url: job.url,
        slug,
      },
      question,
      hint: hint || null,
      questionType: output.question_type ?? 'other',
      answer: output.answer.trim(),
      claims: output.claims ?? [],
      evidence: output.evidence ?? [],
      gaps: output.gaps ?? [],
      followUp: output.follow_up ?? [],
      provider: generated.provider.label,
      model: generated.model,
      cost: generated.stats?.cost ?? 0,
      generatedAt: new Date().toISOString(),
      sources: {
        resume: resume ? `.cache/tailor/resume-${slug}/resume.json` : null,
        trace: trace ? `.cache/tailor/resume-${slug}/trace.json` : null,
        githubCandidates:
          candidates.length > 0
            ? `.cache/tailor/resume-${slug}/github-candidates.json`
            : null,
      },
    },
    null,
    '\t',
  )}\n`,
);

for (const warning of verification.warnings) {
  console.error(`answer: warning: ${warning}`);
}
console.log(
  `answer: verified ${verification.claimCount} claim(s), ${verification.evidenceCount} evidence id(s), ${verification.gaps.length} gap(s)`,
);
console.log(`answer: saved ${markdownPath}`);

if (options.copy) {
  const clipboard = copyToClipboard(output.answer.trim());
  if (clipboard.copied) {
    console.log(`answer: copied to clipboard (${clipboard.command})`);
  } else {
    console.warn(
      `answer: could not copy to clipboard; tried ${clipboard.attempts.join(', ')}. Answer saved at ${markdownPath}.`,
    );
  }
}

console.log('');
console.log(output.answer.trim());
if (verification.gaps.length > 0) {
  console.log('');
  console.log('answer: gaps:');
  for (const gap of verification.gaps) console.log(`  - ${gap}`);
}

async function resolveJob(opts) {
  const requestedSlug = opts.slug
    ? slugify(opts.slug).replace(/^resume-/, '')
    : '';

  if (opts.input) {
    const inputPath = resolve(process.cwd(), opts.input);
    const inputIsFile =
      existsSync(inputPath) && statSync(inputPath).isFile();
    const inputIsDirectory =
      existsSync(inputPath) && statSync(inputPath).isDirectory();
    const inputIsUrl = /^https?:\/\//i.test(opts.input);
    const inputIsJson = /\.json$/i.test(opts.input);
    const inputIsPdf = /\.pdf$/i.test(opts.input);

    if (inputIsDirectory) {
      const jobFile = join(inputPath, 'job.md');
      if (existsSync(jobFile)) {
        return {
          job: await readJobInput({ input: jobFile }),
          slug:
            requestedSlug ||
            basename(inputPath).replace(/^resume-/, ''),
        };
      }
    }

    if (inputIsFile && !inputIsJson && !inputIsPdf) {
      return {
        job: await readJobInput(opts),
        slug: requestedSlug,
      };
    }

    if (inputIsUrl) {
      return {
        job: await readJobInput(opts),
        slug: requestedSlug,
      };
    }

    if (inputIsPdf) {
      const cached = findCacheByPdf({
        rootDir,
        cacheRoot,
        resumeOutputDir,
        pdfPath: inputPath,
      });
      if (cached) {
        return {
          job: applyOverrides(
            await readJobInput({ input: cached.jobPath }),
            opts,
          ),
          slug: requestedSlug || cached.slug,
        };
      }
    }

    if (opts.url || opts.description) {
      return {
        job: await readJobInput({ ...opts, input: undefined }),
        slug: requestedSlug,
      };
    }

    let candidateSource = opts.input;
    if (inputIsJson || inputIsPdf) {
      candidateSource = basename(opts.input).replace(/\.(json|pdf)$/i, '');
      if (candidateSource === 'resume') {
        candidateSource = basename(dirname(opts.input));
      }
    }
    const candidateSlug = slugify(candidateSource).replace(/^resume-/, '');
    const savedPath = join(
      cacheRoot,
      `resume-${candidateSlug}`,
      'job.md',
    );
    if (existsSync(savedPath)) {
      return {
        job: applyOverrides(
          await readJobInput({ input: savedPath }),
          opts,
        ),
        slug: requestedSlug || candidateSlug,
      };
    }

    const alias = findCachedJobByAlias({
      rootDir,
      cacheRoot,
      resumeOutputDir,
      alias: candidateSlug,
    });
    if (alias) {
      return {
        job: applyOverrides(
          await readJobInput({ input: alias.jobPath }),
          opts,
        ),
        slug: requestedSlug || alias.slug,
      };
    }

    if (opts.title) {
      return {
        job: await readJobInput({ ...opts, input: undefined }),
        slug: requestedSlug,
      };
    }

    throw new Error(
      `Job input not found: ${opts.input}. Pass a URL, a file, or a generated resume slug.`,
    );
  }

  if (requestedSlug) {
    if (opts.url || opts.description) {
      return {
        job: await readJobInput({ ...opts, input: undefined }),
        slug: requestedSlug,
      };
    }

    const savedPath = join(
      cacheRoot,
      `resume-${requestedSlug}`,
      'job.md',
    );
    if (existsSync(savedPath)) {
      return {
        job: applyOverrides(
          await readJobInput({ input: savedPath }),
          opts,
        ),
        slug: requestedSlug,
      };
    }

    const alias = findCachedJobByAlias({
      rootDir,
      cacheRoot,
      resumeOutputDir,
      alias: requestedSlug,
    });
    if (alias) {
      return {
        job: applyOverrides(
          await readJobInput({ input: alias.jobPath }),
          opts,
        ),
        slug: alias.slug,
      };
    }

    if (opts.title) {
      return {
        job: await readJobInput({ ...opts, input: undefined }),
        slug: requestedSlug,
      };
    }
    throw new Error(
      `No saved job found for slug "${requestedSlug}". Generate a resume first or pass a job URL/file.`,
    );
  }

  if (opts.url || opts.description || opts.title) {
    return {
      job: await readJobInput(opts),
      slug: '',
    };
  }

  const latest = findLatestTailorRun();
  if (latest) {
    console.log(
      `answer: no job specified; using last tailor run: ${latest.slug}`,
    );
    return {
      job: await readJobInput({ input: latest.jobPath }),
      slug: latest.slug,
    };
  }

  throw new Error(
    'Provide a job URL, a job file, or --slug for an existing generated resume. No previous tailor run is available to reuse.',
  );
}

function findLatestTailorRun() {
  const runs = listCachedJobs({
    rootDir,
    cacheRoot,
    resumeOutputDir,
  })
    .map((job) => ({
      ...job,
      mtime: existsSync(job.pdfPath)
        ? statSync(job.pdfPath).mtimeMs
        : statSync(job.jobPath).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  return runs[0] ?? null;
}

function applyOverrides(job, opts) {
  return {
    ...job,
    title: opts.title?.trim() || job.title,
    company: opts.company?.trim() || job.company,
    url: opts.url?.trim() || job.url,
  };
}

async function resolveGithubCandidates(opts, careerData, jobData) {
  const githubPath = resolve(rootDir, 'data/github.json');
  let githubSynced = false;

  if (
    !opts.noSync &&
    (opts.refresh ||
      shouldSyncGithub(githubPath, { noSync: opts.noSync }))
  ) {
    console.log(
      opts.refresh
        ? 'answer: refreshing GitHub/org and local project sources'
        : 'answer: GitHub data is missing or older than 24 hours; syncing',
    );
    const sync = spawnSync(
      process.execPath,
      [resolve(__dirname, 'sync-github.mjs')],
      { cwd: rootDir, stdio: 'inherit' },
    );
    githubSynced = sync.status === 0;
    if (!githubSynced) {
      console.warn(
        'answer: GitHub/org sync failed; continuing with local project scan.',
      );
    }
  }

  const localPath = resolve(rootDir, 'data/local-projects.json');
  if (
    !opts.noSync &&
    !githubSynced &&
    (opts.refresh || shouldSyncLocal(localPath, { noSync: opts.noSync }))
  ) {
    console.log('answer: rescanning local projects');
    const sync = spawnSync(
      process.execPath,
      [resolve(__dirname, 'sync-local-projects.mjs')],
      { cwd: rootDir, stdio: 'inherit' },
    );
    if (sync.status !== 0) {
      console.warn(
        'answer: local project sync failed; continuing without local candidates.',
      );
    }
  }

  const github = loadGithub(githubPath);
  const local = loadLocal(localPath);
  if (!github && !local) {
    console.warn(
      'answer: no project metadata found; run `aube run sync-github` to include GitHub and local projects.',
    );
    return [];
  }
  return selectProjects(github, local, careerData, jobData);
}

function buildPrompt({
  career,
  job,
  slug,
  question,
  hint,
  candidates,
  resume,
  trace,
}) {
  const sections = [
    '<application>',
    `company: ${job.company || '(not provided)'}`,
    `title: ${job.title}`,
    `url: ${job.url || '(not provided)'}`,
    `slug: ${slug}`,
    '</application>',
    '',
    '<job_description>',
    job.body || job.title,
    '</job_description>',
    '',
    '<career>',
    stringifyYaml(career).trim(),
    '</career>',
    '',
    '<project_candidates>',
    JSON.stringify(candidates, null, 2),
    '</project_candidates>',
    '',
    'Project entries may come from personal GitHub, organizations, or local ~/projects repositories. Cite the entry\'s `evidence` value.',
  ];

  if (resume) {
    sections.push(
      '',
      '<tailored_resume>',
      JSON.stringify(resume, null, 2),
      '</tailored_resume>',
    );
  }
  if (trace) {
    sections.push(
      '',
      '<resume_trace>',
      JSON.stringify(trace, null, 2),
      '</resume_trace>',
    );
  }

  sections.push('', '<question>', question, '</question>');

  if (hint) {
    sections.push('', '<hint>', hint, '</hint>');
  }

  sections.push(
    '',
    'Answer the question using only the sources above. When a tailored resume is present, use it as the primary framing.',
    hint
      ? "The <hint> is user-provided, trusted context. Use its specifics directly, connect it to a matching fact-bank achievement when clear, and cite `hint` for hint-based claims. Reasonable connective reasoning about motivation or the immediate outcome is allowed; do not invent metrics or extra events."
      : '',
    'Return the JSON object described in your system prompt. Output JSON only.',
  );

  return sections.join('\n');
}

function verifyAnswer({ output, career, candidates, hint }) {
  const errors = [];
  const warnings = [];
  const known = buildEvidenceMap(career, candidates, hint);
  const allowedYears = buildAllowedYears(career);

  const claims = Array.isArray(output.claims) ? output.claims : [];
  const evidence = Array.isArray(output.evidence) ? output.evidence : [];
  const gaps = Array.isArray(output.gaps) ? output.gaps : [];

  if (!Array.isArray(output.claims)) errors.push('claims is missing');
  if (!Array.isArray(output.evidence)) errors.push('evidence is missing');
  if (!Array.isArray(output.gaps)) warnings.push('gaps is missing');

  const allowedTypes = [
    'application',
    'behavioral',
    'motivation',
    'interview-prep',
    'other',
  ];
  if (!allowedTypes.includes(output.question_type)) {
    warnings.push(
      `unexpected question_type "${output.question_type}"`,
    );
  }

  claims.forEach((entry, index) => {
    if (!entry || typeof entry.claim !== 'string' || !entry.claim.trim()) {
      errors.push(`claims[${index}] is missing claim text`);
      return;
    }
    const ids = Array.isArray(entry.evidence) ? entry.evidence : [];
    if (ids.length === 0) {
      errors.push(`claims[${index}] has no evidence`);
      return;
    }
    const texts = [];
    for (const id of ids) {
      const text = known.get(id);
      if (!text) {
        errors.push(`claims[${index}] cites unknown evidence "${id}"`);
      } else {
        texts.push(text);
      }
    }
    if (texts.length > 0) {
      checkNumbers(
        entry.claim,
        texts.join('\n'),
        `claims[${index}]`,
        errors,
        allowedYears,
      );
    }
  });

  evidence.forEach((id, index) => {
    if (!known.has(id)) {
      errors.push(`evidence[${index}] cites unknown evidence "${id}"`);
    }
  });

  const evidenceSet = new Set(evidence);
  for (const [index, entry] of claims.entries()) {
    for (const id of entry.evidence ?? []) {
      if (!evidenceSet.has(id)) {
        warnings.push(
          `claims[${index}] evidence "${id}" is not in the top-level evidence list`,
        );
      }
    }
  }

  if (
    hint &&
    !claims.some((entry) => (entry.evidence ?? []).includes('hint'))
  ) {
    warnings.push(
      'a hint was provided but no claims cite it; review whether the hint was used',
    );
  }

  if (claims.length === 0 && output.question_type !== 'interview-prep') {
    warnings.push('no factual claims were provided; review the answer manually');
  }

  return {
    errors,
    warnings,
    claimCount: claims.length,
    evidenceCount: evidence.length,
    gaps,
  };
}

function buildEvidenceMap(career, candidates, hint) {
  const map = new Map();
  if (hint) map.set('hint', hint);
  for (const role of career.roles ?? []) {
    map.set(
      `role:${role.id}`,
      [
        role.company,
        role.position,
        role.startDate,
        role.endDate,
        role.summary,
      ]
        .filter(Boolean)
        .join('\n'),
    );
    for (const achievement of role.achievements ?? []) {
      map.set(achievement.id, achievement.text ?? '');
    }
  }
  for (const project of career.projects ?? []) {
    for (const highlight of project.highlights ?? []) {
      map.set(highlight.id, highlight.text ?? '');
    }
  }
  for (const entry of career.education ?? []) {
    const id = entry.id || slugify(entry.institution);
    const text = [
      entry.institution,
      entry.area,
      entry.studyType,
      entry.startDate,
      entry.endDate,
    ]
      .filter(Boolean)
      .join(' ');
    map.set(`education:${id}`, text);
    map.set('education', text);
  }
  for (const repo of candidates ?? []) {
    const text = [
      repo.description,
      repo.readme,
      ...(repo.localCommits ?? []),
    ].join('\n');
    const evidence =
      repo.evidence ||
      (repo.source === 'local'
        ? `local:${repo.name}`
        : repo.source === 'org' && repo.fullName
          ? `github:${repo.fullName}`
          : `github:${repo.name}`);

    map.set(evidence, text);
    if (repo.source !== 'local') {
      map.set(`github:${repo.name}`, text);
      if (repo.fullName) map.set(`github:${repo.fullName}`, text);
    }
  }
  return map;
}

function buildAllowedYears(career) {
  const years = new Set();
  const add = (date) => {
    const match = String(date ?? '').match(/^(\d{4})/);
    if (match) years.add(match[1]);
  };
  for (const role of career.roles ?? []) {
    add(role.startDate);
    add(role.endDate);
  }
  for (const entry of career.education ?? []) {
    add(entry.startDate);
    add(entry.endDate);
  }
  return years;
}

function checkNumbers(output, sourceText, path, errors, allowedYears) {
  const sourceNumbers = new Set(extractNumbers(sourceText));
  for (const number of extractNumbers(output)) {
    if (allowedYears?.has(number)) continue;
    if (!sourceNumbers.has(number)) {
      errors.push(`${path} contains "${number}", which is not in the cited evidence`);
    }
  }
}

function readHints(values) {
  if (!Array.isArray(values)) return '';
  return values
    .map((value) => readTextInput(value))
    .filter(Boolean)
    .join('\n\n');
}

function readTextInput(value) {
  if (!value) return '';
  const path = resolve(process.cwd(), value);
  if (existsSync(path) && statSync(path).isFile()) {
    return readFileSync(path, 'utf8').trim();
  }
  return String(value).trim();
}

function readOptionalJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`Invalid JSON in ${path}: ${error.message}`);
  }
}

function truncate(value, length) {
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function answerSlug(value) {
  const slug = slugify(value);
  if (slug.length <= 50) return slug || 'question';

  const cut = slug.slice(0, 50);
  const lastDash = cut.lastIndexOf('-');
  return (lastDash > 10 ? cut.slice(0, lastDash) : cut) || 'question';
}

function parseArgs(argv) {
  const parsed = {
    copy: true,
    refresh: false,
    debug: false,
    timeout: 10 * 60 * 1000,
  };
  const positionals = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    const inlineHint = arg.startsWith('--hint=')
      ? arg.slice('--hint='.length)
      : arg.startsWith('-h=')
        ? arg.slice('-h='.length)
        : null;
    if (inlineHint !== null) {
      if (!inlineHint) {
        fail('Provide a hint with --hint "<text>" or -h="<text>".');
      }
      (parsed.hints ??= []).push(inlineHint);
      continue;
    }

    switch (arg) {
      case '--help':
        parsed.help = true;
        break;
      case '--hint':
      case '-h':
      case '-H': {
        const value = argv[++i];
        if (!value) {
          fail('Provide a hint with --hint "<text>" or -h="<text>".');
        }
        (parsed.hints ??= []).push(value);
        break;
      }
      case '--question':
      case '-q':
        parsed.question = argv[++i];
        break;
      case '--slug':
        parsed.slug = argv[++i];
        break;
      case '--name':
        parsed.name = argv[++i];
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
      case '--provider':
        parsed.provider = argv[++i];
        break;
      case '--model':
        parsed.model = argv[++i];
        break;
      case '--timeout':
        parsed.timeout = Number(argv[++i]) * 1000;
        break;
      case '--refresh':
        parsed.refresh = true;
        break;
      case '--no-sync':
        parsed.noSync = true;
        break;
      case '--no-copy':
        parsed.copy = false;
        break;
      case '--debug':
        parsed.debug = true;
        break;
      default:
        if (arg.startsWith('-')) {
          fail(`Unknown option: ${arg}. Run with --help for usage.`);
        }
        positionals.push(arg);
    }
  }

  parsed.input = positionals[0];
  return parsed;
}

function printHelp() {
  console.log(`Usage:
  aube run answer -q "<question>" [-h "<hint>"]
  aube run answer -- <job-url | job-file | slug> -q "<question>" [--hint "<hint>"]

Options:
  --question, -q <value>  Question text or file (required)
  --hint, -h, -H <value>  Additional context for the answer
  --slug <name>           Generated resume slug to associate with
  --name <name>           Answer filename slug (default: question slug)
  --title <text>          Job title override
  --company <text>        Company override
  --url <url>             Job URL when not using a positional input
  --description <value>   Job description text, file, or URL
  --provider <name>       Model provider: auto, opencode, go, openrouter (default: auto)
  --model <model>         Use one exact model and skip provider fallback
  --timeout <seconds>     Per-provider timeout (default: 600; OpenRouter primary capped at 120)
  --refresh               Force a GitHub/org + local project refresh
  --no-sync               Skip the 24-hour GitHub metadata refresh
  --no-copy               Do not copy the answer to the clipboard
  --debug                 Save the prompt and raw OpenCode output
  --help                  Show this help

Aube reserves exact -h for its own help. Without --, use --hint, -H, or -h="...";
-h "..." works after -- or when invoking the script directly.

If no job is provided, the most recent tailor run with a cache is reused.
Answers are written to generated/answers/resume-<slug>.answer-<question>.md and
copied to the clipboard by default.

Examples:
  aube run answer -q "Why do you want this role?"
  aube run answer -q "Why this role?" --hint "Emphasize customer-facing work"
  aube run answer -q "Why this role?" -h="Emphasize customer-facing work"
  aube run answer -- https://example.com/job --question "Why do you want this role?"
  aube run answer -- acme-forward-deployed-engineer -q "Tell me about a production issue you fixed."
  aube run answer -- job.md -q question.txt --provider go`);
}

function fail(message) {
  console.error(`answer: ${message}`);
  process.exit(1);
}
