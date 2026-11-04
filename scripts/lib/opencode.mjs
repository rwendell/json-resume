import { spawnSync } from 'node:child_process';

const MAX_BUFFER = 100 * 1024 * 1024;

export function runOpencode({ prompt, agent, model, title, timeout, cwd }) {
  const args = ['run', '--agent', agent, '--format', 'json'];
  if (title) args.push('--title', title);
  if (model) args.push('--model', model);
  args.push(prompt);

  return spawnSync('opencode', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    timeout,
  });
}

export function parseOpencodeStats(stdout) {
  let stats = null;
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type !== 'step_finish' || !event.part) continue;
      stats ??= { cost: 0, input: 0, output: 0, reasoning: 0 };
      stats.cost += Number(event.part.cost) || 0;
      stats.input += Number(event.part.tokens?.input) || 0;
      stats.output += Number(event.part.tokens?.output) || 0;
      stats.reasoning += Number(event.part.tokens?.reasoning) || 0;
    } catch {
      // Ignore non-JSON log lines.
    }
  }
  return stats;
}

export function parseOpencodeOutput(stdout) {
  const texts = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === 'text' && event.part?.text) texts.push(event.part.text);
    } catch {
      // Ignore non-JSON log lines.
    }
  }

  const candidates = [...texts.reverse(), stdout];
  for (const text of candidates) {
    const parsed = extractJson(text);
    if (parsed && typeof parsed === 'object') return parsed;
  }
  return null;
}

export function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      // Fall through to brace scanning.
    }
  }

  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let end = start; end < text.length; end += 1) {
      const char = text[end];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            const value = JSON.parse(text.slice(start, end + 1));
            if (value && typeof value === 'object') return value;
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}
