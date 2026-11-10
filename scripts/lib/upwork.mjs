import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

export const UPWORK_CONFIG_FILE = 'data/upwork.yml';
export const UPWORK_EXAMPLE_FILE = 'data/upwork.example.yml';

const DEFAULT_BANNED_PHRASES = [
  'I hope this message finds you well',
  'Dear Hiring Manager',
  'I am excited to apply',
  'I am the perfect fit',
  'I would be a great fit',
  'As an AI language model',
];

/**
 * Load Upwork proposal defaults from data/upwork.yml. The example file is a
 * fallback so a fresh clone still has sensible behavior.
 */
export function loadUpworkConfig(rootDir, { optional = true } = {}) {
  const configuredPath = resolve(rootDir, UPWORK_CONFIG_FILE);
  const examplePath = resolve(rootDir, UPWORK_EXAMPLE_FILE);
  const path = existsSync(configuredPath)
    ? configuredPath
    : existsSync(examplePath)
      ? examplePath
      : null;

  if (!path) {
    if (optional) return { config: {}, path: null };
    throw new Error(
      `Missing ${UPWORK_CONFIG_FILE}. Copy ${UPWORK_EXAMPLE_FILE} to ${UPWORK_CONFIG_FILE} first.`,
    );
  }

  const config = parseYaml(readFileSync(path, 'utf8')) ?? {};
  if (!isPlainObject(config)) {
    throw new Error(`${path} must contain a YAML object.`);
  }
  return { config, path };
}

export function buildProposalSettings(config = {}, opts = {}, { profile } = {}) {
  const proposal = isPlainObject(config.proposal) ? config.proposal : {};
  const configuredRate = isPlainObject(config.rate) ? config.rate : {};
  const profileRate = isPlainObject(profile?.rate) ? profile.rate : {};
  const configuredProfileUrl =
    typeof config.profile === 'string'
      ? config.profile
      : config.profile?.url;
  const cliRate = numberOrNull(opts.rate);
  const hourlyRate =
    cliRate ??
    numberOrNull(configuredRate.amount ?? config.hourlyRate) ??
    numberOrNull(profileRate.amount);
  const rateType = String(
    opts.rateType ||
      configuredRate.type ||
      profileRate.type ||
      'hourly',
  ).toLowerCase();
  const currency = String(
    configuredRate.currency ||
      config.currency ||
      profileRate.currency ||
      'USD',
  );
  const banned = Array.isArray(config.bannedPhrases)
    ? config.bannedPhrases
    : [];
  const yamlPreferredSamples = Array.isArray(config.preferredSamples)
    ? config.preferredSamples
    : [];
  const preferredSamples =
    yamlPreferredSamples.length > 0
      ? yamlPreferredSamples
      : (profile?.preferredSamples ?? []);

  return {
    targetWords: numberOr(proposal.targetWords, 180),
    minWords: numberOr(proposal.minWords, 120),
    maxWords: numberOr(proposal.maxWords, 260),
    maxChars: numberOr(proposal.maxChars, 5000),
    includeRate: opts.noRate
      ? false
      : Boolean(opts.rate) || Boolean(proposal.includeRate),
    includeAvailability: proposal.includeAvailability !== false,
    rate:
      hourlyRate == null
        ? null
        : {
            type: rateType === 'fixed' ? 'fixed' : 'hourly',
            amount: hourlyRate,
            currency,
          },
    availability:
      cleanText(opts.availability) ||
      cleanText(config.availability) ||
      cleanText(configuredRate.availability) ||
      cleanText(profile?.hoursPerWeek),
    timeline: cleanText(opts.timeline) || cleanText(config.timeline),
    timezone: cleanText(config.timezone),
    profileUrl:
      cleanText(opts.profile) ||
      (!opts.noProfile ? cleanText(configuredProfileUrl) : ''),
    minHourlyRate: numberOrNull(config.minHourlyRate),
    preferredSamples,
    bannedPhrases: [...new Set([...DEFAULT_BANNED_PHRASES, ...banned])],
    currency,
  };
}

/**
 * Upwork clients sometimes require a specific opening word or phrase, such as
 * "start your proposal with the word forecourt".
 */
export function extractRequiredOpening(body) {
  const text = String(body ?? '');
  const match = text.match(
    /(?:start|begin)\s+(?:(?:your|the)\s+proposal\s+with|with\s+(?:the\s+word|the\s+phrase))\s*(?:the\s+word|the\s+phrase)?\s*["“'‘]?([^"”'’.\n]+)/i,
  );
  if (!match) return '';
  return match[1]
    .trim()
    .replace(/^["“'‘]+|["”'’]+$/g, '')
    .replace(/\s+(?:and|then)\b.*$/i, '')
    .replace(/[.,;:]+$/, '')
    .trim();
}

export function parseBudget(value) {
  const text = String(value ?? '').replace(/,/g, '');
  const amounts = [...text.matchAll(/\$?\s*(\d+(?:\.\d+)?)/g)].map((match) =>
    Number(match[1]),
  );
  if (amounts.length === 0) return null;
  return {
    min: Math.min(...amounts),
    max: Math.max(...amounts),
    raw: String(value),
  };
}

export function formatRate(rate) {
  if (!rate || rate.amount == null) return '';
  const symbol =
    rate.currency === 'EUR' ? '€' : rate.currency === 'GBP' ? '£' : '$';
  const amount = Number(rate.amount).toLocaleString('en-US', {
    maximumFractionDigits: 2,
  });
  return rate.type === 'fixed'
    ? `${symbol}${amount} fixed`
    : `${symbol}${amount}/hr`;
}

export function describeBudget(details = {}) {
  if (!details.budget) return '';
  return details.budgetType === 'fixed'
    ? `${details.budget} fixed`
    : `${details.budget}/hr`;
}

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
