import { spawnSync } from 'node:child_process';

export function copyToClipboard(text, { timeout = 5000 } = {}) {
  const attempts = [];

  for (const strategy of strategiesFor()) {
    attempts.push(strategy.command);
    const result = spawnSync(strategy.command, strategy.args, {
      input: String(text ?? ''),
      encoding: 'utf8',
      timeout,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    if (!result.error && result.status === 0) {
      return { copied: true, command: strategy.command, attempts };
    }
  }

  return { copied: false, attempts };
}

function strategiesFor() {
  if (process.platform === 'darwin') {
    return [{ command: 'pbcopy', args: [] }];
  }
  if (process.platform === 'win32') {
    return [{ command: 'clip', args: [] }];
  }

  return [
    { command: 'wl-copy', args: [] },
    { command: 'xclip', args: ['-selection', 'clipboard'] },
    { command: 'xsel', args: ['--clipboard', '--input'] },
    { command: 'clip.exe', args: [] },
    { command: 'termux-clipboard-set', args: [] },
  ];
}
