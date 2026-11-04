import { existsSync, readFileSync, statSync } from 'node:fs';

export function shouldSyncGithub(path, { noSync = false } = {}) {
  if (noSync) return false;
  if (!existsSync(path)) return true;
  try {
    return Date.now() - statSync(path).mtimeMs > 24 * 60 * 60 * 1000;
  } catch {
    return true;
  }
}

export function shouldSyncLocal(path, { noSync = false } = {}) {
  return shouldSyncGithub(path, { noSync });
}

export function loadGithub(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function loadLocal(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function rankProjects(github, local, career, job, limit = 12) {
  const repos = [
    ...(github?.repos ?? []).map((repo) => ({
      ...repo,
      source: repo.source || 'github',
      evidence:
        repo.evidence ||
        (repo.source === 'org' && repo.fullName
          ? `github:${repo.fullName}`
          : `github:${repo.name}`),
    })),
    ...(local?.projects ?? []).map((project) => ({
      ...project,
      source: 'local',
      evidence: project.evidence || `local:${project.name}`,
      pushedAt: project.lastCommit,
    })),
  ].filter((repo) => repo.included);

  const tokens = keywords(job.body || job.title);
  if (repos.length === 0) {
    return { tokens, scored: [], selected: [] };
  }

  const curatedRepos = new Set(
    (career.projects ?? [])
      .map((project) => project.repo)
      .filter(Boolean)
      .map((repo) => repo.split('/').pop().toLowerCase()),
  );

  const scored = repos
    .filter(
      (repo) =>
        repo.source === 'local' ||
        !curatedRepos.has(repo.name.toLowerCase()),
    )
    .map((repo) => {
      const haystack = [
        repo.name,
        repo.displayName,
        repo.description,
        ...(repo.topics ?? []),
        ...(repo.languages ?? []),
        ...(repo.localCommits ?? []),
        repo.readme,
      ]
        .join(' ')
        .toLowerCase();
      const matched = tokens.filter((token) => haystack.includes(token));
      return {
        repo,
        matched,
        baseScore: matched.length,
        pinned: Boolean(repo.pinned),
        score: matched.length,
      };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        Number(b.repo.pinned) - Number(a.repo.pinned) ||
        String(b.repo.pushedAt).localeCompare(String(a.repo.pushedAt)),
    );

  return {
    tokens,
    scored,
    selected: scored
      .slice(0, limit)
      .map(({ repo }) => toCandidate(repo)),
  };
}

export function selectProjects(github, local, career, job, limit = 12) {
  return rankProjects(github, local, career, job, limit).selected;
}

function toCandidate(repo) {
  return {
    name: repo.name,
    displayName: repo.displayName || repo.name,
    source: repo.source,
    evidence: repo.evidence,
    url: repo.url || repo.remote || '',
    homepage: repo.homepage || '',
    description: repo.description || '',
    topics: repo.topics ?? [],
    languages: repo.languages ?? [],
    pinned: Boolean(repo.pinned),
    included: true,
    localPath: repo.path || undefined,
    localCommits: repo.localCommits ?? [],
    remoteFullName: repo.remoteFullName || undefined,
    readme: String(repo.readme ?? '').slice(0, 2500),
  };
}

// Backwards-compatible name for callers that only pass GitHub data.
export function selectGithubProjects(github, career, job, limit = 12) {
  return selectProjects(github, null, career, job, limit);
}

function keywords(text) {
  const stopwords = new Set(
    'about above after again against all also and any are because been before being below between both but can could did does doing down during each few for from further had has have having here how into its itself just more most only other our out over own same should some such than that the their them then there these they this those through too under until very was were what when where which while who whom why will with would you your'.split(
      ' ',
    ),
  );
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9+#.]+/)
        .filter((word) => word.length > 2 && !stopwords.has(word)),
    ),
  ];
}
