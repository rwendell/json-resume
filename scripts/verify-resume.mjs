#!/usr/bin/env node
/**
 * Verify a tailored resume against its career fact bank and trace.
 *
 * Usage:
 *   aube run verify-resume -- acme-forward-deployed-engineer
 *   aube run verify-resume -- generated/resumes/resume-acme.pdf
 *   aube run verify-resume -- .cache/tailor/resume-acme-forward-deployed-engineer/resume.json
 *
 * Exit code 1 means a hard integrity failure (schema, dates, evidence, or
 * trace). Gaps and terminology warnings do not fail the run.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import jsonResumeSchema from '@jsonresume/schema';
import { extractNumbers } from './lib/numbers.mjs';
import {
  findCacheByPdf,
  findCachedJobByAlias,
  getCachePdfPath,
  readCacheMeta,
} from './lib/output-paths.mjs';
import { getPdfPageCount } from './lib/pdf.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

const input = process.argv[2];
if (!input) {
  console.error(
    'Usage: node scripts/verify-resume.mjs <slug | pdf | cache path>',
  );
  process.exit(1);
}

const cacheRoot = resolve(rootDir, '.cache', 'tailor');
const generatedRoot = resolve(rootDir, 'generated', 'resumes');

const resolvedInput = resolve(process.cwd(), input);
let resolved;
if (existsSync(resolvedInput)) {
  const stat = statSync(resolvedInput);
  if (stat.isDirectory()) {
    const dir = resolvedInput;
    const isCache = dirname(dir) === cacheRoot;
    const slug = basename(dir).replace(/^resume-/, '');
    const meta = isCache ? readCacheMeta(dir) : null;
    const resolvedPdf = isCache
      ? getCachePdfPath({
          rootDir,
          resumeOutputDir: generatedRoot,
          meta,
          slug,
        })
      : join(dir, 'resume.pdf');
    resolved = {
      resumePath: join(dir, 'resume.json'),
      tracePath: join(dir, 'trace.json'),
      candidatesPath: join(dir, 'github-candidates.json'),
      pdfPath: resolvedPdf,
      label: isCache ? resolvedPdf : dir,
    };
  } else if (dirname(dirname(resolvedInput)) === cacheRoot) {
    const dir = dirname(resolvedInput);
    const slug = basename(dir).replace(/^resume-/, '');
    const meta = readCacheMeta(dir);
    const resolvedPdf = getCachePdfPath({
      rootDir,
      resumeOutputDir: generatedRoot,
      meta,
      slug,
    });
    resolved = {
      resumePath: join(dir, 'resume.json'),
      tracePath: join(dir, 'trace.json'),
      candidatesPath: join(dir, 'github-candidates.json'),
      pdfPath: resolvedPdf,
      label: resolvedPdf,
    };
  } else if (resolvedInput.toLowerCase().endsWith('.pdf')) {
    const cacheHit = findCacheByPdf({
      rootDir,
      cacheRoot,
      resumeOutputDir: generatedRoot,
      pdfPath: resolvedInput,
    });

    if (cacheHit) {
      resolved = {
        resumePath: join(cacheHit.cacheDir, 'resume.json'),
        tracePath: join(cacheHit.cacheDir, 'trace.json'),
        candidatesPath: join(cacheHit.cacheDir, 'github-candidates.json'),
        pdfPath: cacheHit.pdfPath,
        label: cacheHit.pdfPath,
      };
    } else {
      resolved = resolveCacheSlug(
        basename(resolvedInput),
        cacheRoot,
        generatedRoot,
      );
      if (!resolved) {
        console.error(
          `verify: no cached JSON found for ${resolvedInput}. Re-run tailor or pass the cache path.`,
        );
        process.exit(1);
      }
    }
  } else if (basename(resolvedInput) === 'resume.json') {
    const dir = dirname(resolvedInput);
    const isCache = dirname(dir) === cacheRoot;
    const slug = basename(dir).replace(/^resume-/, '');
    const meta = isCache ? readCacheMeta(dir) : null;
    const resolvedPdf = isCache
      ? getCachePdfPath({
          rootDir,
          resumeOutputDir: generatedRoot,
          meta,
          slug,
        })
      : join(dir, 'resume.pdf');
    resolved = {
      resumePath: resolvedInput,
      tracePath: join(dir, 'trace.json'),
      candidatesPath: join(dir, 'github-candidates.json'),
      pdfPath: resolvedPdf,
      label: isCache ? resolvedPdf : dir,
    };
  } else {
    const base = resolvedInput.replace(/\.json$/, '');
    resolved = {
      resumePath: resolvedInput,
      tracePath: `${base}.trace.json`,
      candidatesPath: `${base}.github-candidates.json`,
      pdfPath: `${base}.pdf`,
      label: resolvedInput,
    };
  }
} else {
  resolved = resolveCacheSlug(input, cacheRoot, generatedRoot);
  if (!resolved) {
    const alias = findCachedJobByAlias({
      rootDir,
      cacheRoot,
      resumeOutputDir: generatedRoot,
      alias: input,
    });
    if (alias) {
      resolved = {
        resumePath: join(alias.cacheDir, 'resume.json'),
        tracePath: join(alias.cacheDir, 'trace.json'),
        candidatesPath: join(alias.cacheDir, 'github-candidates.json'),
        pdfPath: alias.pdfPath,
        label: alias.pdfPath,
      };
    }
  }
  if (!resolved) {
    console.error(`verify: not found: ${resolvedInput}`);
    process.exit(1);
  }
}

const { resumePath, tracePath, candidatesPath, pdfPath, label } = resolved;

if (!existsSync(resumePath)) {
  console.error(`verify: missing ${resumePath}`);
  process.exit(1);
}
if (!existsSync(tracePath)) {
  console.error(`verify: missing ${tracePath}`);
  process.exit(1);
}

const resume = readJson(resumePath);
const trace = readJson(tracePath);
const career = parseYaml(readFileSync(resolve(rootDir, 'data/career.yml'), 'utf8'));
const githubPath = resolve(rootDir, 'data/github.json');
const github = existsSync(githubPath) ? readJson(githubPath) : { repos: [] };
const candidates = existsSync(candidatesPath) ? readJson(candidatesPath) : null;

const errors = [];
const warnings = [];
const notes = [];

await verifySchema();
verifyBasics();
const roles = verifyWork();
const projects = verifyProjects();
verifySkills();
verifyThemePunctuation();
verifyEducation();
verifyTrace(roles, projects);
await verifyPageCount(pdfPath);

report();
process.exit(errors.length > 0 ? 1 : 0);

function resolveCacheSlug(value, cacheRoot, generatedRoot) {
  const slug = String(value)
    .replace(/^resume-/, '')
    .replace(/\.(json|pdf)$/i, '');
  const dir = join(cacheRoot, `resume-${slug}`);
  const resume = join(dir, 'resume.json');
  if (!existsSync(resume)) return null;

  const meta = readCacheMeta(dir);
  const resolvedPdf = getCachePdfPath({
    rootDir,
    resumeOutputDir: generatedRoot,
    meta,
    slug,
  });

  return {
    resumePath: resume,
    tracePath: join(dir, 'trace.json'),
    candidatesPath: join(dir, 'github-candidates.json'),
    pdfPath: resolvedPdf,
    label: resolvedPdf,
  };
}

async function verifySchema() {
  const validationErrors = await new Promise((resolve) => {
    jsonResumeSchema.validate(resume, (errs, valid) => {
      resolve(valid ? [] : errs ?? []);
    });
  });

  if (validationErrors.length === 0) {
    notes.push('schema: valid');
    return;
  }

  for (const error of validationErrors) {
    const property = error.property || error.instancePath || '';
    const message = error.message || String(error);
    errors.push(
      `JSON Resume schema: ${property ? `${property} — ` : ''}${message}`,
    );
  }
}

function verifyBasics() {
  const basics = resume.basics ?? {};
  if (!basics.name) errors.push('basics.name is missing');
  else if (basics.name !== career.basics.name) {
    errors.push(`basics.name changed: "${basics.name}" != "${career.basics.name}"`);
  }
  if (!basics.email) errors.push('basics.email is missing');
  else if (basics.email !== career.basics.email) {
    errors.push(`basics.email changed: "${basics.email}" != "${career.basics.email}"`);
  }
  if (basics.phone && career.basics.phone && basics.phone !== career.basics.phone) {
    errors.push(`basics.phone changed: "${basics.phone}" != "${career.basics.phone}"`);
  }
  if (basics.url && career.basics.url && basics.url !== career.basics.url) {
    errors.push(`basics.url changed: "${basics.url}" != "${career.basics.url}"`);
  }
  if (!basics.label) warnings.push('basics.label is empty');
}

function verifyWork() {
  const work = Array.isArray(resume.work) ? resume.work : [];
  if (work.length === 0) errors.push('work is empty');

  const roleMap = new Map(
    (career.roles ?? []).map((role) => [normalize(role.company), role]),
  );
  const verified = [];

  work.forEach((job, index) => {
    const role = roleMap.get(normalize(job.name));
    if (!role) {
      errors.push(`work[${index}] has unknown employer "${job.name}"`);
      return;
    }
    if (normalize(job.position) !== normalize(role.position)) {
      errors.push(
        `work[${index}] position changed: "${job.position}" != "${role.position}"`,
      );
    }
    if (job.startDate !== role.startDate || job.endDate !== role.endDate) {
      errors.push(
        `work[${index}] dates changed: ${job.startDate}..${job.endDate} != ${role.startDate}..${role.endDate}`,
      );
    }

    const highlights = Array.isArray(job.highlights) ? job.highlights : [];
    if (highlights.length === 0) {
      warnings.push(`work[${index}] (${job.name}) has no highlights`);
    }

    highlights.forEach((highlight, highlightIndex) => {
      const path = `work[${index}].highlights[${highlightIndex}]`;
      const entry = findTraceBullet(path);
      if (!entry) {
        errors.push(`${path} has no trace entry`);
        return;
      }
      const evidence = validEvidence(entry.evidence, role.achievements, path);
      if (evidence.text) checkNumbers(highlight, evidence.text, path);
    });

    verified.push({
      index,
      role,
      highlights: highlights.length,
      evidenceIds: highlights.flatMap((_, highlightIndex) => {
        const entry = findTraceBullet(
          `work[${index}].highlights[${highlightIndex}]`,
        );
        return entry?.evidence ?? [];
      }),
    });
  });

  notes.push(
    `work: ${work.length} roles, ${work.reduce((sum, job) => sum + (job.highlights?.length ?? 0), 0)} highlights`,
  );
  return verified;
}

function verifyProjects() {
  const projects = Array.isArray(resume.projects) ? resume.projects : [];
  if (projects.length === 0) warnings.push('projects is empty');

  const curated = new Map(
    (career.projects ?? []).map((project) => [normalize(project.name), project]),
  );
  const projectCandidates = candidates ?? github.repos ?? [];
  const verified = [];

  projects.forEach((project, index) => {
    const careerProject = curated.get(normalize(project.name));
    const traceEntry = findTraceProject(project.name);
    const candidate = findProjectCandidate(
      project,
      traceEntry,
      projectCandidates,
    );

    if (!careerProject && !candidate) {
      errors.push(`projects[${index}] has unknown project "${project.name}"`);
      return;
    }

    if (!careerProject && candidate && candidate.included === false) {
      errors.push(
        `projects[${index}] uses excluded project candidate "${candidate.name}"`,
      );
    }

    if (!traceEntry) {
      errors.push(`projects[${index}] has no trace entry`);
    } else if (!careerProject && candidate) {
      const evidenceId = candidateEvidence(candidate);
      const expectedSource =
        candidate.source === 'local' ? 'local' : 'github';
      const validSource =
        expectedSource === 'local'
          ? traceEntry.source === 'local'
          : ['github', 'org'].includes(traceEntry.source);

      if (!validSource) {
        errors.push(
          `projects[${index}] (${project.name}) is a ${expectedSource} candidate but trace source is "${traceEntry.source}"`,
        );
      }
      if (!(traceEntry.evidence ?? []).includes(evidenceId)) {
        errors.push(
          `projects[${index}] (${project.name}) trace must cite "${evidenceId}"`,
        );
      }
    }

    const projectEvidence = careerProject?.highlights ?? [];
    const highlights = Array.isArray(project.highlights)
      ? project.highlights
      : [];

    highlights.forEach((highlight, highlightIndex) => {
      const path = `projects[${index}].highlights[${highlightIndex}]`;
      const entry = findTraceBullet(path);
      if (!entry) {
        errors.push(`${path} has no trace entry`);
        return;
      }
      if (careerProject) {
        const evidence = validEvidence(entry.evidence, projectEvidence, path);
        if (evidence.text) checkNumbers(highlight, evidence.text, path);
      } else if (candidate) {
        const evidenceId = candidateEvidence(candidate);
        const ids = Array.isArray(entry.evidence) ? entry.evidence : [];
        if (!ids.includes(evidenceId)) {
          errors.push(`${path} must cite "${evidenceId}"`);
        }
        const sourceText = [
          candidate.description,
          candidate.readme,
          ...(candidate.localCommits ?? []),
        ].join('\n');
        checkNumbers(highlight, sourceText, path);
      }
    });

    verified.push({
      index,
      name: project.name,
      source: careerProject
        ? 'career'
        : candidate?.source === 'local'
          ? 'local'
          : 'github',
      highlights: highlights.length,
    });
  });

  const careerCount = verified.filter(
    (project) => project.source === 'career',
  ).length;
  const githubCount = verified.filter(
    (project) => project.source === 'github',
  ).length;
  const localCount = verified.filter(
    (project) => project.source === 'local',
  ).length;
  notes.push(
    `projects: ${verified.length}${verified.length ? ` (${careerCount} curated, ${githubCount} GitHub/org, ${localCount} local)` : ''}`,
  );
  return verified;
}

function verifySkills() {
  const groups = Array.isArray(resume.skills) ? resume.skills : [];
  if (groups.length === 0) warnings.push('skills is empty');

  const knownIds = buildKnownIds();
  const direct = new Set();
  for (const group of career.skillGroups ?? []) {
    for (const keyword of group.keywords ?? []) direct.add(normalize(keyword));
  }
  for (const role of career.roles ?? []) {
    for (const achievement of role.achievements ?? []) {
      for (const skill of achievement.skills ?? []) direct.add(normalize(skill));
    }
  }
  for (const project of career.projects ?? []) {
    for (const skill of project.skills ?? []) direct.add(normalize(skill));
    for (const highlight of project.highlights ?? []) {
      for (const skill of highlight.skills ?? []) direct.add(normalize(skill));
    }
  }
  const projectList = candidates ?? github.repos ?? [];
  for (const repo of projectList) {
    if (repo.included === false) continue;
    for (const language of repo.languages ?? []) direct.add(normalize(language));
    for (const topic of repo.topics ?? []) direct.add(normalize(topic));
  }

  const transferable = new Set();
  const transferableSources = new Map();
  for (const entry of career.transferable ?? []) {
    if (!knownIds.has(entry.evidence)) continue;
    for (const term of entry.terms ?? []) {
      const key = normalize(term);
      transferable.add(key);
      if (!transferableSources.has(key)) {
        transferableSources.set(key, new Set());
      }
      transferableSources.get(key).add(entry.evidence);
    }
  }

  const citedEvidence = new Set();
  for (const entry of trace.bullets ?? []) {
    for (const id of entry.evidence ?? []) citedEvidence.add(id);
  }
  for (const entry of trace.projects ?? []) {
    for (const id of entry.evidence ?? []) citedEvidence.add(id);
  }
  for (const entry of trace.requirements ?? []) {
    for (const id of entry.evidence ?? []) citedEvidence.add(id);
  }
  for (const id of trace.summary_evidence ?? []) citedEvidence.add(id);

  const citedProjectIds = new Set(
    (trace.projects ?? []).flatMap((project) => project.evidence ?? []),
  );
  let citedProjects = projectList.filter(
    (project) =>
      project.included !== false &&
      (citedProjectIds.has(candidateEvidence(project)) ||
        citedProjectIds.has(project.name) ||
        (project.fullName && citedProjectIds.has(project.fullName)) ||
        citedProjectIds.has(`github:${project.name}`)),
  );
  if (citedProjects.length === 0) {
    citedProjects = projectList.filter(
      (project) => project.included !== false,
    );
  }
  const projectText = citedProjects
    .map((project) =>
      [
        project.name,
        project.displayName,
        project.description,
        project.readme,
        ...(project.localCommits ?? []),
      ].join(' '),
    )
    .join(' ')
    .toLowerCase();

  const unknown = [];
  for (const group of groups) {
    if (!group.name) warnings.push('skill group is missing a name');
    for (const keyword of group.keywords ?? []) {
      const key = normalize(keyword);
      const directMatch =
        matchesSkill(key, direct) || appearsInText(key, projectText);
      const transferableMatch =
        !directMatch && matchesSkill(key, transferable);
      if (!directMatch && !transferableMatch) {
        unknown.push(keyword);
        continue;
      }
      if (transferableMatch) {
        const sources = skillSources(key, transferableSources);
        const cited = [...sources].some((id) => citedEvidence.has(id));
        if (!cited && sources.size > 0) {
          warnings.push(
            `skill "${keyword}" is transferable from ${[...sources].join(', ')} but that evidence is not cited`,
          );
        }
      }
    }
    if (!group.keywords?.length) warnings.push(`skill group "${group.name}" is empty`);
  }
  if (unknown.length > 0) {
    warnings.push(
      `skills not found in the fact bank (review for fabrication): ${[...new Set(unknown)].join(', ')}`,
    );
  } else if (groups.length > 0) {
    notes.push(
      `skills: ${groups.length} groups, ${groups.reduce((sum, group) => sum + (group.keywords?.length ?? 0), 0)} keywords`,
    );
  }
}

function verifyThemePunctuation() {
  (resume.projects ?? []).forEach((project, projectIndex) => {
    (project.highlights ?? []).forEach((highlight, highlightIndex) => {
      if (/[.!?]$/.test(String(highlight).trim())) {
        warnings.push(
          `projects[${projectIndex}].highlights[${highlightIndex}] ends with punctuation; the theme appends a period`,
        );
      }
    });
  });

  (resume.skills ?? []).forEach((group, groupIndex) => {
    (group.keywords ?? []).forEach((keyword, keywordIndex) => {
      if (/[.!?]$/.test(String(keyword).trim())) {
        warnings.push(
          `skills[${groupIndex}].keywords[${keywordIndex}] ends with punctuation; the theme appends a period to the final keyword`,
        );
      }
    });
  });
}

function verifyEducation() {
  const education = Array.isArray(resume.education) ? resume.education : [];
  if (education.length === 0) {
    warnings.push('education is empty');
    return;
  }

  for (const [index, entry] of education.entries()) {
    const source = (career.education ?? []).find(
      (item) => normalize(item.institution) === normalize(entry.institution),
    );
    if (!source) {
      errors.push(`education[${index}] has unknown institution "${entry.institution}"`);
      continue;
    }
    if (
      entry.area !== source.area ||
      entry.studyType !== source.studyType ||
      entry.startDate !== source.startDate ||
      entry.endDate !== source.endDate
    ) {
      errors.push(`education[${index}] does not match the fact bank`);
    }
  }
}

function buildKnownIds() {
  const knownIds = new Set();
  for (const role of career.roles ?? []) {
    for (const achievement of role.achievements ?? []) knownIds.add(achievement.id);
  }
  for (const project of career.projects ?? []) {
    for (const highlight of project.highlights ?? []) knownIds.add(highlight.id);
  }
  for (const entry of career.education ?? []) {
    const id =
      entry.id ||
      normalize(entry.institution).replace(/\s+/g, '-');
    knownIds.add(`education:${id}`);
    knownIds.add('education');
  }
  for (const repo of candidates ?? github.repos ?? []) {
    if (repo.included === false) continue;
    knownIds.add(candidateEvidence(repo));
    knownIds.add(repo.name);
    if (repo.displayName) knownIds.add(repo.displayName);
    if (repo.fullName) knownIds.add(repo.fullName);
    if (repo.source !== 'local') {
      knownIds.add(`github:${repo.name}`);
      if (repo.fullName) knownIds.add(`github:${repo.fullName}`);
    }
  }
  return knownIds;
}

function verifyTrace(roles, projects) {
  const requirements = Array.isArray(trace.requirements)
    ? trace.requirements
    : [];
  if (requirements.length === 0) {
    warnings.push('trace has no requirements');
  }

  const isMust = (item) => ['must', 'must-have'].includes(item.type);
  const must = requirements.filter(isMust);
  const coveredMust = must.filter((item) => item.status === 'covered');
  const gaps = requirements.filter((item) => item.status === 'gap');
  const partial = requirements.filter((item) => item.status === 'partial');

  for (const [index, requirement] of requirements.entries()) {
    if (!requirement.requirement) {
      errors.push(`trace.requirements[${index}] is missing requirement text`);
    }
    if (!['must', 'must-have', 'nice', 'nice-to-have'].includes(requirement.type)) {
      warnings.push(
        `trace.requirements[${index}] has unexpected type "${requirement.type}"`,
      );
    }
    if (!['covered', 'partial', 'gap'].includes(requirement.status)) {
      errors.push(
        `trace.requirements[${index}] has invalid status "${requirement.status}"`,
      );
    }
    if (
      requirement.status === 'covered' &&
      (!Array.isArray(requirement.evidence) || requirement.evidence.length === 0)
    ) {
      warnings.push(
        `trace.requirements[${index}] is covered but has no evidence ids`,
      );
    }
  }

  const expectedPaths = new Set();
  (resume.work ?? []).forEach((work, workIndex) => {
    for (let index = 0; index < (work.highlights?.length ?? 0); index += 1) {
      expectedPaths.add(`work[${workIndex}].highlights[${index}]`);
    }
  });
  (resume.projects ?? []).forEach((project, projectIndex) => {
    for (let index = 0; index < (project.highlights?.length ?? 0); index += 1) {
      expectedPaths.add(`projects[${projectIndex}].highlights[${index}]`);
    }
  });

  const tracePaths = new Set(
    (trace.bullets ?? []).map((entry) => entry.path),
  );
  for (const path of expectedPaths) {
    if (!tracePaths.has(path)) errors.push(`trace is missing ${path}`);
  }
  for (const path of tracePaths) {
    if (!expectedPaths.has(path)) {
      warnings.push(`trace references a path that does not exist: ${path}`);
    }
  }

  const knownIds = buildKnownIds();

  for (const [index, entry] of (trace.bullets ?? []).entries()) {
    for (const id of entry.evidence ?? []) {
      if (!knownIds.has(id)) {
        errors.push(`trace.bullets[${index}] cites unknown evidence "${id}"`);
      }
    }
  }
  for (const [index, id] of (trace.summary_evidence ?? []).entries()) {
    if (!knownIds.has(id)) {
      errors.push(`trace.summary_evidence[${index}] cites unknown evidence "${id}"`);
    }
  }
  for (const [index, requirement] of requirements.entries()) {
    for (const id of requirement.evidence ?? []) {
      if (!knownIds.has(id)) {
        errors.push(
          `trace.requirements[${index}] cites unknown evidence "${id}"`,
        );
      }
    }
  }

  notes.push(
    `requirements: ${must.length} must, ${requirements.length - must.length} nice; ${coveredMust.length} must covered, ${partial.length} partial, ${gaps.length} gaps`,
  );

  const transferableCount = requirements.filter(
    (item) => item.transferable === true,
  ).length;
  if (transferableCount > 0) {
    notes.push(
      `transferable: ${transferableCount} requirement(s) marked as adjacent evidence`,
    );
  }

  if (gaps.length > 0) {
    notes.push('gaps:');
    for (const gap of gaps) notes.push(`  - ${gap.requirement}`);
  }

  if (roles.length > 0 && projects.length === 0) {
    warnings.push('no projects were included');
  }
}

async function verifyPageCount(pdfPath) {
  if (!existsSync(pdfPath)) {
    warnings.push('no PDF found; one-page requirement not checked');
    return;
  }
  try {
    const pages = await getPdfPageCount(pdfPath);
    if (pages !== 1) {
      errors.push(
        `PDF is ${pages} pages; tailored resumes must fit on exactly one page`,
      );
    } else {
      notes.push('pdf: 1 page');
    }
  } catch (error) {
    errors.push(`could not read the PDF page count: ${error.message}`);
  }
}

function findTraceBullet(path) {
  return (trace.bullets ?? []).find((entry) => entry.path === path);
}

function findTraceProject(name) {
  return (trace.projects ?? []).find(
    (entry) => normalize(entry.name) === normalize(name),
  );
}

function candidateEvidence(candidate) {
  if (candidate.evidence) return candidate.evidence;
  if (candidate.source === 'local') return `local:${candidate.name}`;
  if (candidate.source === 'org' && candidate.fullName) {
    return `github:${candidate.fullName}`;
  }
  return `github:${candidate.name}`;
}

function findProjectCandidate(project, traceEntry, candidates) {
  const evidenceIds = traceEntry?.evidence ?? [];

  for (const candidate of candidates) {
    if (evidenceIds.includes(candidateEvidence(candidate))) return candidate;
  }

  const byName = candidates.find(
    (candidate) =>
      normalize(candidate.name) === normalize(project.name) ||
      normalize(candidate.displayName) === normalize(project.name),
  );
  if (byName) return byName;

  if (project.url) {
    const byUrl = candidates.find(
      (candidate) =>
        normalize(candidate.url) === normalize(project.url) ||
        normalize(candidate.homepage) === normalize(project.url),
    );
    if (byUrl) return byUrl;
  }

  return null;
}

function validEvidence(ids, achievements, path) {
  const list = Array.isArray(ids) ? ids : [];
  if (list.length === 0) {
    errors.push(`${path} has no evidence ids`);
    return { text: '' };
  }
  const byId = new Map(
    (achievements ?? []).map((achievement) => [achievement.id, achievement]),
  );
  let text = '';
  for (const id of list) {
    const achievement = byId.get(id);
    if (!achievement) {
      errors.push(`${path} cites "${id}", which is not in this role/project`);
      continue;
    }
    text += `\n${achievement.text ?? ''}`;
  }
  return { text };
}

function checkNumbers(output, sourceText, path) {
  const sourceNumbers = new Set(extractNumbers(sourceText));
  for (const number of extractNumbers(output)) {
    if (!sourceNumbers.has(number)) {
      errors.push(`${path} contains "${number}", which is not in the cited evidence`);
    }
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    console.error(`verify: invalid JSON in ${path}: ${error.message}`);
    process.exit(1);
  }
}

function matchesSkill(normalized, allowed) {
  return wordVariants(normalized).some((variant) => allowed.has(variant));
}

function skillSources(normalized, sourcesByTerm) {
  const sources = new Set();
  for (const variant of wordVariants(normalized)) {
    for (const source of sourcesByTerm.get(variant) ?? []) {
      sources.add(source);
    }
  }
  return sources;
}

function appearsInText(normalized, text) {
  const words = normalized.split(' ').filter(Boolean);
  if (words.length === 0) return false;
  return words.every((word) =>
    wordVariants(word).some((variant) => text.includes(variant)),
  );
}

function wordVariants(value) {
  const word = normalize(value);
  if (!word) return [];

  const variants = new Set([word]);
  if (!word.endsWith('ss')) {
    if (word.endsWith('ies') && word.length > 3) {
      variants.add(`${word.slice(0, -3)}y`);
    }
    if (word.endsWith('es') && word.length > 2) {
      variants.add(word.slice(0, -2));
    }
    if (word.endsWith('s') && word.length > 1) {
      variants.add(word.slice(0, -1));
    }
  }
  variants.add(`${word}s`);
  variants.add(`${word}es`);
  if (word.endsWith('y') && word.length > 1) {
    variants.add(`${word.slice(0, -1)}ies`);
  }
  return [...variants].filter(Boolean);
}

function normalize(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function report() {
  console.log(`verify: ${label}`);
  for (const note of notes) console.log(`  ${note}`);
  for (const warning of warnings) console.log(`  warning: ${warning}`);
  for (const error of errors) console.log(`  error: ${error}`);

  if (errors.length > 0) {
    console.log(`verify: FAILED (${errors.length} error${errors.length === 1 ? '' : 's'})`);
  } else if (warnings.length > 0) {
    console.log(`verify: OK (${warnings.length} warning${warnings.length === 1 ? '' : 's'})`);
  } else {
    console.log('verify: OK');
  }
}
