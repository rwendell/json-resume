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
  'upwork.com',
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

export function isUpworkUrl(value) {
  try {
    const host = new URL(String(value)).hostname.replace(/^www\./, '');
    return host === 'upwork.com' || host.endsWith('.upwork.com');
  } catch {
    return false;
  }
}

export function isUpworkSavedJobUrl(value) {
  return /^https?:\/\/(?:www\.)?upwork\.com\/nx\/search\/jobs\/saved\/details\//i.test(
    String(value ?? ''),
  );
}

export function isUpworkSearchUrl(value) {
  return /^https?:\/\/(?:www\.)?upwork\.com\/(?:nx\/search\/jobs|jobs\/search)(?:\/|\?|$)/i.test(
    String(value ?? ''),
  );
}

export async function fetchJobPage(
  url,
  { timeout = 20000, browserFallback = true } = {},
) {
  if (isUpworkSavedJobUrl(url)) {
    throw new JobPageError(
      'This is an Upwork saved-jobs modal URL that only works inside your logged-in Upwork session. Open the job and copy its public /jobs/... URL, or save the job description to a file and pass the file path instead.',
    );
  }
  if (isUpworkSearchUrl(url)) {
    throw new JobPageError(
      'This is an Upwork search URL, not a job posting. Open the job and copy its public /jobs/... URL, or save the job description to a file and pass the file path instead.',
    );
  }

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
  const html = await fetchRenderedHtml(url, { timeout });
  return extractJobFromHtml(html, url);
}

export async function fetchRenderedHtml(url, { timeout = 20000 } = {}) {
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
      // A slow page may still have rendered the content.
    }

    return await page.content();
  } finally {
    if (browser) await browser.close();
  }
}

export function extractJobFromHtml(html, url = '') {
  const $ = cheerio.load(html);
  const pageTitle = textOf($('title').first().text());
  const visibleText = $('body')
    .clone()
    .find('script, style, noscript')
    .remove()
    .end()
    .text();

  if (looksLikeBlockedPage(visibleText, pageTitle)) {
    throw new JobPageError(
      `Could not load ${url || 'the job page'}: the site returned a login or bot-check page. Save the job description to a file and pass the file path instead, or pass --title and --company with --description.`,
    );
  }

  if (isUpworkUrl(url)) {
    return extractUpworkJob($, url);
  }

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

function extractUpworkJob($, url) {
  const rawTitle =
    textOf($('h1').first().text()) || textOf($('title').first().text());
  const title = cleanUpworkTitle(rawTitle);
  if (/^search freelance jobs/i.test(title)) {
    throw new JobPageError(
      'This Upwork URL points at a search page, not a job posting. Open the job and copy its public /jobs/... URL, or save the job description to a file and pass the file path instead.',
    );
  }

  const posting = findJobPosting($);
  let body = posting?.description ? toText(posting.description) : '';
  if (!body) {
    const description = $('[data-test="Description"]').first();
    body = description.length
      ? toText(String(description.html() ?? '').replace(/\n/g, '<br>'))
      : '';
  }
  if (body.length < 80) {
    throw new JobPageError(
      `Could not extract the Upwork job description from ${url}. Upwork may be showing a bot check or a page that needs a logged-in session. Save the job text to a file and pass the file instead.`,
    );
  }

  return {
    title,
    company: '',
    body,
    url,
    source: 'url',
    details: extractUpworkDetails($),
  };
}

function extractUpworkDetails($) {
  const details = {};

  $('ul.features > li').each((_, element) => {
    const item = $(element);
    const fullText = normalizeText(item.text()).replace(/\s+/g, ' ').trim();
    const label = normalizeText(
      item.clone().find('strong').remove().end().text(),
    )
      .replace(/\s+/g, ' ')
      .replace(/^[-–—:\s]+/, '')
      .trim();
    let value = textOf(item.find('strong').first().text());
    if (label && fullText.toLowerCase().endsWith(label.toLowerCase())) {
      value = fullText.slice(0, -label.length).replace(/[-–—:\s]+$/, '').trim();
    }
    if (!value) return;

    const key = label.toLowerCase();
    if (key === 'duration') {
      details.duration = value;
    } else if (key === 'experience level') {
      details.experienceLevel = value;
    } else if (key === 'project type') {
      details.projectType = value;
    } else if (key === 'hourly' || key === 'fixed-price') {
      details.budgetType = key === 'fixed-price' ? 'fixed' : 'hourly';
      if (/^\$/.test(value)) details.budget = value;
      else details.workload = value;
    } else if (!key) {
      if (/hrs?\s*\/\s*week|hours?\s*\/\s*week/i.test(value)) {
        details.workload = value;
      } else if (/remote|onsite|hybrid/i.test(value)) {
        details.jobLocation = value;
      } else {
        details[label] = value;
      }
    } else {
      details[label] = value;
    }
  });

  const jobHeader = $('h1').first().closest('header');
  const posted = jobHeader.find('.posted-on-line').first().text();
  if (posted.trim()) details.posted = normalizeText(posted);

  const jobLocation = toText(jobHeader.find('p').first().html() ?? '').replace(
    /([.!?])(?=[A-Z])/g,
    '$1 ',
  );
  if (jobLocation) details.jobLocation = jobLocation;

  const skillsHeading = $('h3, h4, h5')
    .filter((_, element) => /skills and expertise/i.test($(element).text()))
    .first();
  if (skillsHeading.length) {
    const skills = [];
    skillsHeading
      .closest('section')
      .find('.air3-badge')
      .each((_, element) => {
        const text = textOf($(element).text()).replace(/\s+/g, ' ').trim();
        if (
          text &&
          !/^\+\s*\d+\s+more$/i.test(text) &&
          !skills.includes(text)
        ) {
          skills.push(text);
        }
      });
    if (skills.length > 0) details.skills = skills;
  }

  const clientSection = $('.cfe-about-client-v2').first();
  if (clientSection.length) {
    const client = toText(clientSection.html())
      .replace(/^About the client\s*/i, '')
      .replace(/\n\s*\*\s*/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/([A-Za-z])(\d{1,2}:\d{2})/g, '$1 $2')
      .trim();
    if (client) details.client = client;

    const location = toText(
      clientSection.find('[data-qa="client-location"]').html() ?? '',
    ).replace(/([A-Za-z])(\d{1,2}:\d{2})/g, '$1 $2');
    if (location) details.clientLocation = location;

    const memberSince = toText(
      clientSection.find('[data-qa="client-contract-date"]').html() ?? '',
    );
    if (memberSince) details.clientMemberSince = memberSince;
  }

  return details;
}

function cleanUpworkTitle(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\s*[|]\s*Upwork\s*$/i, '')
    .replace(/\s*-\s*Upwork\s*$/i, '')
    .trim();
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
      /\s*[|•-]\s*(LinkedIn|Indeed|Glassdoor|Greenhouse|Lever|Workday|Ashby|SmartRecruiters|Upwork)\b.*$/i,
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

function looksLikeBlockedPage(text, title = '') {
  if (
    /attention required!?\s*\|?\s*cloudflare|just a moment\.\.\.|cf-error-details|challenge-platform/i.test(
      title,
    )
  ) {
    return true;
  }
  if (
    /^\s*(?:please enable cookies\.?\s*)?sorry, you have been blocked|^\s*enable javascript and cookies to continue|^\s*verify you are human|^\s*access denied\b/i.test(
      text,
    )
  ) {
    return true;
  }
  if (text.length >= 500) return false;
  return /\b(sign in|log in|create an account|enable javascript|access denied|are you a robot)\b/i.test(
    text,
  );
}
