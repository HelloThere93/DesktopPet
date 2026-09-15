// Keep this entrypoint dependency-light: importing the agent before this
// boundary would allow an unreadable tool module to crash Electron at launch.
import { app, BrowserWindow, dialog } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function reportStartupFailure(error: unknown): void {
  const failure = error as NodeJS.ErrnoException | null;
  const detail = (error instanceof Error ? error.stack ?? error.message : String(error)).slice(0, 16_000);
  console.error('Adi startup failed:', detail);
  let logPath = '';
  try {
    const logs = join(app.getPath('userData'), 'logs');
    mkdirSync(logs, { recursive: true });
    const path = join(logs, 'startup-error.log');
    // One bounded diagnostic file, not an ever-growing launch log.
    writeFileSync(path, new Date().toISOString() + '\n' + detail, 'utf8');
    logPath = path;
  } catch {
    /* stderr still has the error if the log folder is also inaccessible. */
  }
  const blocked = failure && ['EPERM', 'EACCES', 'EBUSY'].includes(failure.code ?? '');
  try {
    dialog.showErrorBox('Adi could not start', [
      blocked
        ? 'Windows could not read an Adi application file. Close extra copies of Adi and try again. If it keeps happening, repair or rebuild Adi.'
        : 'Adi could not finish starting. Repair or rebuild the app if reopening it does not help.',
      failure?.path ? 'File: ' + failure.path : '',
      failure?.code ? 'Error: ' + failure.code : '',
      logPath ? 'Details saved to: ' + logPath : detail.slice(0, 2_000),
    ].filter(Boolean).join('\n\n'));
  } finally {
    // Do not replay partially loaded modules or leave a windowless process
    // holding the instance lock after a failed startup.
    app.exit(1);
  }
}

try {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
  } else {
    let focusWhenReady = false;
    const focusExistingWindow = (): void => {
      const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
      if (!window) {
        focusWhenReady = true;
        return;
      }
      focusWhenReady = false;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    };
    app.on('second-instance', focusExistingWindow);
    app.on('browser-window-created', (_event, window) => {
      if (focusWhenReady) window.once('ready-to-show', focusExistingWindow);
    });
    require('./index');
  }
} catch (error) {
  reportStartupFailure(error);
}
