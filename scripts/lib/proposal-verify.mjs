import {
  buildAllowedYears,
  buildEvidenceMap,
  verifyClaimEvidenceUnion,
  verifyClaims,
  verifyEvidence,
} from './answer-verify.mjs';
import { profileEvidenceText } from './upwork-profile.mjs';

/**
 * Verify a proposal against the same evidence rules as an answer, plus the
 * Upwork-specific shape: screening answers, samples, rate, and length.
 */
export function verifyProposal({
  output,
  career,
  candidates,
  hint,
  client,
  settings,
  job,
  questions = [],
  requiredOpening = '',
  timeline = '',
  profile,
}) {
  const errors = [];
  const warnings = [];
  const configText = JSON.stringify(settings ?? {}, null, 2);
  const portfolioEvidence = Object.fromEntries(
    (profile?.portfolio ?? [])
      .filter((item) => item?.evidence)
      .map((item) => [
        item.evidence,
        [item.title, ...(item.tags ?? [])].filter(Boolean).join('\n'),
      ]),
  );
  const known = buildEvidenceMap(career, candidates, hint, {
    client: [client, job?.details?.client].filter(Boolean).join('\n\n'),
    config: configText,
    job: [job?.body, job?.details ? JSON.stringify(job.details) : '']
      .filter(Boolean)
      .join('\n'),
    profile: profileEvidenceText(profile),
    ...portfolioEvidence,
  });
  const allowedYears = buildAllowedYears(career);

  const proposal =
    typeof output.proposal === 'string' ? output.proposal.trim() : '';
  const claims = Array.isArray(output.claims) ? output.claims : [];
  const evidence = Array.isArray(output.evidence) ? output.evidence : [];
  const gaps = Array.isArray(output.gaps) ? output.gaps : [];
  const answers = Array.isArray(output.screening_answers)
    ? output.screening_answers
    : [];
  const samples = Array.isArray(output.samples) ? output.samples : [];

  if (!proposal) errors.push('proposal is missing or empty');
  if (!Array.isArray(output.claims)) errors.push('claims is missing');
  if (!Array.isArray(output.evidence)) errors.push('evidence is missing');
  if (!Array.isArray(output.gaps)) warnings.push('gaps is missing');
  if (
    output.screening_answers != null &&
    !Array.isArray(output.screening_answers)
  ) {
    warnings.push('screening_answers is not an array');
  }
  if (output.samples != null && !Array.isArray(output.samples)) {
    warnings.push('samples is not an array');
  }

  verifyClaims({
    claims,
    known,
    allowedYears,
    errors,
    warnings,
    allowNegativeClaims: true,
  });
  verifyEvidence({ evidence, known, errors });
  verifyClaimEvidenceUnion({ claims, evidence, warnings });

  if (questions.length > 0) {
    if (answers.length !== questions.length) {
      errors.push(
        `expected ${questions.length} screening answer(s), got ${answers.length}`,
      );
    }
    questions.forEach((question, index) => {
      const entry = answers[index];
      if (!entry || typeof entry.answer !== 'string' || !entry.answer.trim()) {
        errors.push(`screening_answers[${index}] is missing an answer`);
        return;
      }
      if (
        entry.question &&
        normalizeQuestion(entry.question) !== normalizeQuestion(question)
      ) {
        warnings.push(
          `screening_answers[${index}] question does not match the supplied question`,
        );
      }
    });
  } else {
    answers.forEach((entry, index) => {
      if (!entry || typeof entry.answer !== 'string' || !entry.answer.trim()) {
        errors.push(`screening_answers[${index}] is missing an answer`);
      }
    });
  }

  samples.forEach((sample, index) => {
    if (!sample || typeof sample !== 'object') {
      errors.push(`samples[${index}] is not an object`);
      return;
    }
    if (!sample.evidence) {
      errors.push(`samples[${index}] has no evidence id`);
    } else if (!known.has(sample.evidence)) {
      errors.push(`samples[${index}] cites unknown evidence "${sample.evidence}"`);
    }
  });

  if (output.rate != null) {
    if (typeof output.rate !== 'object' || Array.isArray(output.rate)) {
      warnings.push('rate should be an object or null');
    } else {
      if (!['hourly', 'fixed'].includes(output.rate.type)) {
        warnings.push('rate.type should be "hourly" or "fixed"');
      }
      if (!(Number(output.rate.amount) > 0)) {
        warnings.push('rate.amount should be a positive number');
      }
      const configuredRate = settings?.rate;
      if (!configuredRate) {
        errors.push(
          'rate is set but no rate was provided in data/upwork.yml or with --rate',
        );
      } else if (
        Number(output.rate.amount) !== Number(configuredRate.amount) ||
        output.rate.type !== configuredRate.type
      ) {
        errors.push(
          `rate ${output.rate.type} ${output.rate.amount} does not match the configured ${configuredRate.type} ${configuredRate.amount}`,
        );
      }
    }
  }

  if (
    output.timeline != null &&
    String(output.timeline).trim() &&
    !String(timeline ?? '').trim()
  ) {
    const timelineText = String(output.timeline).trim().toLowerCase();
    const jobTimeline = `${job?.body ?? ''}\n${JSON.stringify(
      job?.details ?? {},
    )}`.toLowerCase();
    if (!jobTimeline.includes(timelineText)) {
      errors.push(
        'timeline is set but no timeline was provided with --timeline, data/upwork.yml, or the job description',
      );
    }
  }

  if (
    output.availability != null &&
    String(output.availability).trim() &&
    !String(settings?.availability ?? '').trim() &&
    !String(client ?? '').trim() &&
    !String(hint ?? '').trim()
  ) {
    errors.push(
      'availability is set but no availability was provided in data/upwork.yml, --availability, --client, or --hint',
    );
  }

  if (output.fit != null) {
    if (typeof output.fit !== 'object' || Array.isArray(output.fit)) {
      warnings.push('fit should be an object');
    } else if (!['strong', 'stretch', 'weak'].includes(output.fit.verdict)) {
      warnings.push('fit.verdict should be strong, stretch, or weak');
    }
  }

  if (proposal) {
    checkStyle({ proposal, settings, errors, warnings });
    checkRequiredOpening({ proposal, requiredOpening, errors });
    checkLocationClaims({ proposal, career, hint, profile, errors });
    checkInternalIds({ proposal, known, warnings });
  }

  return {
    errors,
    warnings,
    claimCount: claims.length,
    evidenceCount: evidence.length,
    gapCount: gaps.length,
    wordCount: countWords(proposal),
    charCount: proposal.length,
  };
}

