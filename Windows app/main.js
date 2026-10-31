const { app, BrowserWindow, dialog, Menu, shell } = require('electron');
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

// An installed copy must not keep the user's test cases inside its own install
// folder: every update deletes and rewrites that folder, and their runs, history
// and saved sign-in went with it. Keep them in the user's profile instead.
// Anything an earlier version left in the old place is copied across once.
function useUserDataFolder() {
  const dataDir = process.env.BDD_DATA_DIR || path.join(app.getPath('userData'), 'data');
  process.env.BDD_DATA_DIR = dataDir;
  fs.mkdirSync(dataDir, { recursive: true });

  const legacyRuns = path.join(PROJECT_ROOT, 'data', 'runs');
  const newRuns = path.join(dataDir, 'runs');
  try {
    const hasLegacy = fs.existsSync(legacyRuns) && fs.readdirSync(legacyRuns).length > 0;
    const hasNew = fs.existsSync(newRuns) && fs.readdirSync(newRuns).length > 0;
    if (hasLegacy && !hasNew) fs.cpSync(path.join(PROJECT_ROOT, 'data'), dataDir, { recursive: true });
  } catch (err) {
    console.error('Could not copy earlier test cases:', err.message);
  }
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

  // The page warns before it is left with unsaved edits (beforeunload). Electron
  // blocks that silently unless something answers, which would leave the window
  // impossible to close — so ask the user here.
  win.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Leave', 'Stay'],
      defaultId: 1,
      cancelId: 1,
      title: 'Unsaved changes',
      message: 'You have changes that are not saved yet.',
      detail: 'Changes are saved automatically a few seconds after you stop typing. Leave anyway?',
    });
    if (choice === 0) event.preventDefault(); // preventDefault here means: go ahead and leave
  });

  // Links to other sites (e.g. "open your site" in the sign-in steps) must open in
  // the user's real browser — that is where they are signed in — not in this window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

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
    if (app.isPackaged) useUserDataFolder();
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
