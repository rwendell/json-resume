import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { splitFrontmatter, slugify } from './job-input.mjs';

export function readCacheMeta(cacheDir) {
  const path = join(cacheDir, 'meta.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function writeCacheMeta(cacheDir, meta) {
  writeFileSync(
    join(cacheDir, 'meta.json'),
    `${JSON.stringify(meta, null, '\t')}\n`,
  );
}

export function repoRelative(rootDir, filePath) {
  return relative(rootDir, filePath).split(sep).join('/');
}

export function companyFileSlug(company) {
  let value = String(company ?? '').trim();
  value = value.replace(/^\d{2,}\s+/, '');
  value = value.replace(
    /^(United States|US|USA|Canada|UK|United Kingdom|Remote)\s*[-–—]\s*/i,
    '',
  );
  value = value.replace(
    /\s*[-–—]\s*(Inc\.?|LLC|Ltd\.?|Corp\.?|Corporation|Company)$/i,
    '',
  );
  value = value.replace(
    /,\s*(Inc\.?|LLC|Ltd\.?|Corp\.?|Corporation|Company)$/i,
    '',
  );
  return slugify(value) || slugify(company);
}

export function getCachePdfPath({ rootDir, resumeOutputDir, meta, slug }) {
  if (meta?.pdf) return resolve(rootDir, meta.pdf);
  return join(resumeOutputDir, `resume-${slug}.pdf`);
}

export function listCachedJobs({ rootDir, cacheRoot, resumeOutputDir }) {
  if (!existsSync(cacheRoot)) return [];

  return readdirSync(cacheRoot, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && entry.name.startsWith('resume-'),
    )
    .map((entry) => {
      const cacheDir = join(cacheRoot, entry.name);
      const slug = entry.name.replace(/^resume-/, '');
      const jobPath = join(cacheDir, 'job.md');
      const resumePath = join(cacheDir, 'resume.json');
      const tracePath = join(cacheDir, 'trace.json');

      if (
        !existsSync(jobPath) ||
        !existsSync(resumePath) ||
        !existsSync(tracePath)
      ) {
        return null;
      }

      const meta = readCacheMeta(cacheDir);
      let company = meta?.company ?? '';
      let title = meta?.title ?? '';

      if (!company || !title) {
        try {
          const parsed = splitFrontmatter(readFileSync(jobPath, 'utf8'));
          company = company || parsed.meta.company || '';
          title =
            title ||
            parsed.meta.title ||
            parsed.meta.position ||
            '';
        } catch {
          // Keep whatever metadata is available.
        }
      }

      return {
        cacheDir,
        jobPath,
        slug,
        company: String(company),
        title: String(title),
        pdfPath: getCachePdfPath({
          rootDir,
          resumeOutputDir,
          meta,
          slug,
        }),
        meta,
      };
    })
    .filter(Boolean);
}

export function findCacheByPdf({
  rootDir,
  cacheRoot,
  resumeOutputDir,
  pdfPath,
}) {
  const target = resolve(pdfPath);
  return (
    listCachedJobs({ rootDir, cacheRoot, resumeOutputDir }).find(
      (job) => resolve(job.pdfPath) === target,
    ) ?? null
  );
}

export function findCachedJobByAlias({
  rootDir,
  cacheRoot,
  resumeOutputDir,
  alias,
}) {
  const normalized = slugify(
    String(alias).replace(/\.(json|pdf)$/i, ''),
  ).replace(/^resume-/, '');
  if (!normalized) return null;

  const pdfCandidate = join(
    resumeOutputDir,
    `resume-${normalized}.pdf`,
  );
  if (existsSync(pdfCandidate)) {
    const byPdf = findCacheByPdf({
      rootDir,
      cacheRoot,
      resumeOutputDir,
      pdfPath: pdfCandidate,
    });
    if (byPdf) return byPdf;
  }

  return (
    listCachedJobs({ rootDir, cacheRoot, resumeOutputDir }).find(
      (job) => companyFileSlug(job.company) === normalized,
    ) ?? null
  );
}

export function choosePdfPath({
  rootDir,
  resumeOutputDir,
  cacheRoot,
  cacheDir,
  slug,
  job,
}) {
  const companySlug = companyFileSlug(job.company);
  const titleSlug = slugify(job.title);
  const genericPath = companySlug
    ? join(resumeOutputDir, `resume-${companySlug}.pdf`)
    : null;
  const currentMeta = readCacheMeta(cacheDir);
  const currentPdf = currentMeta?.pdf
    ? resolve(rootDir, currentMeta.pdf)
    : null;
  const genericBelongsToCurrent =
    genericPath &&
    currentPdf &&
    resolve(currentPdf) === resolve(genericPath);

  const otherJobs = listCachedJobs({
    rootDir,
    cacheRoot,
    resumeOutputDir,
  }).filter(
    (entry) =>
      entry.slug !== slug &&
      companySlug &&
      companyFileSlug(entry.company) === companySlug,
  );

  const multiple =
    otherJobs.length > 0 ||
    (genericPath && existsSync(genericPath) && !genericBelongsToCurrent);

  const base = multiple
    ? [companySlug, titleSlug || slug].filter(Boolean).join('-')
    : companySlug || titleSlug || slug;
  const pdfPath = join(resumeOutputDir, `resume-${base}.pdf`);

  if (multiple && genericPath) {
    for (const other of otherJobs) {
      if (
        resolve(other.pdfPath) !== resolve(genericPath) ||
        !existsSync(genericPath)
      ) {
        continue;
      }

      const otherTitle = slugify(other.title) || other.slug;
      const renamed = join(
        resumeOutputDir,
        `resume-${companySlug}-${otherTitle}.pdf`,
      );
      if (resolve(renamed) === resolve(genericPath)) continue;

      renameSync(genericPath, renamed);
      writeCacheMeta(other.cacheDir, {
        ...(other.meta ?? {}),
        slug: other.slug,
        company: other.company,
        title: other.title,
        pdf: repoRelative(rootDir, renamed),
        updatedAt: new Date().toISOString(),
      });
    }

    if (
      genericBelongsToCurrent &&
      existsSync(genericPath) &&
      resolve(pdfPath) !== resolve(genericPath)
    ) {
      rmSync(genericPath, { force: true });
    }
  }

  return { pdfPath, companySlug, titleSlug, multiple };
}
