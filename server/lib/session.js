// Borrowing a signed-in session from the user's own Chrome.
//
// `npm run login` drives a Playwright browser, which some sites refuse and which
// needs the user to sign in again. This path avoids both: the user runs a snippet
// in the browser they are ALREADY signed into, pastes the result back, and we
// convert it to a Playwright storageState file the headless browser can load.
//
// Hard limitation, stated plainly because it decides whether this works at all:
// JavaScript cannot read HttpOnly cookies. Sites that keep their session in an
// HttpOnly cookie (most traditional server-rendered apps) will not be captured by
// the snippet. Sites that keep a token in localStorage/sessionStorage (most modern
// SPAs) will be. For the former, the user must paste a real Playwright
// storageState file instead, which we also accept.

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const STORAGE_STATE_PATH = path.join(DATA_DIR, 'storage-state.json');
// The full browser profile `npm run login` builds by driving a real sign-in.
const PROFILE_DIR = path.join(PROJECT_ROOT, '.browser-profile');
const MAX_PASTE_BYTES = 1024 * 1024;

function hasLoginProfile() {
  return fs.existsSync(PROFILE_DIR) && fs.readdirSync(PROFILE_DIR).length > 0;
}

// Two ways to be signed in, checked in this preference order everywhere a
// browser gets launched (the MCP-driven path in claudeCli.js and the
// deterministic crawler in crawler.js both call this, so they never disagree):
//   1. A storage state pasted from the user's own Chrome (no second sign-in).
//   2. A full profile built by `npm run login`.
//   3. Neither — launch signed out.
function sessionKind() {
  if (hasStorageState()) return 'storageState';
  if (hasLoginProfile()) return 'profile';
  return 'none';
}

function hasAnySession() {
  return sessionKind() !== 'none';
}

// Runs in the user's own DevTools console. `copy()` is a DevTools helper, so the
// result lands on the clipboard ready to paste straight back into the app.
const BROWSER_SNIPPET = `(() => {
  const readAll = (store) => {
    const out = [];
    try {
      for (let i = 0; i < store.length; i++) {
        const name = store.key(i);
        out.push({ name, value: store.getItem(name) });
      }
    } catch (e) {}
    return out;
  };

  const cookies = document.cookie
    .split('; ')
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf('=');
      return eq === -1
        ? { name: pair, value: '' }
        : { name: pair.slice(0, eq), value: pair.slice(eq + 1) };
    });

  const payload = {
    kind: 'bdd-test-generator/browser-session',
    origin: location.origin,
    capturedAt: new Date().toISOString(),
    cookies,
    localStorage: readAll(window.localStorage),
    sessionStorage: readAll(window.sessionStorage),
  };

  const json = JSON.stringify(payload);
  try {
    copy(json);
    console.log('%c Session copied. Paste it back into the test generator. ', 'background:#1a9e5c;color:#fff');
  } catch (e) {
    console.log('Could not auto-copy. Select and copy the line below:');
    console.log(json);
  }
  console.log('Captured', cookies.length, 'cookies,', payload.localStorage.length, 'localStorage and', payload.sessionStorage.length, 'sessionStorage entries.');
  if (!cookies.length && !payload.localStorage.length && !payload.sessionStorage.length) {
    console.warn('Nothing was captured. Make sure you are signed in and on the app itself, not a login redirect.');
  }
  return payload;
})()`;

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function hasStorageState() {
  return fs.existsSync(STORAGE_STATE_PATH);
}

function storageStatePath() {
  return STORAGE_STATE_PATH;
}

function clearStorageState() {
  if (fs.existsSync(STORAGE_STATE_PATH)) fs.unlinkSync(STORAGE_STATE_PATH);
}

// Already a Playwright storageState? Then the user exported a proper one (which
// DOES include HttpOnly cookies) and we should keep it as-is.
function looksLikePlaywrightState(obj) {
  return obj && Array.isArray(obj.cookies) && Array.isArray(obj.origins);
}

