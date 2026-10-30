// "Sign in here": opens a real, visible browser on the site, the user signs in
// themselves (Google SSO, MFA, whatever), closes the window, and later headless
// runs reuse that profile.
//
// This is the in-app version of `npm run login`. Unlike the console snippet it
// also captures HttpOnly cookies, which is what most server-rendered apps keep
// their session in. The credentials are typed only into the user's own browser —
// never seen by this app or the model.

const { chromium } = require('playwright-core');
const sessionStore = require('./session');

let current = null; // { url, startedAt, closed }

// Same preference as the login script: the real Chrome install is far more
// tolerated by Google than the bundled Chromium, and an installed build ships
// without Playwright's own browsers, so the channels are not optional.
const ATTEMPTS = [
  { channel: 'chrome', label: 'Google Chrome' },
  { channel: 'msedge', label: 'Microsoft Edge' },
  { label: 'the bundled browser' },
];

async function launch() {
  let lastError;
  for (const attempt of ATTEMPTS) {
    try {
      const context = await chromium.launchPersistentContext(sessionStore.PROFILE_DIR, {
        headless: false,
        viewport: null,
        args: ['--start-maximized'],
        ...(attempt.channel ? { channel: attempt.channel } : {}),
      });
      return { context, browserLabel: attempt.label };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

async function start(url) {
  if (current && !current.closed) {
    const err = new Error('A sign-in window is already open. Sign in there and close it, or close it to start again.');
    err.status = 409;
    throw err;
  }

  let launched;
  try {
    launched = await launch();
  } catch (err) {
    const e = new Error(`Could not open a browser window: ${String(err.message).split('\n')[0]}. Install Google Chrome or Microsoft Edge and try again.`);
    e.status = 500;
    throw e;
  }

  const { context, browserLabel } = launched;
  current = { url, startedAt: Date.now(), closed: false, browserLabel };
  const state = current;

  context.on('close', () => {
    state.closed = true;
    // A pasted session outranks a profile everywhere (see sessionKind), so a
    // fresh deliberate sign-in has to replace it or the new login would be ignored.
    // A window closed within seconds was opened by mistake, not used to sign in —
    // that must not cost anyone a session they had already saved.
    if (Date.now() - state.startedAt > 15000) sessionStore.clearStorageState();
  });

  const page = context.pages()[0] || (await context.newPage());
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  return { browser: browserLabel };
}

function status() {
  return {
    open: Boolean(current && !current.closed),
    url: current?.url || null,
    profileSaved: sessionStore.hasLoginProfile(),
  };
}

module.exports = { start, status };
