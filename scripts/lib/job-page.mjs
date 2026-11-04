import * as cheerio from 'cheerio';
import { htmlToText } from 'html-to-text';

const JOB_BOARD_HOSTS = [
  'greenhouse.io',
  'lever.co',
  'workday.com',
  'myworkdayjobs.com',
  'linkedin.com',
  'indeed.com',
  'glassdoor.com',
  'ashbyhq.com',
  'smartrecruiters.com',
  'jobvite.com',
  'icims.com',
  'taleo.net',
  'brassring.com',
  'recruitee.com',
  'workable.com',
];

const FETCH_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
  'accept-language': 'en-US,en;q=0.9',
};

export class JobPageError extends Error {}

export function isUrl(value) {
  return /^https?:\/\//i.test(String(value ?? '').trim());
}

export async function fetchJobPage(
  url,
  { timeout = 20000, browserFallback = true } = {},
) {
  try {
    return await fetchJobPageWithHttp(url, timeout);
  } catch (httpError) {
    if (!browserFallback) throw httpError;

    console.warn(
      `job-page: direct fetch failed (${httpError.message}); retrying with headless Chrome`,
    );
    try {
      return await fetchJobPageWithBrowser(url, timeout);
    } catch (browserError) {
      throw new JobPageError(
        `${httpError.message}\nHeadless browser fallback also failed: ${browserError.message}`,
      );
    }
  }
}

async function fetchJobPageWithHttp(url, timeout) {
  let response;
  try {
    response = await fetch(url, {
      redirect: 'follow',
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    if (error.name === 'TimeoutError') {
      throw new JobPageError(`Timed out after ${timeout}ms fetching ${url}`);
    }
    throw new JobPageError(`Could not fetch ${url}: ${error.message}`);
  }

  if (!response.ok) {
    throw new JobPageError(
      `Could not fetch ${url}: HTTP ${response.status} ${response.statusText}`,
    );
  }

  const contentType = response.headers.get('content-type') || '';
  if (!/text\/html|application\/xhtml|text\/plain/i.test(contentType)) {
    throw new JobPageError(
      `${url} returned ${contentType || 'an unknown content type'}, not an HTML job page.`,
    );
  }

  const html = await response.text();
  return extractJobFromHtml(html, url);
}

async function fetchJobPageWithBrowser(url, timeout) {
  let browser;
  try {
    const puppeteer = (await import('puppeteer')).default;
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.setUserAgent(FETCH_HEADERS['user-agent']);

    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout });
    } catch (error) {
      if (error.name !== 'TimeoutError') throw error;
      // A slow page may still have rendered the job content.
    }

    const html = await page.content();
    return extractJobFromHtml(html, url);
  } finally {
    if (browser) await browser.close();
  }
}

export function extractJobFromHtml(html, url = '') {
  const $ = cheerio.load(html);
  const posting = findJobPosting($);

  let title = posting ? textOf(posting.title) : '';
  let company = posting ? companyName(posting.hiringOrganization) : '';
  let descriptionHtml = posting ? textOf(posting.description) : '';

  if (!descriptionHtml) {
    $('script, style, noscript, iframe, svg, nav, header, footer, form, aside').remove();
    const main = $('main').length ? $('main') : $('article').length ? $('article') : $('body');
    descriptionHtml = main.html() ?? '';
  }

  if (!title) {
    title = attr($, 'meta[property="og:title"]', 'content') || textOf($('title').first().text());
  }
  if (!company) {
    company = attr($, 'meta[property="og:site_name"]', 'content');
  }
  if (!company) {
    company = splitTitleCompany(cleanTitle(title), '').company;
  }
  if (!company) {
    const host = safeHost(url);
    if (host && !isJobBoardHost(host)) company = host;
  }

  const normalizedTitle = splitTitleCompany(cleanTitle(title), company);
  title = normalizedTitle.title;
  company = normalizedTitle.company;

  const body = toText(descriptionHtml);
  if (body.length < 150 || looksLikeBlockedPage(body)) {
    throw new JobPageError(
      `Could not extract a job description from ${url}. The page may require JavaScript or login. Save the job text to a file and pass the file instead.`,
    );
  }

  return { title, company, body, url, source: 'url' };
}

function findJobPosting($) {
  const objects = [];

  $('script[type="application/ld+json"]').each((_, element) => {
    const raw = $(element).contents().text().trim();
    if (!raw) return;
    try {
      collectJsonLd(JSON.parse(raw), objects);
    } catch {
      // Ignore malformed JSON-LD.
    }
  });

  return (
    objects.find((object) =>
      types(object).some((type) => String(type).toLowerCase() === 'jobposting'),
    ) ?? null
  );
}

function collectJsonLd(value, out) {
  if (Array.isArray(value)) {
    for (const item of value) collectJsonLd(item, out);
    return;
  }
  if (!value || typeof value !== 'object') return;

  out.push(value);
  if (value['@graph']) collectJsonLd(value['@graph'], out);
}

function types(value) {
  const type = value?.['@type'];
  if (Array.isArray(type)) return type;
  return type ? [type] : [];
}

function companyName(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  return String(value.name ?? value.legalName ?? '').trim();
}

function splitTitleCompany(title, company) {
  const match = title.match(/^(.+?)\s+(?:at|@)\s+(.+)$/i);
  if (match) {
    return {
      title: match[1].trim(),
      company: company || match[2].trim(),
    };
  }
  return { title, company };
}

function cleanTitle(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^Job Application for\s+/i, '')
    .replace(
      /\s*[|•-]\s*(LinkedIn|Indeed|Glassdoor|Greenhouse|Lever|Workday|Ashby|SmartRecruiters)\b.*$/i,
      '',
    )
    .trim();
}

function toText(html) {
  if (!html) return '';
  if (!/<[a-z][\s\S]*>/i.test(html)) return normalizeText(html);

  const text = htmlToText(html, {
    wordwrap: false,
    selectors: [
      { selector: 'a', options: { ignoreHref: true } },
      { selector: 'img', format: 'skip' },
      { selector: 'h1', options: { uppercase: false } },
      { selector: 'h2', options: { uppercase: false } },
      { selector: 'h3', options: { uppercase: false } },
      { selector: 'h4', options: { uppercase: false } },
    ],
  });
  return normalizeText(text);
}

function normalizeText(text) {
  return String(text)
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function textOf(value) {
  return String(value ?? '').trim();
}

function attr($, selector, name) {
  return String($(selector).first().attr(name) ?? '').trim();
}

function safeHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function isJobBoardHost(host) {
  return JOB_BOARD_HOSTS.some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
}

function looksLikeBlockedPage(text) {
  if (text.length >= 500) return false;
  return /\b(sign in|log in|create an account|enable javascript|access denied|verify you are human|are you a robot)\b/i.test(
    text,
  );
}
