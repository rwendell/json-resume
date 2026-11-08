#!/usr/bin/env node
/**
 * Tailor a JSON Resume to a job description using OpenCode.
 *
 * Usage:
 *   aube run tailor -- job.md
 *   aube run tailor -- https://example.com/jobs/123
 *   aube run tailor -- --title "Forward Deployed Engineer" --company Acme --description job.txt
 *
 * The command is intentionally thin: OpenCode does the judgement, while this
 * script owns input handling, file layout, validation, and rendering.
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
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
} from './lib/github-projects.mjs';
import { LlmError, runAgent } from './lib/llm.mjs';
import { openFile } from './lib/open-file.mjs';
import { applyBasicsUrlPolicy } from './lib/resume-basics.mjs';
import { filterExcludedSkills } from './lib/resume-skills.mjs';
import { hasTraceCoverage } from './lib/resume-trace.mjs';
import {
  normalizeNumberSpacing,
  normalizeThemePunctuation,
} from './lib/resume-format.mjs';
import {
  choosePdfPath,
  readCacheMeta,
  repoRelative,
  writeCacheMeta,
} from './lib/output-paths.mjs';
import {
  TRIM_PLANS,
  appendAchievement,
  collectUnusedAchievements,
  removeLastHighlight,
  trimResume,
} from './lib/one-page.mjs';
import {
  MIN_FILL_HEIGHT,
  PAGE_CONTENT_HEIGHT,
  createPageMeasurer,
} from './lib/page-fill.mjs';
import { getPdfPageCount } from './lib/pdf.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  printHelp();
  process.exit(0);
}

if (!options.generic && !options.input && !options.description && !options.url) {
  options.generic = true;
  options.genericAuto = true;
}

let career;
try {
  career = loadCareer(rootDir).career;
} catch (error) {
  fail(error.message);
}

let job;
if (options.generic) {
  if (options.input) {
    fail('--generic builds a general resume and does not take a job file or URL.');
  }
  if (options.genericAuto) {
    console.log('tailor: no job source provided; building the generic resume');
  }
  const generic = career.generic ?? {};
  job = {
    title: options.title || generic.title || 'Software Engineer',
    company: options.company || '',
    url: options.url || '',
    body:
      options.description ||
      generic.description ||
      'Build a general-purpose software engineering resume using the strongest and most broadly relevant evidence in the fact bank.',
    source: 'generic',
  };
} else {
  try {
    job = await readJobInput(options);
  } catch (error) {
    fail(error.message);
  }
}

if (!job.title) {
  fail(
    'Could not determine a job title. Add a title to the job file frontmatter or pass --title.',
  );
}

const rawSlug = options.slug
  ? slugify(options.slug)
  : options.generic
    ? 'generic'
    : slugify([job.company, job.title].filter(Boolean).join(' ')) ||
      'application';
const slug = rawSlug.replace(/^resume-/, '');
const resumeOutputDir = resolve(rootDir, 'generated', 'resumes');
const cacheRoot = resolve(rootDir, '.cache', 'tailor');
const cacheDir = join(cacheRoot, `resume-${slug}`);
const previousMeta = readCacheMeta(cacheDir);
const previousPdfPath = previousMeta?.pdf
  ? resolve(rootDir, previousMeta.pdf)
  : null;
const resumePath = join(cacheDir, 'resume.json');
const tracePath = join(cacheDir, 'trace.json');
const requirementsPath = join(cacheDir, 'requirements.json');
const candidatesPath = join(cacheDir, 'github-candidates.json');
const jobPath = join(cacheDir, 'job.md');

mkdirSync(resumeOutputDir, { recursive: true });
mkdirSync(cacheDir, { recursive: true });

const pdfChoice = options.generic
  ? {
      pdfPath: join(resumeOutputDir, `resume-${slug}.pdf`),
      companySlug: slug,
      multiple: false,
    }
  : choosePdfPath({
      rootDir,
      resumeOutputDir,
      cacheRoot,
      cacheDir,
      slug,
      job,
    });
const pdfPath = pdfChoice.pdfPath;

writeFileSync(jobPath, formatJobMarkdown(job));

const githubPath = resolve(rootDir, 'data/github.json');
let githubSynced = false;

if (
  !options.noSync &&
  (options.refresh ||
    shouldSyncGithub(githubPath, { noSync: options.noSync }))
) {
  console.log(
    options.refresh
      ? 'tailor: refreshing GitHub/org and local project sources'
      : 'tailor: GitHub data is missing or older than 24 hours; syncing',
  );
  const sync = spawnSync(
    process.execPath,
    [resolve(__dirname, 'sync-github.mjs')],
    { cwd: rootDir, stdio: 'inherit' },
  );
  githubSynced = sync.status === 0;
  if (!githubSynced) {
    console.warn(
      'tailor: GitHub/org sync failed; continuing with local project scan.',
    );
  }
}

const localPath = resolve(rootDir, 'data/local-projects.json');
if (!options.noSync && !githubSynced) {
  console.log('tailor: rescanning local projects');
  const sync = spawnSync(
    process.execPath,
    [resolve(__dirname, 'sync-local-projects.mjs')],
    { cwd: rootDir, stdio: 'inherit' },
  );
  if (sync.status !== 0) {
    console.warn(
      'tailor: local project sync failed; continuing without local candidates.',
    );
  }
}

const github = loadGithub(githubPath);
const local = loadLocal(localPath);
if (!github && !local) {
  console.warn(
    'tailor: no project metadata found; run `aube run sync-github` to include GitHub and local projects.',
  );
}

const projectCandidates = selectProjects(github, local, career, job);
writeFileSync(
  candidatesPath,
  `${JSON.stringify(projectCandidates, null, '\t')}\n`,
);
const prompt = buildPrompt({ career, projectCandidates, job, slug });

console.log(`tailor: ${job.company ? `${job.company} — ` : ''}${job.title}`);
console.log(`tailor: output ${resumePath}`);
console.log(
  `tailor: ${projectCandidates.length} project candidate(s); asking the model for a draft`,
);

const started = Date.now();
let generated;
try {
  generated = runAgent({
    prompt,
    agent: 'resume-tailor',
    title: `Tailor: ${slug}`,
    timeout: options.timeout,
    cwd: rootDir,
    provider: options.provider,
    model: options.model,
    accept: (value) =>
      value &&
      typeof value.resume === 'object' &&
      value.resume !== null &&
      typeof value.trace === 'object' &&
      value.trace !== null &&
      hasTraceCoverage(value.resume, value.trace),
    onAttempt: ({ phase, label, reason, index, total }) => {
      if (phase !== 'failed') return;
      const next = index + 1 < total ? '; trying the next provider' : '';
      console.warn(`tailor: ${label} failed: ${reason}${next}`);
    },
  });
} catch (error) {
  const raw = error.raw || '';
  if (raw || options.debug) {
    writeFileSync(join(cacheDir, 'opencode-output.jsonl'), raw);
  }
  if (!(error instanceof LlmError)) fail(error.message);

  const saved = raw
    ? ` Raw output saved to ${join(cacheDir, 'opencode-output.jsonl')}.`
    : '';
  fail(`${error.message}${saved}`);
}

const output = generated.output;
if (!output.resume || typeof output.resume !== 'object') {
  fail('Model response is missing the "resume" object.');
}
if (!output.trace || typeof output.trace !== 'object') {
  fail('Model response is missing the "trace" object.');
}

const providerLabel = generated.model
  ? `${generated.provider.label} (${generated.model})`
  : `${generated.provider.label} (default model)`;
console.log(`tailor: draft from ${providerLabel}`);
if (generated.stats?.cost > 0) {
  const tokens =
    generated.stats.input != null
      ? `, ${generated.stats.input} in / ${generated.stats.output ?? '?'} out tokens`
      : '';
  console.log(`tailor: model cost $${generated.stats.cost.toFixed(4)}${tokens}`);
}

if (!output.resume.$schema) {
  output.resume.$schema =
    'https://raw.githubusercontent.com/jsonresume/resume-schema/master/schema.json';
}

if (normalizeNumberSpacing(output.resume)) {
  console.log('tailor: normalized decimal spacing in generated text');
}

if (normalizeThemePunctuation(output.resume)) {
  console.log(
    'tailor: removed terminal punctuation from project highlights/skills for this theme',
  );
}

const basicsChange = applyBasicsUrlPolicy(output.resume, career);
if (basicsChange) console.log(`tailor: ${basicsChange}`);

const removedSkills = filterExcludedSkills(output.resume, career);
if (removedSkills.length > 0) {
  console.log(
    `tailor: removed vague skills from the skills section: ${removedSkills.join(', ')}`,
  );
}

writeFileSync(resumePath, `${JSON.stringify(output.resume, null, '\t')}\n`);
writeFileSync(tracePath, `${JSON.stringify(output.trace, null, '\t')}\n`);
if (Array.isArray(output.trace.requirements)) {
  writeFileSync(
    requirementsPath,
    `${JSON.stringify(output.trace.requirements, null, '\t')}\n`,
  );
}
if (options.debug) {
  writeFileSync(join(cacheDir, 'opencode-output.jsonl'), generated.raw || '');
  writeFileSync(join(cacheDir, 'prompt.txt'), prompt);
}

writeCacheMeta(cacheDir, {
  slug,
  company: job.company,
  title: job.title,
  pdf: repoRelative(rootDir, pdfPath),
  provider: generated.provider.label,
  model: generated.model,
  cost: generated.stats?.cost ?? 0,
  updatedAt: new Date().toISOString(),
});

const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(
  `tailor: wrote ${basename(resumePath)} and ${basename(tracePath)} in ${seconds}s`,
);

if (options.render) {
  await ensureOnePage({
    resume: output.resume,
    trace: output.trace,
    resumePath,
    tracePath,
    pdfPath,
    theme: options.theme,
    career,
  });
}

const verify = spawnSync(
  process.execPath,
  [resolve(__dirname, 'verify-resume.mjs'), resumePath],
  { cwd: rootDir, stdio: 'inherit' },
);
if (verify.status !== 0) {
  console.error(
    `tailor: verification failed. Files are preserved in ${cacheDir} for review.`,
  );
  process.exit(1);
}

if (options.publish) {
  if (!options.render) {
    console.log('tailor: publish skipped because --no-render was used');
  } else {
    const target = findPublishTarget({
      career,
      job,
      generic: options.generic,
    });
    if (target) {
      publishResume({
        target,
        resume: output.resume,
        resumePath,
        pdfPath,
        theme: options.theme,
      });
    } else {
      console.log(
        'tailor: no matching src resume; generated resume kept private',
      );
    }
  }
}

if (
  options.render &&
  previousPdfPath &&
  resolve(previousPdfPath) !== resolve(pdfPath) &&
  existsSync(previousPdfPath) &&
  existsSync(pdfPath)
) {
  const previousName = basename(previousPdfPath);
  const companyPrefix = pdfChoice.companySlug
    ? `resume-${pdfChoice.companySlug}`
    : 'resume-';
  if (previousName.startsWith(companyPrefix)) {
    rmSync(previousPdfPath, { force: true });
  }
}

if (options.cleanCache) {
  if (options.render) {
    rmSync(cacheDir, { recursive: true, force: true });
    console.log(`tailor: removed intermediate cache ${cacheDir}`);
  } else {
    console.warn('tailor: --clean-cache ignored because --no-render leaves JSON as the deliverable');
  }
}

if (options.render) {
  if (options.open) openPreview(pdfPath);
} else if (options.open) {
  console.log('tailor: preview skipped because --no-render was used');
}

const deliverable = options.render ? pdfPath : resumePath;
console.log(`tailor: done — ${deliverable}`);

function parseArgs(argv) {
  const parsed = {
    render: true,
    open: true,
    force: false,
    cleanCache: false,
    generic: false,
    publish: true,
    refresh: false,
    debug: false,
    theme: 'jsonresume-theme-straightforward',
    timeout: 10 * 60 * 1000,
  };
  const positionals = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--help':
      case '-h':
        parsed.help = true;
        break;
      case '--company':
        parsed.company = argv[++i];
        break;
      case '--generic':
        parsed.generic = true;
        break;
      case '--title':
        parsed.title = argv[++i];
        break;
      case '--slug':
        parsed.slug = argv[++i];
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
      case '--theme':
        parsed.theme = argv[++i];
        break;
      case '--timeout':
        parsed.timeout = Number(argv[++i]) * 1000;
        break;
      case '--no-render':
        parsed.render = false;
        break;
      case '--no-open':
        parsed.open = false;
        break;
      case '--clean-cache':
        parsed.cleanCache = true;
        break;
      case '--refresh':
        parsed.refresh = true;
        break;
      case '--no-publish':
        parsed.publish = false;
        break;
      case '--no-sync':
        parsed.noSync = true;
        break;
      case '--force':
        parsed.force = true;
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

function buildPrompt({ career, projectCandidates, job, slug }) {
  return [
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
    JSON.stringify(projectCandidates, null, 2),
    '</project_candidates>',
    '',
    'The project entries above are candidates, not verified facts. They may come',
    'from personal GitHub, organizations, or local ~/projects repositories. Use a',
    'candidate only when it directly demonstrates a requirement and its README or',
    'local commit context supports the claim. Cite the entry\'s `evidence` value.',
    'Do not include a candidate merely because it is recent or pinned.',
    '',
    `Tailor the resume for the ${job.title} role${job.company ? ` at ${job.company}` : ''}.`,
    job.source === 'generic'
      ? 'This is a general-purpose resume, not a specific job. Follow the generic prioritization criteria in the job description.'
      : '',
    'Return the JSON object described in your system prompt. Output JSON only.',
  ].join('\n');
}

function findPublishTarget({ career, job, generic }) {
  const srcDir = resolve(rootDir, 'src');
  if (!existsSync(srcDir)) return null;

  const files = readdirSync(srcDir).filter((file) =>
    file.endsWith('.json'),
  );

  if (generic) {
    const configured = String(
      career.generic?.publishAs || 'software-engineer',
    ).replace(/\.json$/i, '');
    const name = slugify(configured);
    const file = `${name}.json`;
    const path = join(srcDir, file);
    return files.includes(file) ? { name, path } : null;
  }

  const title = normalizeTitle(job.title);
  const titleSlug = slugify(job.title);
  let labelMatch = null;
  let fileMatch = null;

  for (const file of files) {
    const name = basename(file, '.json');
    const path = join(srcDir, file);
    if (name === titleSlug) fileMatch = { name, path };

    try {
      const label = JSON.parse(readFileSync(path, 'utf8')).basics?.label;
      if (label && normalizeTitle(label) === title) {
        labelMatch = { name, path };
      }
    } catch {
      // Ignore malformed manual resumes.
    }
  }

  return labelMatch || fileMatch || null;
}

function normalizeTitle(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function publishResume({ target, resume, resumePath, pdfPath, theme }) {
  const distDir = resolve(rootDir, 'dist', target.name);
  const distHtml = join(distDir, `${target.name}.html`);
  const distPdf = join(distDir, `${target.name}.pdf`);
  mkdirSync(distDir, { recursive: true });

  console.log(
    `tailor: publishing to src/${target.name}.json and dist/${target.name}/`,
  );

  const html = spawnSync(
    'aube',
    [
      'exec',
      '--no-install',
      '--',
      'resumed',
      'render',
      resumePath,
      '-o',
      distHtml,
      '-t',
      theme,
    ],
    { cwd: rootDir, stdio: 'inherit' },
  );
  if (html.status !== 0) fail('Published HTML rendering failed.');

  try {
    copyFileSync(pdfPath, distPdf);
  } catch (error) {
    fail(`Could not copy the published PDF: ${error.message}`);
  }

  const published = {
    ...resume,
    meta: {
      ...(resume.meta ?? {}),
      theme,
    },
  };
  writeFileSync(target.path, `${JSON.stringify(published, null, '\t')}\n`);

  const index = spawnSync(
    process.execPath,
    [resolve(__dirname, 'build.mjs'), 'index'],
    { cwd: rootDir, stdio: 'inherit' },
  );
  if (index.status !== 0) fail('Published index regeneration failed.');

  console.log(`tailor: published ${target.name} to src/ and dist/`);
}

function openPreview(pdfPath) {
  if (!existsSync(pdfPath)) {
    console.warn('tailor: no PDF available to preview.');
    return;
  }

  console.log(`tailor: opening preview ${pdfPath}`);
  const result = openFile(pdfPath);
  if (!result.opened) {
    console.warn(
      `tailor: could not open a preview with ${result.attempts.join(', ')}. Open ${pdfPath} manually or pass --no-open.`,
    );
  }
}

function renderPdf(resumePath, pdfPath, theme) {
  console.log('tailor: rendering PDF');
  const pdf = spawnSync(
    'aube',
    [
      'exec',
      '--no-install',
      '--',
      'resumed',
      'export',
      resumePath,
      '-o',
      pdfPath,
      '-t',
      theme,
      '--puppeteer-arg=--no-sandbox',
    ],
    { cwd: rootDir, stdio: 'inherit' },
  );
  if (pdf.status !== 0 || !existsSync(pdfPath)) {
    fail('PDF rendering failed.');
  }
}

async function ensureOnePage({
  resume,
  trace,
  resumePath,
  tracePath,
  pdfPath,
  theme,
  career,
}) {
  const htmlPath = join(cacheDir, 'measure.html');
  let measurer;
  try {
    measurer = await createPageMeasurer();
  } catch (error) {
    fail(`Could not start page measurement: ${error.message}`);
  }

  try {
    renderHtml(resumePath, htmlPath, theme);
    let height = await measurer.measure(htmlPath);
    console.log(
      `tailor: draft fill ${Math.round(height)}px (page ${PAGE_CONTENT_HEIGHT}px)`,
    );

    let pages = null;
    if (height <= PAGE_CONTENT_HEIGHT) {
      renderPdf(resumePath, pdfPath, theme);
      pages = await readPageCount(pdfPath);
      if (pages === 1) {
        console.log('tailor: PDF is 1 page');
        await ensureFilled({
          resume,
          trace,
          resumePath,
          tracePath,
          pdfPath,
          theme,
          career,
          measurer,
          htmlPath,
          initialHeight: height,
        });
        return;
      }
      console.log(
        `tailor: HTML fits but PDF is ${pages} pages; continuing to trim`,
      );
    } else {
      console.log(
        `tailor: draft is over one page (${Math.round(height)}px); trimming`,
      );
    }

    for (let level = 0; level < TRIM_PLANS.length; level += 1) {
      if (!trimResume(resume, trace, level)) continue;

      writeResumeFiles(resume, trace, resumePath, tracePath);
      renderHtml(resumePath, htmlPath, theme);
      height = await measurer.measure(htmlPath);
      if (height > PAGE_CONTENT_HEIGHT) {
        console.log(
          `tailor: trim attempt ${level + 1}: ${Math.round(height)}px; still too tall`,
        );
        continue;
      }

      renderPdf(resumePath, pdfPath, theme);
      pages = await readPageCount(pdfPath);
      if (pages === 1) {
        console.log('tailor: PDF now fits on one page');
        await ensureFilled({
          resume,
          trace,
          resumePath,
          tracePath,
          pdfPath,
          theme,
          career,
          measurer,
          htmlPath,
          initialHeight: height,
        });
        return;
      }
      console.log(
        `tailor: trim attempt ${level + 1}: HTML fits but PDF is ${pages} pages`,
      );
    }

    fail(
      pages == null
        ? `Resume is still too tall after trimming. Files are preserved in ${cacheDir}.`
        : `PDF is still ${pages} pages after trimming. Tailored resumes must be exactly one page. Files are preserved in ${cacheDir}.`,
    );
  } finally {
    if (measurer) await measurer.close();
    rmSync(htmlPath, { force: true });
  }
}

async function ensureFilled({
  resume,
  trace,
  resumePath,
  tracePath,
  pdfPath,
  theme,
  career,
  measurer,
  htmlPath,
  initialHeight,
}) {
  try {
    let height = initialHeight;
    console.log(
      `tailor: content fill ${Math.round(height)}px (minimum ${MIN_FILL_HEIGHT}px, page ${PAGE_CONTENT_HEIGHT}px)`,
    );
    if (height >= MIN_FILL_HEIGHT) return;

    const candidates = collectUnusedAchievements(career, trace);
    console.log(
      `tailor: page is sparse; trying ${candidates.length} unused achievement(s)`,
    );

    for (const candidate of candidates) {
      const insertion = appendAchievement(resume, trace, candidate);
      if (!insertion) continue;

      writeResumeFiles(resume, trace, resumePath, tracePath);
      renderHtml(resumePath, htmlPath, theme);
      const next = await measurer.measure(htmlPath);

      if (next > PAGE_CONTENT_HEIGHT) {
        removeLastHighlight(resume, trace, insertion.index);
        writeResumeFiles(resume, trace, resumePath, tracePath);
        continue;
      }

      height = next;
      console.log(
        `tailor: added ${candidate.achievement.id}; fill ${Math.round(height)}px`,
      );
      if (height >= MIN_FILL_HEIGHT) break;
    }

    if (height < MIN_FILL_HEIGHT) {
      renderPdf(resumePath, pdfPath, theme);
      fail(
        `PDF fits on one page but is too sparse (${Math.round(height)}px; minimum ${MIN_FILL_HEIGHT}px). Add more achievements to data/career.yml or data/career.private.yml. Files are preserved in ${cacheDir}.`,
      );
    }

    renderPdf(resumePath, pdfPath, theme);
    const pages = await readPageCount(pdfPath);
    if (pages !== 1) {
      fail(
        `PDF is ${pages} pages after filling. Files are preserved in ${cacheDir}.`,
      );
    }
  } catch (error) {
    fail(`Could not measure page fill: ${error.message}`);
  }
}

async function readPageCount(pdfPath) {
  try {
    return await getPdfPageCount(pdfPath);
  } catch (error) {
    fail(`Could not read the PDF page count: ${error.message}`);
  }
}

function writeResumeFiles(resume, trace, resumePath, tracePath) {
  writeFileSync(resumePath, `${JSON.stringify(resume, null, '\t')}\n`);
  writeFileSync(tracePath, `${JSON.stringify(trace, null, '\t')}\n`);
}

function renderHtml(resumePath, htmlPath, theme) {
  const result = spawnSync(
    'aube',
    [
      'exec',
      '--no-install',
      '--',
      'resumed',
      'render',
      resumePath,
      '-o',
      htmlPath,
      '-t',
      theme,
    ],
    { cwd: rootDir, stdio: 'ignore' },
  );
  if (result.status !== 0 || !existsSync(htmlPath)) {
    fail('Could not render HTML for page measurement.');
  }
}

function printHelp() {
  console.log(`Usage:
  aube run tailor -- <job.md | job-url> [options]
  aube run tailor -- --title "<title>" [--company "<company>"] [--description <file|text|url>]
  aube run tailor [options]        # no job source -> generic resume

Options:
  --title <text>         Job title (overrides page/file metadata)
  --company <text>       Company name
  --generic              Build a general-purpose resume from the fact bank
                         (default when no job file, URL, or description is given)
  --url <url>            Job posting URL (also fetched when used alone)
  --description <value>  Job description text, file path, or URL
  --slug <name>          Cache/application slug (default: company-title)
  --provider <name>      Model provider: auto, opencode, go, openrouter (default: auto)
  --model <model>        Use one exact model and skip provider fallback
  --theme <package>      JSON Resume theme (default: jsonresume-theme-straightforward)
  --timeout <seconds>    Per-provider timeout (default: 600; OpenRouter primary capped at 120)
  --no-render            Skip PDF rendering (keeps cache JSON)
  --no-open              Do not open the rendered PDF preview
  --clean-cache          Delete intermediate JSON after a successful run
  --refresh              Force a GitHub/org + local project refresh
  --no-publish           Keep the generated resume private (do not update src/dist)
  --no-sync              Skip the 24-hour GitHub metadata refresh
  --force                Deprecated; generated resumes always overwrite
  --debug                Save the prompt and raw OpenCode output

PDF: resume-<company>.pdf, or resume-<company>-<title>.pdf when the company has multiple generated jobs.
Intermediate JSON is kept in .cache/tailor/resume-<slug>/ and overwritten on each run.

Examples:
  aube run tailor --generic
  aube run tailor -- https://boards.example.com/acme/jobs/123
  aube run tailor -- job.md
  aube run tailor -- --company "Acme" --title "Forward Deployed Engineer" --description job.txt
  aube run tailor -- job.md --provider go
  aube run tailor -- https://example.com/job --model anthropic/claude-sonnet-5-5`);
}

function fail(message) {
  console.error(`tailor: ${message}`);
  process.exit(1);
}
