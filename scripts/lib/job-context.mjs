import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { readJobInput, slugify } from './job-input.mjs';
import {
  findCacheByPdf,
  findCachedJobByAlias,
  listCachedJobs,
} from './output-paths.mjs';
import {
  loadGithub,
  loadLocal,
  selectProjects,
  shouldSyncGithub,
  shouldSyncLocal,
} from './github-projects.mjs';

/**
 * Resolve a job from a URL, file, generated-resume slug, or the most recent
 * tailor run. Shared by the answer and proposal commands.
 */
export async function resolveJob(
  opts,
  { rootDir, cacheRoot, resumeOutputDir, log = console.log } = {},
) {
  const requestedSlug = opts.slug
    ? slugify(opts.slug).replace(/^resume-/, '')
    : '';

  if (opts.input) {
    const inputPath = resolve(process.cwd(), opts.input);
    const inputIsFile = existsSync(inputPath) && statSync(inputPath).isFile();
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
          slug: requestedSlug || basename(inputPath).replace(/^resume-/, ''),
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
          job: applyOverrides(await readJobInput({ input: cached.jobPath }), opts),
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
    const savedPath = join(cacheRoot, `resume-${candidateSlug}`, 'job.md');
    if (existsSync(savedPath)) {
      return {
        job: applyOverrides(await readJobInput({ input: savedPath }), opts),
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
        job: applyOverrides(await readJobInput({ input: alias.jobPath }), opts),
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

    const savedPath = join(cacheRoot, `resume-${requestedSlug}`, 'job.md');
    if (existsSync(savedPath)) {
      return {
        job: applyOverrides(await readJobInput({ input: savedPath }), opts),
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
        job: applyOverrides(await readJobInput({ input: alias.jobPath }), opts),
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

  const latest = findLatestTailorRun({ rootDir, cacheRoot, resumeOutputDir });
  if (latest) {
    log(`no job specified; using last tailor run: ${latest.slug}`);
    return {
      job: await readJobInput({ input: latest.jobPath }),
      slug: latest.slug,
    };
  }

  throw new Error(
    'Provide a job URL, a job file, or --slug for an existing generated resume. No previous tailor run is available to reuse.',
  );
}

export function findLatestTailorRun({ rootDir, cacheRoot, resumeOutputDir }) {
  const runs = listCachedJobs({ rootDir, cacheRoot, resumeOutputDir })
    .map((job) => ({
      ...job,
      mtime: existsSync(job.pdfPath)
        ? statSync(job.pdfPath).mtimeMs
        : statSync(job.jobPath).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  return runs[0] ?? null;
}

export function applyOverrides(job, opts) {
  return {
    ...job,
    title: opts.title?.trim() || job.title,
    company: opts.company?.trim() || job.company,
    url: opts.url?.trim() || job.url,
  };
}

export async function resolveGithubCandidates(
  opts,
  careerData,
  jobData,
  { rootDir, scriptsDir, log = console.log, warn = console.warn } = {},
) {
  const githubPath = resolve(rootDir, 'data/github.json');
  let githubSynced = false;

  if (
    !opts.noSync &&
    (opts.refresh || shouldSyncGithub(githubPath, { noSync: opts.noSync }))
  ) {
    log(
      opts.refresh
        ? 'refreshing GitHub/org and local project sources'
        : 'GitHub data is missing or older than 24 hours; syncing',
    );
    const sync = spawnSync(
      process.execPath,
      [resolve(scriptsDir, 'sync-github.mjs')],
      { cwd: rootDir, stdio: 'inherit' },
    );
    githubSynced = sync.status === 0;
    if (!githubSynced) {
      warn('GitHub/org sync failed; continuing with local project scan.');
    }
  }

  const localPath = resolve(rootDir, 'data/local-projects.json');
  if (
    !opts.noSync &&
    !githubSynced &&
    (opts.refresh || shouldSyncLocal(localPath, { noSync: opts.noSync }))
  ) {
    log('rescanning local projects');
    const sync = spawnSync(
      process.execPath,
      [resolve(scriptsDir, 'sync-local-projects.mjs')],
      { cwd: rootDir, stdio: 'inherit' },
    );
    if (sync.status !== 0) {
      warn('local project sync failed; continuing without local candidates.');
    }
  }

  const github = loadGithub(githubPath);
  const local = loadLocal(localPath);
  if (!github && !local) {
    warn(
      'no project metadata found; run `aube run sync-github` to include GitHub and local projects.',
    );
    return [];
  }
  return selectProjects(github, local, careerData, jobData);
}

export function readTextInput(value) {
  if (!value) return '';
  const path = resolve(process.cwd(), value);
  if (existsSync(path) && statSync(path).isFile()) {
    return readFileSync(path, 'utf8').trim();
  }
  return String(value).trim();
}

export function readOptionalJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid JSON in ${path}: ${error.message}`);
  }
}
