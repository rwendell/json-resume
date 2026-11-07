/**
 * Keep `basics.url` tied to the career fact bank.
 *
 * The website is opt-in: a generated resume includes `basics.url` only when the
 * merged fact bank defines `basics.url`. Removing that field keeps a
 * resume-only site (such as a GitHub Pages resume) off every resume; adding it
 * back later publishes the site once it is worth showing as a portfolio.
 */
export function applyBasicsUrlPolicy(resume, career) {
  const basics = resume?.basics;
  if (!basics || typeof basics !== 'object') return null;

  const sourceUrl = normalizeUrl(career?.basics?.url);
  if (sourceUrl) {
    if (basics.url === sourceUrl) return null;
    basics.url = sourceUrl;
    return 'basics.url set from the career fact bank';
  }

  if (basics.url == null) return null;
  delete basics.url;
  return 'removed basics.url because the career fact bank has no website';
}

/**
 * Return an error string when a resume's `basics.url` does not match the fact
 * bank, or null when it is allowed.
 */
export function checkBasicsUrl(resume, career) {
  const resumeUrl = normalizeUrl(resume?.basics?.url);
  const careerUrl = normalizeUrl(career?.basics?.url);

  if (resumeUrl && !careerUrl) {
    return `basics.url "${resumeUrl}" is not in the career fact bank; add it there or remove it from the resume`;
  }
  if (resumeUrl && careerUrl && resumeUrl !== careerUrl) {
    return `basics.url changed: "${resumeUrl}" != "${careerUrl}"`;
  }
  return null;
}

function normalizeUrl(value) {
  if (typeof value !== 'string') return value ?? null;
  return value.trim() || null;
}