function toPlaywrightState(payload) {
  let origin;
  try {
    origin = new URL(payload.origin);
  } catch {
    throw new Error('The pasted session has no valid origin. Re-run the snippet on the site you want to test.');
  }

  const secure = origin.protocol === 'https:';
  const cookies = (payload.cookies || [])
    .filter((c) => c && c.name)
    .map((c) => ({
      name: String(c.name),
      value: String(c.value ?? ''),
      domain: origin.hostname,
      path: '/',
      expires: -1, // session cookie; the browser drops it when the context closes
      httpOnly: false,
      secure,
      sameSite: 'Lax',
    }));

  const localStorage = (payload.localStorage || [])
    .filter((e) => e && e.name != null)
    .map((e) => ({ name: String(e.name), value: String(e.value ?? '') }));

  return {
    cookies,
    origins: localStorage.length ? [{ origin: origin.origin, localStorage }] : [],
  };
}

// Accepts either the snippet's output or a real Playwright storageState file, and
// reports back what it actually captured so a silent no-op is impossible.
function saveFromPaste(text) {
  const raw = String(text ?? '').trim();
  if (!raw) throw new Error('Paste the session first.');
  if (Buffer.byteLength(raw, 'utf8') > MAX_PASTE_BYTES) {
    throw new Error('That session blob is too large (limit 1 MB).');
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`That is not valid JSON. Copy the whole line the snippet produced. (${e.message})`);
  }

  const isPlaywrightState = looksLikePlaywrightState(parsed);
  const state = isPlaywrightState ? parsed : toPlaywrightState(parsed);

  const cookieCount = state.cookies.length;
  const localStorageCount = state.origins.reduce((n, o) => n + (o.localStorage?.length || 0), 0);

  if (!cookieCount && !localStorageCount) {
    throw new Error('That session is empty — no cookies and no stored values. Make sure you ran the snippet while signed in, on the app itself rather than a login page.');
  }

  ensureDataDir();
  fs.writeFileSync(STORAGE_STATE_PATH, JSON.stringify(state, null, 2), 'utf8');

  const origins = state.origins.map((o) => o.origin);
  const sessionStorageCount = isPlaywrightState ? 0 : (parsed.sessionStorage || []).length;

  return {
    cookieCount,
    localStorageCount,
    sessionStorageCount,
    origin: origins[0] || (parsed.origin ?? null),
    format: isPlaywrightState ? 'playwright' : 'snippet',
    // Surfaced to the UI rather than buried, because these decide whether the
    // borrowed session will actually work.
    warnings: [
      ...(isPlaywrightState
        ? []
        : ['JavaScript cannot read HttpOnly cookies, so if this site keeps its session in one it was not captured. If the borrowed session does not work, export a Playwright storage state instead and paste that.']),
      ...(sessionStorageCount
        ? [`${sessionStorageCount} sessionStorage entr${sessionStorageCount === 1 ? 'y was' : 'ies were'} found but cannot be restored — Playwright only replays cookies and localStorage. If the app keeps its token in sessionStorage, this route will not work for it.`]
        : []),
    ],
  };
}

function describe() {
  if (!hasStorageState()) return { available: false };
  try {
    const state = JSON.parse(fs.readFileSync(STORAGE_STATE_PATH, 'utf8'));
    const { mtime } = fs.statSync(STORAGE_STATE_PATH);
    return {
      available: true,
      cookieCount: state.cookies?.length || 0,
      localStorageCount: (state.origins || []).reduce((n, o) => n + (o.localStorage?.length || 0), 0),
      origin: state.origins?.[0]?.origin || null,
      savedAt: mtime.toISOString(),
    };
  } catch {
    return { available: false };
  }
}

module.exports = {
  BROWSER_SNIPPET,
  STORAGE_STATE_PATH,
  PROFILE_DIR,
  hasStorageState,
  hasLoginProfile,
  sessionKind,
  hasAnySession,
  storageStatePath,
  clearStorageState,
  saveFromPaste,
  describe,
  toPlaywrightState,
};
