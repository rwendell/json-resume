export const TRIM_PLANS = [
  { recent: 6, middle: 4, oldest: 2, projects: 3, skillGroups: 4, skillKeywords: 7 },
  { recent: 6, middle: 4, oldest: 2, projects: 3, skillGroups: 4, skillKeywords: 6 },
  { recent: 6, middle: 4, oldest: 2, projects: 2, skillGroups: 4, skillKeywords: 6 },
  { recent: 5, middle: 4, oldest: 2, projects: 2, skillGroups: 4, skillKeywords: 6 },
  { recent: 5, middle: 3, oldest: 2, projects: 2, skillGroups: 4, skillKeywords: 6 },
  { recent: 5, middle: 3, oldest: 2, projects: 2, skillGroups: 3, skillKeywords: 6 },
  { recent: 4, middle: 3, oldest: 2, projects: 2, skillGroups: 3, skillKeywords: 6 },
  { recent: 4, middle: 3, oldest: 2, projects: 2, skillGroups: 3, skillKeywords: 5 },
  { recent: 4, middle: 2, oldest: 2, projects: 2, skillGroups: 3, skillKeywords: 5 },
  { recent: 4, middle: 2, oldest: 1, projects: 2, skillGroups: 3, skillKeywords: 5 },
  { recent: 4, middle: 2, oldest: 1, projects: 1, skillGroups: 3, skillKeywords: 5 },
  { recent: 3, middle: 2, oldest: 1, projects: 1, skillGroups: 3, skillKeywords: 5 },
  { recent: 3, middle: 2, oldest: 1, projects: 1, skillGroups: 3, skillKeywords: 4 },
  { recent: 3, middle: 1, oldest: 1, projects: 1, skillGroups: 3, skillKeywords: 4 },
  { recent: 2, middle: 1, oldest: 1, projects: 1, skillGroups: 2, skillKeywords: 5 },
  { recent: 2, middle: 1, oldest: 1, projects: 0, skillGroups: 2, skillKeywords: 5 },
  { recent: 2, middle: 1, oldest: 1, projects: 0, skillGroups: 2, skillKeywords: 4 },
  { recent: 1, middle: 1, oldest: 1, projects: 0, skillGroups: 2, skillKeywords: 4 },
];

/**
 * Remove lower-value trailing content so a resume can fit on one page.
 * Mutates `resume` and `trace`. Returns true when anything changed.
 */
export function trimResume(resume, trace, level) {
  const plan = TRIM_PLANS[Math.min(level, TRIM_PLANS.length - 1)];
  let changed = false;

  const work = Array.isArray(resume.work) ? resume.work : [];
  work.forEach((job, index) => {
    const highlights = Array.isArray(job.highlights) ? job.highlights : [];
    let limit;
    if (work.length === 1 || index === 0) limit = plan.recent;
    else if (index === work.length - 1) limit = plan.oldest;
    else limit = plan.middle;

    if (highlights.length > limit) {
      highlights.splice(limit);
      changed = true;
    }
  });

  const projects = Array.isArray(resume.projects) ? resume.projects : [];
  if (projects.length > plan.projects) {
    projects.splice(plan.projects);
    changed = true;
  }

  const groups = Array.isArray(resume.skills) ? resume.skills : [];
  if (groups.length > plan.skillGroups) {
    groups.splice(plan.skillGroups);
    changed = true;
  }
  for (const group of groups) {
    if (
      Array.isArray(group.keywords) &&
      group.keywords.length > plan.skillKeywords
    ) {
      group.keywords.splice(plan.skillKeywords);
      changed = true;
    }
  }

  if (level >= 3 && resume.basics?.summary) {
    const sentences =
      resume.basics.summary.match(/[^.!?]+[.!?]+/g) ?? [
        resume.basics.summary,
      ];
    const shortened = sentences
      .slice(0, level >= 5 ? 1 : 2)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (shortened && shortened.length < resume.basics.summary.length) {
      resume.basics.summary = shortened;
      changed = true;
    }
  }

  if (trimTrace(trace, resume)) changed = true;
  return changed;
}

export function collectUnusedAchievements(career, trace) {
  const used = new Set([
    ...(trace.bullets ?? []).flatMap((entry) => entry.evidence ?? []),
    ...(trace.summary_evidence ?? []),
  ]);

  const candidates = [];
  for (const role of career.roles ?? []) {
    for (const achievement of role.achievements ?? []) {
      if (!used.has(achievement.id)) {
        candidates.push({ role, achievement });
      }
    }
  }

  return candidates.sort(
    (a, b) =>
      (b.achievement.strength ?? 0) - (a.achievement.strength ?? 0) ||
      String(a.achievement.text ?? '').length -
        String(b.achievement.text ?? '').length,
  );
}

export function appendAchievement(resume, trace, candidate) {
  const work = Array.isArray(resume.work) ? resume.work : [];
  const index = work.findIndex(
    (job) => normalize(job.name) === normalize(candidate.role.company),
  );
  if (index === -1) return null;

  const job = work[index];
  if (!Array.isArray(job.highlights)) job.highlights = [];
  const text = String(candidate.achievement.text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;

  job.highlights.push(text);
  const path = `work[${index}].highlights[${job.highlights.length - 1}]`;
  if (!Array.isArray(trace.bullets)) trace.bullets = [];
  trace.bullets.push({
    path,
    evidence: [candidate.achievement.id],
    source: 'career',
  });

  return { index, path };
}

export function removeLastHighlight(resume, trace, index) {
  const job = resume.work?.[index];
  if (!job || !Array.isArray(job.highlights) || job.highlights.length === 0) {
    return false;
  }

  job.highlights.pop();
  const path = `work[${index}].highlights[${job.highlights.length}]`;
  trace.bullets = (trace.bullets ?? []).filter((entry) => entry.path !== path);
  return true;
}

function normalize(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function trimTrace(trace, resume) {
  let changed = false;
  const validPaths = new Set();

  (resume.work ?? []).forEach((job, index) => {
    (job.highlights ?? []).forEach((_, highlightIndex) => {
      validPaths.add(`work[${index}].highlights[${highlightIndex}]`);
    });
  });
  (resume.projects ?? []).forEach((project, index) => {
    (project.highlights ?? []).forEach((_, highlightIndex) => {
      validPaths.add(`projects[${index}].highlights[${highlightIndex}]`);
    });
  });

  const bullets = (trace.bullets ?? []).filter((entry) =>
    validPaths.has(entry.path),
  );
  if (bullets.length !== (trace.bullets ?? []).length) {
    trace.bullets = bullets;
    changed = true;
  }

  const projectNames = new Set(
    (resume.projects ?? []).map((project) => project.name),
  );
  const projects = (trace.projects ?? []).filter((entry) =>
    projectNames.has(entry.name),
  );
  if (projects.length !== (trace.projects ?? []).length) {
    trace.projects = projects;
    changed = true;
  }

  return changed;
}
