import { spawnSync } from 'node:child_process';

/**
 * Open a file with the first available desktop opener.
 *
 * Linux order: open, xdg-open, KDE, GNOME, gio, XFCE, WSL, and common
 * distro-specific fallbacks. macOS uses open; Windows uses start.
 */
export function openFile(filePath, { timeout = 5000 } = {}) {
  const strategies = strategiesFor(filePath);
  const attempts = [];

  for (const strategy of strategies) {
    attempts.push(strategy.command);
    const result = spawnSync(strategy.command, strategy.args, {
      stdio: 'ignore',
      timeout,
    });
    if (!result.error && result.status === 0) {
      return { opened: true, command: strategy.command, attempts };
    }
  }

  return { opened: false, attempts };
}

function strategiesFor(filePath) {
  if (process.platform === 'darwin') {
    return [{ command: 'open', args: [filePath] }];
  }

  if (process.platform === 'win32') {
    return [{ command: 'cmd', args: ['/c', 'start', '', filePath] }];
  }

  return [
    { command: 'open', args: [filePath] },
    { command: 'xdg-open', args: [filePath] },
    { command: 'kde-open', args: [filePath] },
    { command: 'kde-open5', args: [filePath] },
    { command: 'kde-open6', args: [filePath] },
    { command: 'gnome-open', args: [filePath] },
    { command: 'gio', args: ['open', filePath] },
    { command: 'exo-open', args: [filePath] },
    { command: 'wslview', args: [filePath] },
    { command: 'sensible-browser', args: [filePath] },
    { command: 'handlr', args: ['open', filePath] },
    { command: 'rifle', args: [filePath] },
  ];
}
