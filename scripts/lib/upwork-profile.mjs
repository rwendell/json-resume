import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import * as cheerio from 'cheerio';
import { slugify } from './job-input.mjs';
import { fetchRenderedHtml } from './job-page.mjs';

const CACHE_DIR = '.cache/upwork';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const COUNTRY_CODES = new Map([
  ['usa', 'US'],
  ['us', 'US'],
  ['united states', 'US'],
  ['united states of america', 'US'],
  ['uk', 'GB'],
  ['gb', 'GB'],
  ['united kingdom', 'GB'],
  ['great britain', 'GB'],
  ['canada', 'CA'],
  ['australia', 'AU'],
  ['germany', 'DE'],
  ['france', 'FR'],
  ['india', 'IN'],
  ['pakistan', 'PK'],
  ['philippines', 'PH'],
  ['nigeria', 'NG'],
  ['brazil', 'BR'],
  ['mexico', 'MX'],
  ['spain', 'ES'],
  ['netherlands', 'NL'],
  ['poland', 'PL'],
  ['ukraine', 'UA'],
]);

export function isUpworkProfileUrl(value) {
  return /^https?:\/\/(?:www\.)?upwork\.com\/freelancers\/[^/?#]+/i.test(
    String(value ?? ''),
  );
}

/**
 * Load a public Upwork profile, preferring a 24-hour cache. Public profile
 * values are defaults; data/upwork.yml and CLI flags override them.
 */
export async function loadUpworkProfile(
  url,
  { rootDir, refresh = false, timeout = 20000, log, warn } = {},
) {
  if (!isUpworkProfileUrl(url)) {
    throw new Error(
      `Not an Upwork profile URL: ${url}. Use https://www.upwork.com/freelancers/~...`,
    );
  }

  const cacheDir = resolve(rootDir, CACHE_DIR);
  const cachePath = join(cacheDir, `profile-${profileIdFromUrl(url)}.json`);
  const cached = readProfileCache(cachePath);
  const fresh =
    cached && Date.now() - cached.fetchedAtMs < CACHE_TTL_MS;

  if (!refresh && fresh) {
    log?.('using cached Upwork profile');
    return { ...cached.profile, cached: true, cachePath: repoPath(cachePath) };
  }

  try {
    const profile = await fetchUpworkProfile(url, { timeout });
    if (!profile.name || !profile.title) {
      throw new Error(
        `Could not extract a public Upwork profile from ${url}. The page may require login or a different URL.`,
      );
    }
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      cachePath,
      `${JSON.stringify(
        {
          url,
          fetchedAt: profile.fetchedAt,
          profile,
        },
        null,
        '\t',
      )}\n`,
    );
    return {
      ...profile,
      cached: false,
      cachePath: repoPath(cachePath),
    };
  } catch (error) {
    if (cached) {
      warn?.(
        `profile fetch failed (${error.message}); using cached profile from ${cached.profile.fetchedAt}`,
      );
      return {
        ...cached.profile,
        cached: true,
        stale: true,
        cachePath: repoPath(cachePath),
      };
    }
    throw error;
  }
}

export async function fetchUpworkProfile(url, { timeout = 20000 } = {}) {
  const html = await fetchRenderedHtml(url, { timeout });
  return extractUpworkProfile(html, url);
}

