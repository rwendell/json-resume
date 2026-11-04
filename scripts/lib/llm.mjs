/**
 * Model-provider selection with fallback.
 *
 * The OpenCode CLI can address every configured provider through `--model`.
 * That keeps the agents, permissions, and JSONL parsing identical no matter
 * which account pays for the run:
 *
 *   auto        OpenCode free -> OpenCode Go -> OpenRouter
 *   opencode    OpenCode free model
 *   go          OpenCode Go subscription (cheap coding model by default)
 *   openrouter  OpenRouter credit (cheap coding model by default)
 *
 * A failed provider is retried only when it exits non-zero, returns no JSON
 * object, or returns JSON that does not match the caller's contract. This also
 * covers the "free usage exhausted" response from the default model.
 */
import {
  parseOpencodeOutput,
  parseOpencodeStats,
  runOpencode,
} from './opencode.mjs';

// DeepSeek V4.1 Flash defaults to the high thinking effort. Pin #high
// explicitly so a session-level #max selection cannot leak into scripted runs.
// Use #low when speed matters more than the extra reasoning.
export const DEFAULT_OPENCODE_MODEL =
  'opencode/deepseek-v4.1-flash-free#high';
export const DEFAULT_GO_MODEL = 'opencode-go/deepseek-v4.1-flash#high';
export const DEFAULT_OPENROUTER_MODEL =
  'openrouter/deepseek/deepseek-v4.1-flash-1017#high';

const PROVIDER_LABELS = {
  opencode: 'OpenCode',
  go: 'OpenCode Go',
  openrouter: 'OpenRouter',
};

const PROVIDER_ALIASES = new Map([
  ['auto', 'auto'],
  ['opencode', 'opencode'],
  ['default', 'opencode'],
  ['free', 'opencode'],
  ['go', 'go'],
  ['opencode-go', 'go'],
  ['openrouter', 'openrouter'],
  ['or', 'openrouter'],
]);

export class LlmError extends Error {
  constructor(attempts, raw) {
    super(formatFailure(attempts));
    this.name = 'LlmError';
    this.attempts = attempts;
    this.raw = raw;
  }
}

export function resolveProviderChain({ provider, model } = {}) {
  const requested = normalizeProvider(
    provider || process.env.RESUME_LLM_PROVIDER || 'auto',
  );

  if (requested === 'auto') {
    // An explicit model deliberately bypasses fallback. This preserves the
    // existing `--model provider/model` behavior for users who want one exact
    // model and no surprise spending.
    if (model) return [createTarget('opencode', model)];

    return [
      createTarget(
        'opencode',
        process.env.OPENCODE_MODEL || DEFAULT_OPENCODE_MODEL,
      ),
      createTarget(
        'go',
        process.env.OPENCODE_GO_MODEL
          ? normalizeModelForProvider('go', process.env.OPENCODE_GO_MODEL)
          : DEFAULT_GO_MODEL,
      ),
      createTarget(
        'openrouter',
        process.env.OPENROUTER_MODEL
          ? normalizeModelForProvider(
              'openrouter',
              process.env.OPENROUTER_MODEL,
            )
          : DEFAULT_OPENROUTER_MODEL,
      ),
    ];
  }

  const targetModel = model
    ? normalizeModelForProvider(requested, model)
    : defaultModelForProvider(requested);
  return [createTarget(requested, targetModel)];
}

export function runAgent({
  prompt,
  agent,
  title,
  timeout,
  cwd,
  provider,
  model,
  accept,
  onAttempt,
}) {
  const chain = resolveProviderChain({ provider, model });
  const attempts = [];
  let lastRaw = '';

  for (const [index, target] of chain.entries()) {
    const label = target.model
      ? `${target.label} (${target.model})`
      : `${target.label} (default model)`;
    const context = {
      index,
      total: chain.length,
      target,
      label,
    };

    onAttempt?.({ ...context, phase: 'start' });

    const result = runOpencode({
      prompt,
      agent,
      model: target.model,
      title,
      timeout,
      cwd,
    });
    const raw = result.stdout || '';
    if (raw) lastRaw = raw;
    const stderr = result.stderr || '';

    if (result.error) {
      const reason = truncate(result.error.message, 1200);
      attempts.push({ ...context, reason, status: result.status, stderr });
      onAttempt?.({ ...context, phase: 'failed', reason });
      continue;
    }

    if (result.status !== 0) {
      const detail = truncate(stderr.trim(), 1200);
      const reason = `exited with status ${result.status}${detail ? `: ${detail}` : ''}`;
      attempts.push({ ...context, reason, status: result.status, stderr, raw });
      onAttempt?.({ ...context, phase: 'failed', reason });
      continue;
    }

    const output = parseOpencodeOutput(raw);
    if (!output) {
      const reason = 'did not return a JSON object';
      attempts.push({ ...context, reason, status: 0, stderr, raw });
      onAttempt?.({ ...context, phase: 'failed', reason });
      continue;
    }

    if (accept && !accept(output)) {
      const reason = 'returned JSON that does not match the expected shape';
      attempts.push({ ...context, reason, status: 0, stderr, raw });
      onAttempt?.({ ...context, phase: 'failed', reason });
      continue;
    }

    const stats = parseOpencodeStats(raw);
    onAttempt?.({ ...context, phase: 'succeeded', stats });
    return {
      output,
      provider: target,
      model: target.model,
      raw,
      stats,
      attempts,
    };
  }

  throw new LlmError(attempts, lastRaw);
}

function normalizeProvider(value) {
  const key = String(value ?? '')
    .trim()
    .toLowerCase();
  const provider = PROVIDER_ALIASES.get(key);
  if (!provider) {
    throw new Error(
      `Unknown provider "${value}". Use auto, opencode, go, or openrouter.`,
    );
  }
  return provider;
}

function defaultModelForProvider(provider) {
  if (provider === 'opencode') {
    return process.env.OPENCODE_MODEL || DEFAULT_OPENCODE_MODEL;
  }
  if (provider === 'go') {
    return process.env.OPENCODE_GO_MODEL
      ? normalizeModelForProvider('go', process.env.OPENCODE_GO_MODEL)
      : DEFAULT_GO_MODEL;
  }
  return process.env.OPENROUTER_MODEL
    ? normalizeModelForProvider('openrouter', process.env.OPENROUTER_MODEL)
    : DEFAULT_OPENROUTER_MODEL;
}

function normalizeModelForProvider(provider, model) {
  const value = String(model).trim();
  if (provider === 'go' && !value.includes('/')) {
    return `opencode-go/${value}`;
  }
  if (provider === 'openrouter' && !value.startsWith('openrouter/')) {
    return `openrouter/${value}`;
  }
  return value;
}

function createTarget(name, model) {
  const inferred = model?.startsWith('opencode-go/')
    ? 'go'
    : model?.startsWith('openrouter/')
      ? 'openrouter'
      : name;
  return {
    name,
    label: PROVIDER_LABELS[inferred],
    model: model || null,
  };
}

function formatFailure(attempts) {
  const lines = [
    attempts.length === 1
      ? 'Model request failed.'
      : 'All model providers failed.',
  ];
  attempts.forEach((attempt, index) => {
    lines.push(`  ${index + 1}. ${attempt.label}: ${attempt.reason}`);
  });
  lines.push(
    'Pass --provider opencode|go|openrouter to force one, or set RESUME_LLM_PROVIDER.',
  );
  return lines.join('\n');
}

function truncate(value, length) {
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}
