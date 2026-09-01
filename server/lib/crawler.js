// Fast, deterministic site discovery — no LLM call at all. Launches a real
// headless browser directly via playwright-core (the same dependency
// scripts/login.js already uses) and does a same-origin BFS over <a href>
// links, reading each page's title and inspecting its DOM for forms/login
// walls. This replaces the slow path of asking the model to navigate every
// page itself one at a time inside a single agentic turn (see discoverPages
// in claudeCli.js) — that path still exists as the fallback for JS-only sites
// with no real anchor tags to crawl.

const { chromium } = require('playwright-core');
const sessionStore = require('./session');
const urls = require('./urls');

const CONCURRENCY = 3;
const NAV_TIMEOUT_MS = 15000;
const SETTLE_TIMEOUT_MS = 4000;
const DEFAULT_BUDGET_MS = 90 * 1000;

const LOGIN_PATH_RE = /\b(login|log-in|signin|sign-in|sso|auth|authenticate)\b/i;

async function openContext(useSession) {
  const kind = useSession ? sessionStore.sessionKind() : 'none';

  if (kind === 'profile') {
    // A persistent-profile context IS the browser — no separate launch step.
    const context = await chromium.launchPersistentContext(sessionStore.PROFILE_DIR, {
      headless: true,
    });
    return { context, browser: null };
  }

  const browser = await chromium.launch({ headless: true });
  const context = kind === 'storageState'
    ? await browser.newContext({ storageState: sessionStore.storageStatePath() })
    : await browser.newContext();
  return { context, browser };
}

async function inspectPage(context, url) {
  const page = await context.newPage();
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    // Best-effort settle for client-rendered content; a page that never goes
    // idle (polling, websockets) shouldn't hold up the whole crawl.
    await page.waitForLoadState('networkidle', { timeout: SETTLE_TIMEOUT_MS }).catch(() => {});

    const finalUrl = page.url();
    const status = response ? response.status() : null;

    const [title, hasForm, hasPasswordField, hrefs] = await Promise.all([
      page.title().catch(() => ''),
      page.evaluate(() => {
        const inputs = document.querySelectorAll(
          'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea'
        );
        return document.querySelectorAll('form').length > 0 || inputs.length > 0;
      }).catch(() => false),
      page.evaluate(() => !!document.querySelector('input[type="password"]')).catch(() => false),
      page.$$eval('a[href]', (as) => as.map((a) => a.getAttribute('href'))).catch(() => []),
    ]);

    const requiresLogin = Boolean(
      status === 401 || status === 403 || LOGIN_PATH_RE.test(finalUrl) || hasPasswordField
    );

    return { ok: true, finalUrl, title, hasForm, requiresLogin, hrefs };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    await page.close().catch(() => {});
  }
}

// Same-origin BFS with a small worker pool. Returns as soon as `maxPages` is
// reached or the time budget runs out — partial results are still useful,
// never nothing.
async function crawlSite({ url, maxPages = 12, useSession = false, budgetMs = DEFAULT_BUDGET_MS, onProgress }) {
  const emit = (msg) => { if (onProgress) onProgress(msg); };
  const origin = urls.originOf(url);
  if (!origin) throw new Error('That is not a valid URL to explore.');

  const deadline = Date.now() + budgetMs;
  const seen = new Set([urls.dedupeKey(url)]);
  const queue = [url];
  const pages = [];

  emit(useSession && sessionStore.sessionKind() !== 'none'
    ? 'Opening a signed-in browser'
    : 'Opening a browser');
  const { context, browser } = await openContext(useSession);

  try {
    let cursor = 0;
    async function worker() {
      while (cursor < queue.length && pages.length < maxPages && Date.now() < deadline) {
        const current = queue[cursor++];
        emit(`Opening ${current}`);
        const result = await inspectPage(context, current);

        if (!result.ok) {
          pages.push({ url: current, title: current, purpose: '', hasForm: false, requiresLogin: false, failed: true });
          continue;
        }

        const key = urls.dedupeKey(result.finalUrl);
        // The page may have redirected somewhere already queued/seen.
        if (pages.some((p) => urls.dedupeKey(p.url) === key)) continue;

        pages.push({
          url: result.finalUrl,
          title: result.title || result.finalUrl,
          purpose: '',
          hasForm: result.hasForm,
          requiresLogin: result.requiresLogin,
        });

        for (const href of result.hrefs) {
          if (pages.length + queue.length - cursor >= maxPages) break;
          const absolute = urls.resolveSameOrigin(href, result.finalUrl, origin);
          if (!absolute || !urls.looksLikePage(absolute)) continue;
          const linkKey = urls.dedupeKey(absolute);
          if (seen.has(linkKey)) continue;
          seen.add(linkKey);
          queue.push(absolute);
        }
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  } finally {
    // A persistent-profile context has no separate `browser` to close.
    await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }

  return { pages: pages.slice(0, maxPages), rootUrl: url };
}

module.exports = { crawlSite };
