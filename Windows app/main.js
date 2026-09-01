const { app, BrowserWindow, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { execFileSync, execSync } = require('child_process');

const PORT = process.env.PORT || 4173;
const SERVER_URL = `http://localhost:${PORT}`;
// In dev, server/public/node_modules live one level up from this folder. In
// an installed build, electron-builder copies them under resources/ instead
// (see the "extraResources" block in package.json) since asar can't hold a
// live node_modules or double as writable storage for data/.
const PROJECT_ROOT = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');

// server/index.js reads .env via a bare `require('dotenv').config()`, which
// resolves against process.cwd() — match what start.bat gives it (the
// project root) instead of this folder, or a real .env would go unread.
process.chdir(PROJECT_ROOT);

// Same fallback chain as start.bat's claude detection: `where` can miss a
// claude install that landed on PATH after this process's environment was
// snapshotted, so also check the two known install locations directly.
function findClaudeCli() {
  try {
    execFileSync('where', ['claude'], { stdio: 'ignore' });
    return true;
  } catch {}

  if (fs.existsSync(path.join(os.homedir(), '.local', 'bin', 'claude.exe'))) return true;

  // npm resolves to npm.cmd on Windows, which execFileSync can't launch
  // directly (same reason claudeCli.js needs shell:true for claude.cmd) — a
  // plain string through execSync goes via the shell without the args-array
  // escaping caveat that trips Node's DEP0190 warning.
  try {
    const prefix = execSync('npm config get prefix', { encoding: 'utf8' }).trim();
    if (prefix && fs.existsSync(path.join(prefix, 'claude.cmd'))) return true;
  } catch {}

  return false;
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

function loadWhenReady(win, attempt = 0) {
  win.loadURL(SERVER_URL).catch(() => {
    if (attempt > 40) {
      dialog.showErrorBox('BDD Test Generator', 'The local server did not start in time.');
      return;
    }
    setTimeout(() => loadWhenReady(win, attempt + 1), 250);
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'BDD Test Generator',
    icon: path.join(PROJECT_ROOT, 'public', 'favicon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  Menu.setApplicationMenu(null);
  loadWhenReady(win);
}

app.whenReady().then(async () => {
  if (!findClaudeCli()) {
    dialog.showMessageBoxSync({
      type: 'warning',
      title: 'Claude Code not found',
      message: 'The "claude" CLI was not found on PATH.',
      detail:
        'Generating test cases needs Claude Code installed and logged in. ' +
        'The app will still open, but generation will fail until it is installed.',
    });
  }

  // Another launch (start.bat, or a second copy of this app) may already be
  // serving this port — reuse it instead of crashing on EADDRINUSE.
  if (!(await isPortOpen(PORT))) {
    require(path.join(PROJECT_ROOT, 'server', 'index.js'));
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
