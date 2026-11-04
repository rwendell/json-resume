import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

export const PUBLIC_CAREER_FILE = 'data/career.yml';
export const PRIVATE_CAREER_FILE = 'data/career.private.yml';

/**
 * Load the public fact bank and merge the optional private overlay.
 *
 * The public file is safe to commit. The private file is gitignored and can
 * add achievements, projects, constraints, and source configuration without
 * duplicating the public base. Arrays merge by id/name/evidence so private
 * additions extend the public data instead of replacing it.
 */
export function loadCareer(rootDir, { optional = false } = {}) {
  const publicPath = resolve(rootDir, PUBLIC_CAREER_FILE);
  const privatePath = resolve(rootDir, PRIVATE_CAREER_FILE);

  if (!existsSync(publicPath)) {
    if (optional) {
      return { career: {}, publicPath: null, privatePath: null };
    }
    throw new Error(
      `Missing ${PUBLIC_CAREER_FILE}. Create a public career fact bank before running this command.`,
    );
  }

  const publicCareer = parseYaml(readFileSync(publicPath, 'utf8')) ?? {};
  if (!isPlainObject(publicCareer)) {
    throw new Error(`${PUBLIC_CAREER_FILE} must contain a YAML object.`);
  }

  const hasPrivate = existsSync(privatePath);
  const privateCareer = hasPrivate
    ? (parseYaml(readFileSync(privatePath, 'utf8')) ?? {})
    : {};
  if (!isPlainObject(privateCareer)) {
    throw new Error(`${PRIVATE_CAREER_FILE} must contain a YAML object.`);
  }

  return {
    career: mergeCareer(publicCareer, privateCareer),
    publicPath,
    privatePath: hasPrivate ? privatePath : null,
  };
}

export function mergeCareer(publicCareer, privateCareer) {
  return mergeValue(publicCareer, privateCareer);
}

function mergeValue(base, overlay) {
  if (overlay === undefined) return base;
  if (base === undefined) return overlay;

  if (Array.isArray(base) && Array.isArray(overlay)) {
    return mergeArray(base, overlay);
  }

  if (isPlainObject(base) && isPlainObject(overlay)) {
    const result = { ...base };
    for (const [key, value] of Object.entries(overlay)) {
      result[key] = mergeValue(base[key], value);
    }
    return result;
  }

  return overlay;
}

function mergeArray(base, overlay) {
  if (overlay.length === 0) return base;
  if (base.length === 0) return overlay;

  if (
    base.every((value) => typeof value === 'string') &&
    overlay.every((value) => typeof value === 'string')
  ) {
    return [...new Set([...base, ...overlay])];
  }

  const key = arrayKey([...base, ...overlay]);
  if (!key) return overlay;

  const result = [...base];
  const positions = new Map();
  result.forEach((item, index) => {
    if (isPlainObject(item) && item[key] != null) {
      positions.set(String(item[key]), index);
    }
  });

  for (const item of overlay) {
    const id = isPlainObject(item) ? item[key] : null;
    if (id == null || !positions.has(String(id))) {
      result.push(item);
      if (id != null) positions.set(String(id), result.length - 1);
      continue;
    }
    const index = positions.get(String(id));
    result[index] = mergeValue(result[index], item);
  }

  return result;
}

function arrayKey(items) {
  const objects = items.filter(isPlainObject);
  if (objects.length !== items.length || objects.length === 0) return null;

  for (const key of ['id', 'name', 'evidence', 'network', 'institution']) {
    if (objects.every((item) => item[key] != null)) return key;
  }
  return null;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
