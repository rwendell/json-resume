/**
 * This theme appends a period after project highlights and after the last skill
 * keyword. Keep those fields free of terminal punctuation so the rendered PDF
 * does not show "..".
 */
export function normalizeThemePunctuation(resume) {
  let changed = false;

  for (const project of resume.projects ?? []) {
    if (!Array.isArray(project.highlights)) continue;
    project.highlights = project.highlights.map((highlight) => {
      const cleaned = String(highlight).replace(/[.!?]+$/, '').trim();
      if (cleaned !== highlight) changed = true;
      return cleaned;
    });
  }

  for (const group of resume.skills ?? []) {
    if (!Array.isArray(group.keywords)) continue;
    group.keywords = group.keywords.map((keyword) => {
      const cleaned = String(keyword).replace(/[.!?]+$/, '').trim();
      if (cleaned !== keyword) changed = true;
      return cleaned;
    });
  }

  return changed;
}
