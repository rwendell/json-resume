#!/usr/bin/env node
/**
 * Write an Upwork proposal from the career fact bank, project candidates, and
 * the same job context used by tailor/answer.
 *
 * Usage:
 *   aube run proposal https://www.upwork.com/jobs/...
 *   aube run proposal job.md --client client.txt --rate 85
 *   aube run proposal upwork-job-slug -q "How would you approach this?"
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify as stringifyYaml } from 'yaml';
import { loadCareer } from './lib/career.mjs';
import { formatJobMarkdown, slugify } from './lib/job-input.mjs';
import { copyToClipboard } from './lib/clipboard.mjs';
import {
  readOptionalJson,
  readTextInput,
  resolveGithubCandidates,
  resolveJob,
} from './lib/job-context.mjs';
import { LlmError, runAgent } from './lib/llm.mjs';
import { verifyProposal } from './lib/proposal-verify.mjs';
import {
  applyProfileToCareer,
  loadUpworkProfile,
  mapProfilePortfolio,
} from './lib/upwork-profile.mjs';
import {
  buildProposalSettings,
  describeBudget,
  extractRequiredOpening,
  formatRate,
  loadUpworkConfig,
  parseBudget,
} from './lib/upwork.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const resumeOutputDir = resolve(rootDir, 'generated', 'resumes');
const proposalsOutputDir = resolve(rootDir, 'generated', 'proposals');
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

let upwork;
try {
  upwork = loadUpworkConfig(rootDir);
} catch (error) {
  fail(error.message);
}
if (!upwork.path) {
  console.warn(
    'proposal: no data/upwork.yml or data/upwork.example.yml found; using built-in defaults.',
  );
}

const configuredProfileUrl =
  typeof upwork.config.profile === 'string'
    ? upwork.config.profile
    : upwork.config.profile?.url;
const profileUrl =
  options.profile ||
  (!options.noProfile ? configuredProfileUrl : '') ||
  '';

let profile = null;
if (profileUrl) {
  try {
    profile = await loadUpworkProfile(profileUrl, {
      rootDir,
      refresh: options.refresh,
      log: (message) => console.log(`proposal: ${message}`),
      warn: (message) => console.warn(`proposal: ${message}`),
    });
    applyProfileToCareer(career, profile);
    const location = [
      profile.location?.city,
      profile.location?.region,
      profile.location?.countryCode,
    ]
      .filter(Boolean)
      .join(', ');
    console.log(
      `proposal: profile ${profile.name || profile.url}${
        profile.rate ? ` — ${formatRate(profile.rate)}` : ''
      }${location ? ` — ${location}` : ''}`,
    );
  } catch (error) {
    if (options.profile) fail(error.message);
    console.warn(
      `proposal: could not load configured Upwork profile: ${error.message}`,
    );
  }
}

const settings = buildProposalSettings(upwork.config, options, { profile });
if (options.rate != null && settings.rate == null) {
  fail('--rate must be a positive number.');
}
if (
  options.rateType &&
  !['hourly', 'fixed'].includes(String(options.rateType).toLowerCase())
) {
  fail('--rate-type must be "hourly" or "fixed".');
}

const questions = readQuestions(options);
const hint = readHints(options.hints);
const client = readTextInput(options.client);

let resolved;
try {
  resolved = await resolveJob(options, {
    rootDir,
    cacheRoot,
    resumeOutputDir,
    log: (message) => console.log(`proposal: ${message}`),
  });
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
  'upwork-job';

mkdirSync(proposalsOutputDir, { recursive: true });
const cacheDir = join(cacheRoot, `resume-${slug}`);
mkdirSync(cacheDir, { recursive: true });

const savedJobPath = join(cacheDir, 'job.md');
const resumePath = join(cacheDir, 'resume.json');
const tracePath = join(cacheDir, 'trace.json');
const candidatesPath = join(cacheDir, 'github-candidates.json');

if (!existsSync(savedJobPath)) {
  writeFileSync(savedJobPath, formatJobMarkdown(job));
}

let resume;
let trace;
let candidates;
try {
  resume = readOptionalJson(resumePath);
  trace = readOptionalJson(tracePath);
  candidates = readOptionalJson(candidatesPath);
} catch (error) {
  fail(error.message);
}

if (!candidates) {
  candidates = await resolveGithubCandidates(options, career, job, {
    rootDir,
    scriptsDir: __dirname,
    log: (message) => console.log(`proposal: ${message}`),
    warn: (message) => console.warn(`proposal: ${message}`),
  });
  if (candidates.length > 0) {
    writeFileSync(
      candidatesPath,
      `${JSON.stringify(candidates, null, '\t')}\n`,
    );
  }
}

const yamlPreferredSamples =
  Array.isArray(upwork.config.preferredSamples) &&
  upwork.config.preferredSamples.length > 0;
if (profile) {
  const mapped = mapProfilePortfolio(profile, career, candidates);
  profile.portfolio = mapped.portfolio;
  profile.preferredSamples = mapped.preferredSamples;
  if (!yamlPreferredSamples) {
    settings.preferredSamples = mapped.preferredSamples;
  }
}

const requiredOpening = extractRequiredOpening(job.body);
const budget = parseBudget(job.details?.budget);
if (
  budget &&
  settings.minHourlyRate &&
  job.details?.budgetType !== 'fixed' &&
  budget.max < settings.minHourlyRate
) {
  console.warn(
    `proposal: job budget ${describeBudget(job.details)} is below your minimum hourly rate ${formatRate(
      {
        type: 'hourly',
        amount: settings.minHourlyRate,
        currency: settings.currency,
      },
    )}`,
  );
}

const nameSlug = options.name
  ? slugify(options.name).slice(0, 70) || 'proposal'
  : '';
const outputBase = join(
  proposalsOutputDir,
  `upwork-${slug.replace(/^upwork-/, '')}${nameSlug ? `.${nameSlug}` : ''}`,
);
const markdownPath = `${outputBase}.md`;
const jsonPath = `${outputBase}.json`;

const prompt = buildPrompt({
  career,
  job,
  slug,
  candidates,
  resume,
  trace,
  client,
  hint,
  settings,
  questions,
  requiredOpening,
  timeline: settings.timeline,
  profile,
});

console.log(
  `proposal: ${job.company ? `${job.company} — ` : ''}${job.title}`,
);
if (job.details?.budget) {
  console.log(`proposal: client budget ${describeBudget(job.details)}`);
}
console.log(
  `proposal: ${questions.length} screening question(s); using ${
    resume ? 'the tailored resume, ' : ''
  }${candidates.length} project candidate(s)`,
);

if (options.debug) {
  writeFileSync(`${outputBase}.prompt.txt`, prompt);
}

let generated;
try {
  generated = runAgent({
    prompt,
    agent: 'upwork-proposer',
    title: `Proposal: ${slug}`,
    timeout: options.timeout,
    cwd: rootDir,
    provider: options.provider,
    model: options.model,
    accept: (value) =>
      value &&
      typeof value.proposal === 'string' &&
      value.proposal.trim(),
    onAttempt: ({ phase, label, reason, index, total }) => {
      if (phase !== 'failed') return;
      const next = index + 1 < total ? '; trying the next provider' : '';
      console.warn(`proposal: ${label} failed: ${reason}${next}`);
    },
  });
} catch (error) {
  const raw = error.raw || '';
  if (raw || options.debug) {
    writeFileSync(`${outputBase}.opencode-output.jsonl`, raw);
  }
  if (!(error instanceof LlmError)) fail(error.message);

  const saved = raw
    ? ` Raw output saved to ${outputBase}.opencode-output.jsonl.`
    : '';
  fail(`${error.message}${saved}`);
}

const output = generated.output;
if (typeof output.proposal !== 'string' || !output.proposal.trim()) {
  fail('Model response is missing a non-empty "proposal" string.');
}

const providerLabel = generated.model
  ? `${generated.provider.label} (${generated.model})`
  : `${generated.provider.label} (default model)`;
console.log(`proposal: draft from ${providerLabel}`);
if (generated.stats?.cost > 0) {
  const tokens =
    generated.stats.input != null
      ? `, ${generated.stats.input} in / ${generated.stats.output ?? '?'} out tokens`
      : '';
  console.log(
    `proposal: model cost $${generated.stats.cost.toFixed(4)}${tokens}`,
  );
}

const verification = verifyProposal({
  output,
  career,
  candidates,
  hint,
  client,
  settings,
  job,
  questions,
  requiredOpening,
  timeline: settings.timeline,
  profile,
});
if (verification.errors.length > 0) {
  writeFileSync(`${outputBase}.opencode-output.jsonl`, generated.raw || '');
  for (const error of verification.errors) console.error(`  error: ${error}`);
  for (const warning of verification.warnings) {
    console.error(`  warning: ${warning}`);
  }
  fail(
    `Proposal failed verification. Raw output saved to ${outputBase}.opencode-output.jsonl.`,
  );
}

if (options.debug) {
  writeFileSync(`${outputBase}.prompt.txt`, prompt);
  writeFileSync(`${outputBase}.opencode-output.jsonl`, generated.raw || '');
}

const proposal = output.proposal.trim();
const screeningAnswers = Array.isArray(output.screening_answers)
  ? output.screening_answers
  : [];
const samples = Array.isArray(output.samples) ? output.samples : [];
const rate = output.rate ?? settings.rate ?? null;
const timeline = output.timeline ?? settings.timeline ?? null;
const availability =
  output.availability ?? settings.availability ?? null;

writeFileSync(markdownPath, `${proposal}\n`);
writeFileSync(
  jsonPath,
  `${JSON.stringify(
    {
      job: {
        company: job.company,
        title: job.title,
        url: job.url,
        slug,
        details: job.details ?? {},
      },
      client: client || job.details?.client || null,
      profile: profile
        ? {
            url: profile.url,
            name: profile.name,
            title: profile.title,
            location: profile.location,
            rate: profile.rate,
            hoursPerWeek: profile.hoursPerWeek,
            summary: profile.summary,
            skills: profile.skills,
            portfolio: profile.portfolio,
            fetchedAt: profile.fetchedAt,
            cached: Boolean(profile.cached),
          }
        : null,
      questions,
      requiredOpening: requiredOpening || null,
      proposal,
      hook: output.hook ?? null,
      screeningAnswers,
      rate,
      timeline,
      availability,
      samples,
      claims: output.claims ?? [],
      evidence: output.evidence ?? [],
      gaps: output.gaps ?? [],
      fit: output.fit ?? null,
      settings: {
        targetWords: settings.targetWords,
        minWords: settings.minWords,
        maxWords: settings.maxWords,
        maxChars: settings.maxChars,
        includeRate: settings.includeRate,
        includeAvailability: settings.includeAvailability,
        profileUrl: settings.profileUrl || null,
      },
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
        profile: profile?.cachePath ?? null,
      },
    },
    null,
    '\t',
  )}\n`,
);

for (const warning of verification.warnings) {
  console.error(`proposal: warning: ${warning}`);
}
console.log(
  `proposal: verified ${verification.claimCount} claim(s), ${verification.evidenceCount} evidence id(s), ${verification.wordCount} words`,
);
console.log(`proposal: saved ${markdownPath}`);

if (options.copy) {
  const clipboard = copyToClipboard(proposal);
  if (clipboard.copied) {
    console.log(`proposal: copied to clipboard (${clipboard.command})`);
  } else {
    console.warn(
      `proposal: could not copy to clipboard; tried ${clipboard.attempts.join(', ')}. Proposal saved at ${markdownPath}.`,
    );
  }
}

console.log('');
console.log(proposal);

const logistics = [];
if (rate) logistics.push(`rate: ${formatRate(rate)}`);
if (timeline) logistics.push(`timeline: ${timeline}`);
if (availability) logistics.push(`availability: ${availability}`);
if (logistics.length > 0) {
  console.log('');
  for (const line of logistics) console.log(`proposal: ${line}`);
}

if (screeningAnswers.length > 0) {
  console.log('');
  console.log('proposal: screening answers:');
  for (const entry of screeningAnswers) {
    console.log(`  Q: ${entry.question}`);
    console.log(`  A: ${entry.answer}`);
    console.log('');
  }
}

if (samples.length > 0) {
  console.log('proposal: suggested samples:');
  for (const sample of samples) {
    const label = sample.title || sample.name || sample.evidence;
    console.log(
      `  - ${label} (${sample.evidence})${sample.why ? ` — ${sample.why}` : ''}`,
    );
  }
}

if (output.fit) {
  const fit = output.fit;
  console.log('');
  console.log(
    `proposal: fit ${fit.verdict}${Array.isArray(fit.reasons) && fit.reasons.length > 0 ? ` — ${fit.reasons.join('; ')}` : ''}`,
  );
  for (const concern of fit.concerns ?? []) {
    console.log(`  concern: ${concern}`);
  }
}

if (verification.gapCount > 0) {
  console.log('');
  console.log('proposal: gaps:');
  for (const gap of output.gaps ?? []) console.log(`  - ${gap}`);
}

function buildPrompt({
  career,
  job,
  slug,
  candidates,
  resume,
  trace,
  client,
  hint,
  settings,
  questions,
  requiredOpening,
  timeline,
  profile,
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
  ];

  if (job.details && Object.keys(job.details).length > 0) {
    sections.push(
      '',
      '<job_details>',
      stringifyYaml(job.details).trim(),
      '</job_details>',
    );
  }

  if (profile) {
    sections.push(
      '',
      '<upwork_profile>',
      stringifyYaml({
        url: profile.url,
        name: profile.name,
        title: profile.title,
        location: profile.location,
        rate: profile.rate,
        hoursPerWeek: profile.hoursPerWeek,
        summary: profile.summary,
        skills: profile.skills,
        portfolio: profile.portfolio,
      }).trim(),
      '</upwork_profile>',
    );
  }

  if (client) {
    sections.push('', '<client_context>', client, '</client_context>');
  }
  if (hint) {
    sections.push('', '<hint>', hint, '</hint>');
  }

  sections.push(
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
  );

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

  sections.push(
    '',
    '<upwork_defaults>',
    stringifyYaml({
      rate: settings.rate,
      includeRate: settings.includeRate,
      availability: settings.availability || null,
      includeAvailability: settings.includeAvailability,
      timezone: settings.timezone || null,
      timeline: timeline || null,
      targetWords: settings.targetWords,
      minWords: settings.minWords,
      maxWords: settings.maxWords,
      preferredSamples: settings.preferredSamples,
    }).trim(),
    '</upwork_defaults>',
    '',
    '<screening_questions>',
    JSON.stringify(questions, null, 2),
    '</screening_questions>',
  );

  if (requiredOpening) {
    sections.push(
      '',
      '<required_opening>',
      requiredOpening,
      '</required_opening>',
    );
  }

  sections.push(
    '',
    'Write a proposal that is ready to paste into Upwork. Follow the job description\'s application instructions exactly, including any required opening word or phrase and any questions the client asks in the description.',
    '<upwork_profile> is the public Upwork profile. Use it for identity, location, skills, and portfolio context; the career fact bank takes precedence for employment, dates, metrics, and achievements. When `<upwork_defaults>` rate or availability differs from the profile, use `<upwork_defaults>`.',
    questions.length > 0
      ? 'Answer every supplied screening question separately in `screening_answers`, in the same order.'
      : 'If the job description contains explicit screening questions, include them in `screening_answers`.',
    'Use 1-3 `samples` for the project evidence most worth linking or attaching, and explain why each is relevant.',
    '`<upwork_defaults>.preferredSamples` is a soft preference list; use those samples when they fit, but do not force an irrelevant one.',
    'Keep plans, approach statements, opinions, and limitations out of `claims`. Put limitations in `gaps`; only candidate facts belong in `claims`.',
    'Never assert a current location, work authorization, citizenship, or residency unless it is explicit in the sources. If the job requires one and the sources are silent, put it in `gaps` and invite the client to confirm.',
    'Only state a rate, timeline, or availability that appears in `<upwork_defaults>`, `<client_context>`, or `<hint>`. If `includeRate` is false and the client did not ask for a rate, do not invent one.',
    'Return the JSON object described in your system prompt. Output JSON only.',
  );

  return sections.join('\n');
}

function readQuestions(opts) {
  const questions = [];

  for (const value of opts.questions ?? []) {
    const text = readTextInput(value);
    if (!text) continue;
    questions.push(
      ...text
        .split(/\n\s*\n/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    );
  }

  if (opts.questionsFile) {
    const path = resolve(process.cwd(), opts.questionsFile);
    if (!existsSync(path) || !statSync(path).isFile()) {
      fail(`Questions file not found: ${opts.questionsFile}`);
    }
    const text = readTextInput(opts.questionsFile);
    for (const line of text.split('\n')) {
      const trimmed = line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim();
      if (trimmed) questions.push(trimmed);
    }
  }

  return [...new Set(questions)];
}

function readHints(values) {
  if (!Array.isArray(values)) return '';
  return values
    .map((value) => readTextInput(value))
    .filter(Boolean)
    .join('\n\n');
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

    const inlineQuestion = arg.startsWith('--question=')
      ? arg.slice('--question='.length)
      : arg.startsWith('-q=')
        ? arg.slice('-q='.length)
        : null;
    if (inlineQuestion !== null) {
      if (!inlineQuestion) {
        fail('Provide a question with -q "<text>" or -q question.txt.');
      }
      (parsed.questions ??= []).push(inlineQuestion);
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
      case '-q': {
        const value = argv[++i];
        if (!value) {
          fail('Provide a question with -q "<text>" or -q question.txt.');
        }
        (parsed.questions ??= []).push(value);
        break;
      }
      case '--questions':
      case '--questions-file':
        parsed.questionsFile = argv[++i];
        break;
      case '--client':
        parsed.client = argv[++i];
        break;
      case '--rate':
        parsed.rate = argv[++i];
        break;
      case '--rate-type':
        parsed.rateType = argv[++i];
        break;
      case '--no-rate':
        parsed.noRate = true;
        break;
      case '--timeline':
        parsed.timeline = argv[++i];
        break;
      case '--availability':
        parsed.availability = argv[++i];
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
      case '--profile':
        parsed.profile = argv[++i];
        break;
      case '--no-profile':
        parsed.noProfile = true;
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
  aube run proposal <job-url | job-file | slug> [options]
  aube run proposal --title "<title>" --description <file|text> [options]
  aube run proposal -- <args>   # force args past aube, e.g. -h or --help

Options:
  --client <text or file>       Client context: spend, hire rate, location, payment
  --profile <url>               Public Upwork profile for defaults
  --no-profile                  Ignore profile.url from data/upwork.yml
  --question, -q <text or file> Screening question (repeatable)
  --questions <file>            One screening question per line
  --hint, -h, -H <text or file> Extra context or positioning guidance
  --rate <amount>               Hourly rate or fixed bid to use
  --rate-type <hourly|fixed>    Rate type (default: hourly)
  --no-rate                     Keep the rate out of the proposal text
  --timeline <text>             Delivery timeline, e.g. "2 weeks"
  --availability <text>         Availability, e.g. "20 hrs/week, UK overlap"
  --slug <name>                 Generated resume/cache slug to reuse
  --name <name>                 Proposal filename suffix
  --title <text>                Job title override
  --company <text>              Client/company override
  --url <url>                   Job URL when not using a positional input
  --description <value>         Job description text, file, or URL
  --provider <name>             Model provider: auto, opencode, go, openrouter
  --model <model>               Use one exact model and skip provider fallback
  --timeout <seconds>           Per-provider timeout (default: 600)
  --refresh                     Force GitHub/org, local, and profile refresh
  --no-sync                     Skip the 24-hour GitHub metadata refresh
  --no-copy                     Do not copy the proposal to the clipboard
  --debug                       Save the prompt and raw OpenCode output
  --help                        Show this help

Defaults live in data/upwork.yml (see data/upwork.example.yml). Public Upwork
/jobs/... URLs use a headless browser fallback. Saved-jobs modal and search
URLs are rejected; copy the public job URL or save the description to a file.

When profile.url or --profile is set, public profile values fill name, title,
location, rate, skills, and portfolio; hours per week is used when present.
data/upwork.yml and CLI flags still override them.

The -- separator is optional for a URL, file, or slug. Use it when the first
script argument is a flag aube also defines (notably -h or --help), or to force
every following argument to the script unchanged.

Aube reserves exact -h for its own help. Without --, use --hint, -H, or
-h="..."; -h "..." works after -- or when invoking the script directly.

Proposals are written to generated/proposals/upwork-<slug>.md and .json, and
copied to the clipboard by default.

Examples:
  aube run proposal https://www.upwork.com/jobs/Example_~022119...
  aube run proposal job.md --rate 85 --client client.txt
  aube run proposal job.md --profile https://www.upwork.com/freelancers/~01fbe...
  aube run proposal upwork-job -q "How would you approach this?" --name short
  aube run proposal -- job.md -h "Emphasize the Kafka work"`);
}

function fail(message) {
  console.error(`proposal: ${message}`);
  process.exit(1);
}
