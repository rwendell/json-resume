import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { fetchJobPage, isUrl, JobPageError } from './job-page.mjs';

/**
 * Read a job from a URL, a file, inline text, or a combination.
 * Throws a friendly error instead of exiting so both the resume and answer
 * commands can decide how to present it.
 */
export async function readJobInput(opts) {
  let body = '';
  let source = opts.input || opts.description || opts.url || 'job';
  let meta = {};

  const urlSource = isUrl(opts.input)
    ? opts.input
    : isUrl(opts.description)
      ? opts.description
      : !opts.input && !opts.description && isUrl(opts.url)
        ? opts.url
        : '';

  if (urlSource) {
    try {
      const page = await fetchJobPage(urlSource);
      body = page.body;
      meta = {
        title: page.title,
        company: page.company,
        url: page.url,
      };
      source = urlSource;
    } catch (error) {
      if (error instanceof JobPageError) {
        throw new JobPageError(
          `${error.message}\nSave the job description to a file and pass the file path instead, or pass --title and --company with --description.`,
        );
      }
      throw error;
    }
  }

  if (opts.input && !isUrl(opts.input)) {
    const inputPath = resolve(process.cwd(), opts.input);
    if (!existsSync(inputPath)) {
      throw new Error(`Job file not found: ${inputPath}`);
    }
    source = inputPath;
    const raw = readFileSync(inputPath, 'utf8');
    const frontmatter = splitFrontmatter(raw);
    meta = frontmatter.meta;
    body = frontmatter.body;
  }

  if (opts.description && !isUrl(opts.description)) {
    const descriptionPath = resolve(process.cwd(), opts.description);
    body =
      existsSync(descriptionPath) && statSync(descriptionPath).isFile()
        ? readFileSync(descriptionPath, 'utf8')
        : opts.description;
    source = opts.description;
  }

  if (!body.trim() && opts.input && !isUrl(opts.input)) {
    body = readFileSync(resolve(process.cwd(), opts.input), 'utf8');
  }

  const title =
    opts.title ||
    meta.title ||
    meta.position ||
    firstHeading(body) ||
    '';
  const company = opts.company || meta.company || '';
  const url = opts.url || meta.url || (isUrl(source) ? source : '');

  return {
    title: String(title).trim(),
    company: String(company).trim(),
    url: String(url).trim(),
    body: body.trim(),
    source,
  };
}

export function splitFrontmatter(raw) {
  if (!raw.startsWith('---')) return { meta: {}, body: raw };
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };

  let meta = {};
  try {
    meta = parseYaml(match[1]) ?? {};
  } catch (error) {
    throw new Error(`Could not parse job frontmatter: ${error.message}`);
  }
  return { meta, body: match[2] };
}

export function firstHeading(text) {
  const match = text.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : '';
}

export function slugify(value) {
  return String(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70);
}

export function yamlString(value) {
  return JSON.stringify(String(value ?? ''));
}

export function formatJobMarkdown(job) {
  return [
    '---',
    `company: ${yamlString(job.company)}`,
    `title: ${yamlString(job.title)}`,
    `url: ${yamlString(job.url)}`,
    `captured: ${new Date().toISOString().slice(0, 10)}`,
    '---',
    '',
    job.body.trim(),
    '',
  ].join('\n');
}