function checkStyle({ proposal, settings, errors, warnings }) {
  const wordCount = countWords(proposal);
  const maxChars = Number(settings?.maxChars);
  if (maxChars > 0 && proposal.length > maxChars) {
    errors.push(
      `proposal is ${proposal.length} characters; the configured limit is ${maxChars}`,
    );
  }

  const minWords = Number(settings?.minWords);
  const maxWords = Number(settings?.maxWords);
  if (minWords > 0 && wordCount < minWords) {
    warnings.push(
      `proposal is ${wordCount} words; target at least ${minWords}`,
    );
  }
  if (maxWords > 0 && wordCount > maxWords) {
    warnings.push(
      `proposal is ${wordCount} words; target at most ${maxWords}`,
    );
  }

  const lower = proposal.toLowerCase();
  for (const phrase of settings?.bannedPhrases ?? []) {
    if (lower.includes(String(phrase).toLowerCase())) {
      warnings.push(`proposal contains the generic phrase "${phrase}"`);
    }
  }

  if (
    /\[(?:your|company|insert|name|role|client|date|rate|amount|x)[^\]]*\]/i.test(
      proposal,
    )
  ) {
    warnings.push('proposal contains a placeholder bracket; replace it before sending');
  }
}

function checkRequiredOpening({ proposal, requiredOpening, errors }) {
  if (!requiredOpening) return;
  const expected = requiredOpening.toLowerCase().replace(/[.!]+$/, '').trim();
  if (!expected) return;
  const actual = proposal.toLowerCase();
  if (!actual.startsWith(expected)) {
    errors.push(
      `proposal must start with "${requiredOpening}" because the job description requires it`,
    );
  }
}

function checkLocationClaims({ proposal, career, hint, profile, errors }) {
  const careerText = JSON.stringify(career ?? {});
  const hintText = String(hint ?? '');
  const careerCountry = String(
    career?.basics?.location?.countryCode ?? '',
  ).toUpperCase();
  const profileUs =
    profile?.location?.countryCode === 'US' &&
    (!careerCountry || careerCountry === 'US');
  const hasUsSource =
    profileUs ||
    /"countryCode"\s*:\s*"US"/i.test(careerText) ||
    /"country"\s*:\s*"United States"/i.test(careerText) ||
    /\b(?:i(?:'m| am)|currently)\s+(?:based|located|residing|living)\s+in\s+(?:the\s+)?(?:united states|u\.s\.|usa|us)\b/i.test(
      hintText,
    ) ||
    /\b(?:u\.s\.|us|united states)[- ]based\b/i.test(hintText);
  if (hasUsSource) return;

  const patterns = [
    /\b(?:i(?:'m| am)|currently)\s+(?:based|located|residing|living)\s+in\s+(?:the\s+)?(?:united states|u\.s\.|usa|us)\b/i,
    /\b(?:i(?:'m| am)|currently)\s+(?:a\s+)?(?:u\.s\.|us|united states)[- ]based\b/i,
    /\bmy (?:current )?(?:location|residence)\b[^.\n]*\b(?:united states|u\.s\.|usa)\b/i,
    /\bauthorized to work in the (?:united states|u\.s\.|usa)\b/i,
    /\b(?:u\.s\.|united states)\s+(?:citizen|permanent resident)\b/i,
  ];
  if (patterns.some((pattern) => pattern.test(proposal))) {
    errors.push(
      'proposal asserts a U.S. location or work authorization that is not in the career fact bank or hint',
    );
  }
}

function checkInternalIds({ proposal, known, warnings }) {
  for (const id of known.keys()) {
    if (
      id.length < 7 ||
      ['hint', 'client', 'config', 'job', 'education'].includes(id) ||
      (!id.includes(':') && !id.includes('-'))
    ) {
      continue;
    }
    if (proposal.includes(id)) {
      warnings.push(`proposal contains the internal evidence id "${id}"`);
    }
  }
}

function countWords(value) {
  return String(value ?? '')
    .split(/\s+/)
    .filter(Boolean).length;
}

function normalizeQuestion(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
