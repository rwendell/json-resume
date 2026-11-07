/**
 * Keep true-but-vague skills out of the resume's skills section.
 *
 * Terms in `skillExclude` remain valid evidence tags on achievements and
 * projects. They are filtered only from the generated `skills` display, so the
 * fact bank can still use them when checking claims.
 */
export function filterExcludedSkills(resume, career) {
  const excluded = excludedSkillSet(career);
  if (excluded.size === 0) return [];

  const groups = Array.isArray(resume?.skills) ? resume.skills : [];
  const removed = [];

  for (const group of groups) {
    if (!Array.isArray(group.keywords)) continue;
    group.keywords = group.keywords.filter((keyword) => {
      if (!excluded.has(normalizeSkill(keyword))) return true;
      removed.push(String(keyword));
      return false;
    });
  }

  for (let index = groups.length - 1; index >= 0; index -= 1) {
    if (!Array.isArray(groups[index].keywords) || groups[index].keywords.length === 0) {
      groups.splice(index, 1);
    }
  }

  return [...new Set(removed)];
}

/**
 * Return the excluded keywords that are still present on a resume.
 */
export function findExcludedSkills(resume, career) {
  const excluded = excludedSkillSet(career);
  if (excluded.size === 0) return [];

  const found = [];
  for (const group of resume?.skills ?? []) {
    for (const keyword of group.keywords ?? []) {
      if (excluded.has(normalizeSkill(keyword))) found.push(String(keyword));
    }
  }
  return [...new Set(found)];
}

export function excludedSkillSet(career) {
  return new Set(
    (career?.skillExclude ?? []).map((skill) => normalizeSkill(skill)),
  );
}

export function normalizeSkill(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