export function extractUpworkProfile(html, url) {
  const $ = cheerio.load(html);
  const person = findPerson($);

  const name =
    textOf(person?.name) || textOf($('h1').first().text());
  const title =
    textOf(person?.jobTitle) || titleFromDocument($);

  const locationEl = $('.d-flex.location').first();
  const city =
    textOf(
      locationEl
        .find('[data-test="location-city"], .location-city')
        .first()
        .text(),
    ) || textOf(person?.homeLocation?.address?.addressLocality);
  const region = textOf(
    locationEl
      .find('[data-test="location-state"], .location-state')
      .first()
      .text(),
  );
  const country =
    textOf(
      locationEl
        .find('[data-test="location-country"], .location-country')
        .first()
        .text(),
    ) || textOf(person?.homeLocation?.address?.addressCountry);
  const countryCode = normalizeCountryCode(
    textOf(person?.homeLocation?.address?.addressCountry) || country,
  );

  const rate = parseRate(textOf($('.overview-card').first().text()));
  const summary = textOf(
    $('[data-test="truncation-text-by-chars"]').first().text(),
  ).replace(/\s*Show more\s*$/i, '');

  const skills = Array.isArray(person?.skills)
    ? person.skills.map((skill) => String(skill).trim()).filter(Boolean)
    : [];

  const portfolio = [];
  const seen = new Set();
  $('.portfolio-v2-shelf-thumbnail').each((_, element) => {
    const item = $(element);
    const titleText =
      textOf(item.find('.mt-3x .no-underline').first().text()) ||
      textOf(item.find('.no-underline').first().text());
    if (!titleText) return;
    const key = titleText.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);

    const tags = [
      ...new Set(
        item
          .find('.skill-name')
          .map((_, tag) => textOf($(tag).text()))
          .get()
          .filter(Boolean),
      ),
    ];
    portfolio.push({
      title: titleText,
      tags,
      evidence: `profile:portfolio:${slugify(titleText)}`,
    });
  });

  const hoursPerWeek = extractHoursPerWeek(html);

  return {
    url,
    name,
    title,
    location: {
      city,
      region,
      countryCode,
    },
    rate,
    hoursPerWeek,
    summary,
    skills,
    portfolio,
    preferredSamples: portfolio.map((item) => item.evidence),
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Fill only the basics that the fact bank does not already provide. A private
 * career overlay still wins over the public profile.
 */
export function applyProfileToCareer(career, profile) {
  if (!profile) return career;

  const basics = { ...(career.basics ?? {}) };
  if (!basics.name && profile.name) basics.name = profile.name;
  if (!basics.label && profile.title) basics.label = profile.title;

  const location = { ...(basics.location ?? {}) };
  for (const key of ['city', 'region', 'countryCode']) {
    if (!location[key] && profile.location?.[key]) {
      location[key] = profile.location[key];
    }
  }
  if (Object.keys(location).length > 0) basics.location = location;

  career.basics = basics;
  return career;
}

/**
 * Map public portfolio titles to fact-bank or candidate evidence ids. Items
 * that do not match keep their profile:portfolio:<slug> evidence id.
 */
export function mapProfilePortfolio(profile, career, candidates) {
  if (!profile) return { portfolio: [], preferredSamples: [] };

  const projects = career.projects ?? [];
  const candidateList = candidates ?? [];

  const portfolio = (profile.portfolio ?? []).map((item) => {
    const key = slugify(item.title);
    const project = projects.find(
      (entry) =>
        slugify(entry.name) === key ||
        slugify(String(entry.repo ?? '').split('/').pop()) === key,
    );
    if (project?.id) {
      return { ...item, evidence: `project:${project.id}` };
    }

    const candidate = candidateList.find(
      (entry) =>
        slugify(entry.displayName || entry.name) === key ||
        slugify(entry.name) === key,
    );
    if (candidate?.evidence) {
      return { ...item, evidence: candidate.evidence };
    }

    return item;
  });

  return {
    portfolio,
    preferredSamples: [
      ...new Set(portfolio.map((item) => item.evidence).filter(Boolean)),
    ],
  };
}

export function profileEvidenceText(profile) {
  if (!profile) return '';
  const location = [
    profile.location?.city,
    profile.location?.region,
    profile.location?.countryCode,
  ]
    .filter(Boolean)
    .join(', ');

  return [
    profile.name ? `name: ${profile.name}` : '',
    profile.title ? `title: ${profile.title}` : '',
    location ? `location: ${location}` : '',
    profile.rate ? `rate: ${formatProfileRate(profile.rate)}` : '',
    profile.hoursPerWeek ? `hours per week: ${profile.hoursPerWeek}` : '',
    profile.summary ? `summary: ${profile.summary}` : '',
    profile.skills?.length
      ? `skills: ${profile.skills.join(', ')}`
      : '',
    ...(profile.portfolio ?? []).map(
      (item) =>
        `portfolio: ${item.title}${
          item.tags?.length ? ` (${item.tags.join(', ')})` : ''
        }`,
    ),
  ]
    .filter(Boolean)
    .join('\n');
}

function findPerson($) {
  let person = null;
  $('script[type="application/ld+json"]').each((_, element) => {
    if (person) return;
    try {
      const parsed = JSON.parse($(element).contents().text());
      const items = Array.isArray(parsed) ? parsed : [parsed];
      person =
        items.find(
          (item) =>
            String(item?.['@type'] ?? '').toLowerCase() === 'person',
        ) ?? null;
    } catch {
      // Ignore malformed JSON-LD.
    }
  });
  return person;
}

function titleFromDocument($) {
  const raw = textOf($('title').first().text()).replace(
    /\s*-\s*Upwork\s*$/i,
    '',
  );
  const parts = raw.split(/\s+-\s+/);
  return parts.length > 1 ? parts.slice(1).join(' - ').trim() : raw;
}

function parseRate(value) {
  const match = String(value ?? '').match(
    /([$€£])\s*([\d,]+(?:\.\d+)?)\s*\/\s*hr/i,
  );
  if (!match) return null;
  return {
    type: 'hourly',
    amount: Number(match[2].replace(/,/g, '')),
    currency: match[1] === '€' ? 'EUR' : match[1] === '£' ? 'GBP' : 'USD',
  };
}

function extractHoursPerWeek(html) {
  const match = String(html).match(
    /"(?:fullTime|partTime|asNeeded)","([^"]+)"/,
  );
  return match ? decodeUnicode(match[1]) : '';
}

function decodeUnicode(value) {
  try {
    return JSON.parse(`"${value}"`);
  } catch {
    return String(value);
  }
}

function normalizeCountryCode(value) {
  const key = String(value ?? '').trim().toLowerCase();
  if (!key) return '';
  return COUNTRY_CODES.get(key) || (key.length === 2 ? key.toUpperCase() : '');
}

function profileIdFromUrl(url) {
  const match = String(url).match(/\/freelancers\/([^/?#]+)/i);
  return slugify(match ? match[1] : url) || 'profile';
}

function readProfileCache(path) {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed?.profile) return null;
    return {
      ...parsed,
      fetchedAtMs: Date.parse(parsed.fetchedAt) || 0,
    };
  } catch {
    return null;
  }
}

function repoPath(cachePath) {
  return `${CACHE_DIR}/${basename(cachePath)}`.replace(/\\/g, '/');
}

function formatProfileRate(rate) {
  const symbol =
    rate.currency === 'EUR' ? '€' : rate.currency === 'GBP' ? '£' : '$';
  const amount = Number(rate.amount).toLocaleString('en-US', {
    maximumFractionDigits: 2,
  });
  return `${symbol}${amount}/hr`;
}

function textOf(value) {
  return String(value ?? '').trim();
}
