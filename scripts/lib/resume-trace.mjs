/**
 * Lightweight completeness check for a model draft.
 *
 * The full verifier runs later. This catches the common failure where the
 * resume has a bullet but the trace omitted its receipt, so the provider chain
 * can try the next model instead of stopping at final verification.
 */
export function hasTraceCoverage(resume, trace) {
  if (!resume || typeof resume !== 'object') return false;
  if (!trace || typeof trace !== 'object') return false;

  const bulletPaths = new Set(
    (Array.isArray(trace.bullets) ? trace.bullets : [])
      .map((entry) => entry?.path)
      .filter(Boolean),
  );
  const projectNames = new Set(
    (Array.isArray(trace.projects) ? trace.projects : [])
      .map((entry) => entry?.name)
      .filter(Boolean),
  );

  for (const [workIndex, work] of (resume.work ?? []).entries()) {
    const highlights = Array.isArray(work.highlights) ? work.highlights : [];
    for (let highlightIndex = 0; highlightIndex < highlights.length; highlightIndex += 1) {
      if (
        !bulletPaths.has(`work[${workIndex}].highlights[${highlightIndex}]`)
      ) {
        return false;
      }
    }
  }

  for (const [projectIndex, project] of (resume.projects ?? []).entries()) {
    if (!projectNames.has(project.name)) return false;
    const highlights = Array.isArray(project.highlights)
      ? project.highlights
      : [];
    for (let highlightIndex = 0; highlightIndex < highlights.length; highlightIndex += 1) {
      if (
        !bulletPaths.has(
          `projects[${projectIndex}].highlights[${highlightIndex}]`,
        )
      ) {
        return false;
      }
    }
  }

  return true;
}
