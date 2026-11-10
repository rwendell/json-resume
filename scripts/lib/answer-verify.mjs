import { slugify } from './job-input.mjs';
import { extractNumbers } from './numbers.mjs';

export function verifyAnswer({ output, career, candidates, hint, extraEvidence }) {
  const errors = [];
  const warnings = [];
  const known = buildEvidenceMap(career, candidates, hint, extraEvidence);
  const allowedYears = buildAllowedYears(career);

  const claims = Array.isArray(output.claims) ? output.claims : [];
  const evidence = Array.isArray(output.evidence) ? output.evidence : [];
  const gaps = Array.isArray(output.gaps) ? output.gaps : [];

  if (!Array.isArray(output.claims)) errors.push('claims is missing');
  if (!Array.isArray(output.evidence)) errors.push('evidence is missing');
  if (!Array.isArray(output.gaps)) warnings.push('gaps is missing');

  const allowedTypes = [
    'application',
    'behavioral',
    'motivation',
    'interview-prep',
    'other',
  ];
  if (!allowedTypes.includes(output.question_type)) {
    warnings.push(`unexpected question_type "${output.question_type}"`);
  }

  verifyClaims({ claims, known, allowedYears, errors, warnings });
  verifyEvidence({ evidence, known, errors });
  verifyClaimEvidenceUnion({ claims, evidence, warnings });

  if (
    hint &&
    !claims.some((entry) => (entry.evidence ?? []).includes('hint'))
  ) {
    warnings.push(
      'a hint was provided but no claims cite it; review whether the hint was used',
    );
  }

  if (claims.length === 0 && output.question_type !== 'interview-prep') {
    warnings.push('no factual claims were provided; review the answer manually');
  }

  return {
    errors,
    warnings,
    claimCount: claims.length,
    evidenceCount: evidence.length,
    gaps,
  };
}

export function verifyClaims({
  claims,
  known,
  allowedYears,
  errors,
  warnings,
  allowNegativeClaims = false,
}) {
  claims.forEach((entry, index) => {
    if (!entry || typeof entry.claim !== 'string' || !entry.claim.trim()) {
      errors.push(`claims[${index}] is missing claim text`);
      return;
    }
    const ids = Array.isArray(entry.evidence) ? entry.evidence : [];
    if (ids.length === 0) {
      if (allowNegativeClaims && isNegativeClaim(entry.claim)) {
        warnings.push(
          `claims[${index}] is a limitation with no evidence; review it before sending`,
        );
      } else {
        errors.push(`claims[${index}] has no evidence`);
      }
      return;
    }
    const texts = [];
    for (const id of ids) {
      const text = known.get(id);
      if (!text) {
        errors.push(`claims[${index}] cites unknown evidence "${id}"`);
      } else {
        texts.push(text);
      }
    }
    if (texts.length > 0) {
      checkNumbers(
        entry.claim,
        texts.join('\n'),
        `claims[${index}]`,
        errors,
        allowedYears,
      );
    }
  });
}

export function verifyEvidence({ evidence, known, errors }) {
  evidence.forEach((id, index) => {
    if (!known.has(id)) {
      errors.push(`evidence[${index}] cites unknown evidence "${id}"`);
    }
  });
}

export function verifyClaimEvidenceUnion({ claims, evidence, warnings }) {
  const evidenceSet = new Set(evidence);
  for (const [index, entry] of claims.entries()) {
    for (const id of entry.evidence ?? []) {
      if (!evidenceSet.has(id)) {
        warnings.push(
          `claims[${index}] evidence "${id}" is not in the top-level evidence list`,
        );
      }
    }
  }
}

export function buildEvidenceMap(career, candidates, hint, extraEvidence) {
  const map = new Map();
  if (hint) map.set('hint', hint);
  for (const [id, text] of Object.entries(extraEvidence ?? {})) {
    if (text) map.set(id, String(text));
  }
  for (const role of career.roles ?? []) {
    map.set(
      `role:${role.id}`,
      [
        role.company,
        role.position,
        role.startDate,
        role.endDate,
        role.summary,
      ]
        .filter(Boolean)
        .join('\n'),
    );
    for (const achievement of role.achievements ?? []) {
      map.set(achievement.id, achievement.text ?? '');
    }
  }
  for (const project of career.projects ?? []) {
    const projectText = [
      project.name,
      project.description,
      ...(project.highlights ?? []).map((highlight) => highlight.text),
    ]
      .filter(Boolean)
      .join('\n');
    if (project.id) map.set(`project:${project.id}`, projectText);
    if (project.repo) {
      map.set(`github:${project.repo}`, projectText);
      map.set(`github:${project.repo.split('/').pop()}`, projectText);
    }
    for (const highlight of project.highlights ?? []) {
      map.set(highlight.id, highlight.text ?? '');
    }
  }
  for (const entry of career.education ?? []) {
    const id = entry.id || slugify(entry.institution);
    const text = [
      entry.institution,
      entry.area,
      entry.studyType,
      entry.startDate,
      entry.endDate,
    ]
      .filter(Boolean)
      .join(' ');
    map.set(`education:${id}`, text);
    map.set('education', text);
  }
  for (const repo of candidates ?? []) {
    const text = [
      repo.description,
      repo.readme,
      ...(repo.localCommits ?? []),
    ].join('\n');
    const evidence =
      repo.evidence ||
      (repo.source === 'local'
        ? `local:${repo.name}`
        : repo.source === 'org' && repo.fullName
          ? `github:${repo.fullName}`
          : `github:${repo.name}`);

    map.set(evidence, text);
    if (repo.source !== 'local') {
      map.set(`github:${repo.name}`, text);
      if (repo.fullName) map.set(`github:${repo.fullName}`, text);
    }
  }
  return map;
}

export function buildAllowedYears(career) {
  const years = new Set();
  const add = (date) => {
    const match = String(date ?? '').match(/^(\d{4})/);
    if (match) years.add(match[1]);
  };
  for (const role of career.roles ?? []) {
    add(role.startDate);
    add(role.endDate);
  }
  for (const entry of career.education ?? []) {
    add(entry.startDate);
    add(entry.endDate);
  }
  return years;
}

export function checkNumbers(output, sourceText, path, errors, allowedYears) {
  const sourceNumbers = new Set(extractNumbers(stripTimes(sourceText)));
  for (const number of extractNumbers(stripTimes(output))) {
    if (allowedYears?.has(number)) continue;
    if (!sourceNumbers.has(number)) {
      errors.push(
        `${path} contains "${number}", which is not in the cited evidence`,
      );
    }
  }
}

function stripTimes(value) {
  return String(value ?? '')
    .replace(/\b\d{1,2}:\d{2}(?:\s*(?:am|pm))?\b/gi, ' ')
    .replace(/\b\d{1,2}\s*(?:am|pm)\b/gi, ' ');
}

function isNegativeClaim(value) {
  return /\b(?:no|not|never|none|haven't|hasn't|hadn't|didn't|doesn't|don't|cannot|can't|without|lack|lacks|lacking)\b/i.test(
    String(value ?? ''),
  );
}
