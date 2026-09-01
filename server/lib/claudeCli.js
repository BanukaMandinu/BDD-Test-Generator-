const spawn = require('cross-spawn');
const fs = require('fs');
const path = require('path');
const {
  SYSTEM_PROMPT,
  buildDiscoverUserPrompt,
  buildDiscoverPurposesPrompt,
  buildMultiPagePrompt,
  buildGenerateUserPrompt,
  buildRecordedFlowsPrompt,
  buildRecordedFlowsAppendPrompt,
  buildRefineUserPrompt,
  buildFillGapsUserPrompt,
  buildUpdateUserPrompt,
  buildScenarioFromTitlePrompt,
  buildUpdateAllUserPrompt,
} = require('./prompts');
const sessionStore = require('./session');
const { crawlSite } = require('./crawler');
const urls = require('./urls');

const MODEL = process.env.CLAUDE_MODEL || 'sonnet';
const CLI_TIMEOUT_MS = Number(process.env.CLI_TIMEOUT_MS || 6 * 60 * 1000);
const PER_PAGE_TIMEOUT_MS = 3 * 60 * 1000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const MCP_CONFIG = path.join(__dirname, '..', '..', 'mcp', 'playwright.json');
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const PROFILE_MCP_CONFIG = path.join(PROJECT_ROOT, 'mcp', 'playwright-profile.generated.json');

// SYSTEM_PROMPT is ~6.5k characters. Passed as a literal --system-prompt
// argument it ate most of cmd.exe's ~8,191-char command-line limit on
// Windows (cross-spawn has to route through cmd.exe there — see the comment
// on runClaude below), and tipped over it entirely once --allowedTools/
// --mcp-config were added for browsing. Writing it to disk once and passing
// --system-prompt-file keeps the command line short regardless of how many
// browser tools or session options are also in play.
const SYSTEM_PROMPT_FILE = path.join(PROJECT_ROOT, 'mcp', 'system-prompt.generated.txt');
fs.mkdirSync(path.dirname(SYSTEM_PROMPT_FILE), { recursive: true });
fs.writeFileSync(SYSTEM_PROMPT_FILE, SYSTEM_PROMPT, 'utf8');
// Matches a full https?:// URL, but also a bare domain typed without a
// protocol ("learnwithice.com", "www.example.com") — people very often paste
// just the domain, and treating that as plain text instead of a link was a
// real, reported usability bug. On its own this shape also matches ordinary
// dotted identifiers in plain prose ("update the config.json file", "check
// order.total") — isPlausibleDomain() below guards against that.
const URL_PATTERN = /(?:https?:\/\/)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?:\/[^\s]*)?/i;

// A bare match (no http(s):// or www.) is only trusted as a real domain when
// its last label is a TLD people actually register sites under — otherwise
// "config.json", "order.total", "report.pdf" in ordinary requirement text get
// misread as links. Not exhaustive (no public-suffix-list lookup), just wide
// enough to cover the common cases without swallowing everyday prose.
const COMMON_TLDS = new Set([
  'com', 'org', 'net', 'io', 'dev', 'app', 'co', 'edu', 'gov', 'mil', 'info',
  'biz', 'me', 'ai', 'xyz', 'tv', 'tech', 'online', 'site', 'store', 'shop',
  'blog', 'cloud', 'page', 'run', 'top', 'live', 'work', 'world', 'agency',
  'company', 'team', 'digital', 'name', 'pro', 'club', 'design', 'studio',
  'uk', 'us', 'ca', 'au', 'nz', 'de', 'fr', 'es', 'it', 'nl', 'se', 'no',
  'dk', 'fi', 'pl', 'ru', 'jp', 'cn', 'in', 'br', 'mx', 'ie', 'ch', 'at',
  'be', 'pt', 'gr', 'cz', 'sg', 'hk', 'kr', 'za', 'id', 'ph', 'th', 'vn',
]);

function isPlausibleDomain(candidate) {
  if (/^https?:\/\//i.test(candidate) || /^www\./i.test(candidate)) return true;
  const host = candidate.split('/')[0];
  const tld = host.split('.').pop().toLowerCase();
  return COMMON_TLDS.has(tld);
}

// "Is a session available" — session.js owns the actual preference order
// (storage state, then a login profile, then none) so this and crawler.js
// never disagree about it.
const hasSavedSession = sessionStore.hasAnySession;

// Isolated profile + the borrowed cookies/localStorage. Isolated is deliberate:
// nothing persists between runs except the state we were handed.
function writeStorageStateConfig() {
  const config = {
    mcpServers: {
      playwright: {
        type: 'stdio',
        command: 'npx',
        args: [
          '@playwright/mcp@latest',
          '--headless',
          '--isolated',
          `--storage-state=${sessionStore.storageStatePath()}`,
        ],
        env: {},
      },
    },
  };
  fs.mkdirSync(path.dirname(PROFILE_MCP_CONFIG), { recursive: true });
  fs.writeFileSync(PROFILE_MCP_CONFIG, JSON.stringify(config, null, 2), 'utf8');
  return PROFILE_MCP_CONFIG;
}

// Picks whichever signed-in route is available, falling back to the throwaway
// profile when neither is.
function sessionMcpConfig() {
  const kind = sessionStore.sessionKind();
  if (kind === 'storageState') return writeStorageStateConfig();
  if (kind === 'profile') return writeProfileConfig();
  return MCP_CONFIG;
}

// Written at call time so the profile path is absolute — a relative one would
// resolve against whatever directory the CLI happened to be spawned from.
function writeProfileConfig() {
  const config = {
    mcpServers: {
      playwright: {
        type: 'stdio',
        command: 'npx',
        args: ['@playwright/mcp@latest', '--headless', `--user-data-dir=${sessionStore.PROFILE_DIR}`],
        env: {},
      },
    },
  };
  fs.mkdirSync(path.dirname(PROFILE_MCP_CONFIG), { recursive: true });
  fs.writeFileSync(PROFILE_MCP_CONFIG, JSON.stringify(config, null, 2), 'utf8');
  return PROFILE_MCP_CONFIG;
}

// Browser tools the agent may use. Read-only set is always safe: it can look at
// a page but never change anything. The interactive set additionally lets it
// fill and submit forms so it can capture real validation copy — opt-in only,
// and the prompt forbids destructive actions either way.
// browser_find searches the page for elements and is read-only, so it's safe and
// genuinely useful when crawling. browser_evaluate is deliberately NOT here: it
// runs arbitrary JavaScript in the page, which is an action, not a look.
const READONLY_BROWSER_TOOLS = [
  'mcp__playwright__browser_navigate',
  'mcp__playwright__browser_snapshot',
  'mcp__playwright__browser_find',
  'mcp__playwright__browser_console_messages',
  'mcp__playwright__browser_wait_for',
  'mcp__playwright__browser_close',
];

const INTERACTIVE_BROWSER_TOOLS = [
  ...READONLY_BROWSER_TOOLS,
  'mcp__playwright__browser_click',
  'mcp__playwright__browser_type',
  'mcp__playwright__browser_fill_form',
  'mcp__playwright__browser_select_option',
  'mcp__playwright__browser_press_key',
  'mcp__playwright__browser_hover',
  'mcp__playwright__browser_navigate_back',
];

// Turns a raw tool_use block into a short human-readable progress line.
function describeToolUse(name, input) {
  const short = String(name).replace('mcp__playwright__browser_', '');
  switch (short) {
    case 'navigate': return `Opening ${input?.url || 'page'}`;
    case 'navigate_back': return 'Going back';
    case 'snapshot': return 'Reading the page structure (accessibility snapshot)';
    case 'click': return `Clicking ${input?.element || 'an element'}`;
    case 'type': return `Typing into ${input?.element || 'a field'}`;
    case 'fill_form': return 'Filling in the form';
    case 'select_option': return `Choosing an option in ${input?.element || 'a dropdown'}`;
    case 'press_key': return `Pressing ${input?.key || 'a key'}`;
    case 'hover': return `Hovering over ${input?.element || 'an element'}`;
    case 'console_messages': return 'Checking the browser console';
    case 'find': return `Searching the page for ${input?.description || 'elements'}`;
    case 'wait_for': return 'Waiting for the page to settle';
    case 'close': return 'Closing the browser';
    case 'ToolSearch': return 'Loading browser tools';
    default: return `Using ${short}`;
  }
}

// Runs the already-authenticated local Claude Code CLI headlessly (no API key
// needed — it uses the same login/subscription as the interactive `claude`
// session). The prompt is sent over stdin, never as a CLI argument, so
// arbitrary user-provided text can never be interpreted as shell/argv syntax.
//
// onProgress(line) is called with short human-readable status strings as the
// agent works, so the UI can show what it's doing instead of a dead spinner.
function runClaude({ userPrompt, browserTools, onProgress, useSession = false, timeoutMs = CLI_TIMEOUT_MS, finalMessage = 'Writing the test cases' }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--system-prompt-file', SYSTEM_PROMPT_FILE,
      '--model', MODEL,
      '--tools', '',
    ];

    // --strict-mcp-config is always passed so a run never inherits whatever MCP
    // servers the user happens to have configured globally. Only the browsing
    // path opts into our own Playwright config.
    args.push('--strict-mcp-config');
    if (browserTools && browserTools.length) {
      args.push('--mcp-config', useSession ? sessionMcpConfig() : MCP_CONFIG);
      args.push('--allowedTools', ...browserTools);
    }

    // cross-spawn (not plain child_process.spawn) is required on Windows: a
    // global npm install (npm install -g @anthropic-ai/claude-code) puts a
    // claude.cmd shim on PATH, and Windows can't execute .cmd files directly
    // via CreateProcess the way it can claude.exe (the native-installer
    // path) — spawn() without a shell fails with ENOENT even though `where
    // claude` and a manual `claude` both work fine. Plain spawn's own
    // shell:true "fix" for that is unsafe here even though every arg is
    // static/internal rather than user text: SYSTEM_PROMPT_FILE and
    // --mcp-config are absolute paths that may contain spaces, and cmd.exe's
    // own argv splitting would mis-split an unquoted one. cross-spawn quotes
    // each arg correctly for cmd.exe internally instead of relying on
    // Node's shell:true string-join.
    const child = spawn('claude', args, {
      windowsHide: true,
      timeout: timeoutMs,
    });

    let stderr = '';
    let buffer = '';
    let finalResult = null;
    let finalError = null;

    const emit = (msg) => { if (onProgress && msg) onProgress(msg); };

    function handleEvent(evt) {
      if (evt.type === 'system' && evt.subtype === 'init') {
        emit('Session started');
        return;
      }
      if (evt.type === 'assistant' && evt.message?.content) {
        for (const block of evt.message.content) {
          if (block.type === 'tool_use') {
            emit(describeToolUse(block.name, block.input));
          } else if (block.type === 'thinking') {
            emit('Thinking…');
          } else if (block.type === 'text' && block.text.trim()) {
            emit(finalMessage);
          }
        }
        return;
      }
      if (evt.type === 'result') {
        if (evt.is_error) finalError = evt.result || 'The Claude CLI reported an error';
        else finalResult = evt.result || '';
      }
    }

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep the trailing partial line
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          handleEvent(JSON.parse(trimmed));
        } catch {
          // Non-JSON noise on stdout — ignore rather than failing the run.
        }
      }
    });

    child.stderr.on('data', (d) => { stderr += d; });

    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(new Error('The "claude" CLI was not found on PATH. Install Claude Code and make sure you are logged in.'));
      } else {
        reject(err);
      }
    });

    child.on('close', (code, signal) => {
      if (signal === 'SIGTERM') {
        return reject(new Error(
          `Timed out after ${Math.round(timeoutMs / 60000)} minutes. If you selected several pages, pick fewer and run again — each page costs a page-load and a snapshot before any writing starts.`
        ));
      }
      if (finalError) return reject(new Error(finalError));
      if (code !== 0) return reject(new Error(stderr.trim().split('\n').slice(-3).join(' ') || `claude CLI exited with code ${code}`));
      if (finalResult === null) return reject(new Error('The Claude CLI finished without returning a result.'));
      resolve(finalResult);
    });

    child.stdin.write(userPrompt);
    child.stdin.end();
  });
}

function parseJsonLoose(text) {
  let t = String(text).trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) t = fenced[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) t = t.slice(start, end + 1);
  try {
    return JSON.parse(t);
  } catch (e) {
    throw new Error('Could not read the generated test cases as JSON. ' + e.message);
  }
}

function detectUrl(input) {
  const trimmed = input.trim();
  const match = trimmed.match(URL_PATTERN);
  if (!match || !isPlausibleDomain(match[0])) return null;
  let url = match[0].replace(/[.,;)]+$/, '');
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return { url, extraContext: trimmed.replace(match[0], ' ').trim() };
}

// Normalizes a data table from the model into a clean array-of-rows, or null.
function normalizeDataTable(raw) {
  if (!Array.isArray(raw) || !raw.length) return null;
  const rows = raw
    .filter(Array.isArray)
    .map((row) => row.map((cell) => String(cell ?? '')));
  if (!rows.length) return null;
  const width = Math.max(...rows.map((r) => r.length));
  return rows.map((r) => [...r, ...Array(width - r.length).fill('')]);
}

// Discovery pass: crawl the site and report its pages so the user can choose
// which to cover. Read-only by definition — it must never act on a page.
async function discoverPages(url, { useSession = false, maxPages = 12, onProgress } = {}) {
  const userPrompt = buildDiscoverUserPrompt({ url, maxPages });
  if (onProgress) onProgress(`Mapping the pages of ${url}`);

  const result = await runClaude({
    userPrompt,
    browserTools: READONLY_BROWSER_TOOLS,
    onProgress,
    useSession,
    finalMessage: 'Listing the pages it found',
    // A crawl visits several pages before answering, so it needs more than the
    // single-page budget too.
    timeoutMs: Math.min(CLI_TIMEOUT_MS + maxPages * 30 * 1000, MAX_TIMEOUT_MS),
  });

  const parsed = parseJsonLoose(result);
  const origin = urls.originOf(url);

  const seen = new Set();
  const pages = (parsed.pages || [])
    .map((p) => {
      const absolute = urls.resolveSameOrigin(p.url, url, origin);
      if (!absolute) return null;

      const key = urls.dedupeKey(absolute);
      if (seen.has(key)) return null;
      seen.add(key);

      return {
        url: absolute,
        title: String(p.title ?? '').slice(0, 200) || absolute,
        purpose: String(p.purpose ?? '').slice(0, 300),
        hasForm: p.hasForm === true,
        requiresLogin: p.requiresLogin === true,
      };
    })
    .filter(Boolean)
    .slice(0, maxPages);

  return { siteName: String(parsed.siteName ?? '').slice(0, 200), pages, rootUrl: url };
}

// One cheap, non-agentic call (no browser tools — titles/URLs only) to add a
// short purpose sentence per page found by the fast crawler. Best-effort: if
// it fails or comes back short, pages just keep their blank purpose rather
// than losing the whole discovery result over a cosmetic field.
async function addPurposes(pages, onProgress) {
  if (!pages.length) return pages;
  try {
    const userPrompt = buildDiscoverPurposesPrompt({ pages });
    const result = await runClaude({
      userPrompt,
      browserTools: [],
      onProgress,
      finalMessage: 'Writing short descriptions for each page',
      timeoutMs: CLI_TIMEOUT_MS,
    });
    const parsed = parseJsonLoose(result);
    const purposes = Array.isArray(parsed.purposes) ? parsed.purposes : [];
    return {
      siteName: String(parsed.siteName ?? '').slice(0, 200),
      pages: pages.map((p, i) => ({ ...p, purpose: String(purposes[i] ?? '').slice(0, 300) || p.purpose })),
    };
  } catch (err) {
    if (onProgress) onProgress(`Couldn't write page descriptions (${err.message}) — continuing without them`);
    return { siteName: '', pages };
  }
}

// Fast path: crawl the site directly with a real headless browser (no LLM
// call for the crawl itself — see crawler.js), then add short purpose text in
// one cheap batched call. Falls back to the slower agentic discoverPages()
// when the deterministic crawl finds nothing to work with.
//
// The crawler always returns at least the start page on success, so "found
// nothing" isn't pages.length === 0 — it's pages.length === 1 while the user
// asked for more: that's the real signal for "no real <a href> tags to
// follow" (a JS-only SPA whose nav isn't rendered as anchors, a page behind a
// wall the crawler couldn't get past, etc). A true zero only happens if the
// start page itself failed to load, which discoverPages() won't fix either,
// but it's cheap to let it try.
async function discoverPagesFast(url, { useSession = false, maxPages = 12, onProgress } = {}) {
  const crawled = await crawlSite({ url, maxPages, useSession, onProgress });

  if (crawled.pages.length <= 1 && maxPages > 1) {
    if (onProgress) onProgress('Found nothing to follow by crawling directly — falling back to AI-driven exploration');
    return discoverPages(url, { useSession, maxPages, onProgress });
  }

  const { siteName, pages } = await addPurposes(crawled.pages, onProgress);
  return { siteName, pages, rootUrl: url };
}

// Generation across several chosen pages.
async function generateFromPages({ pages, extraContext = '', interactive = false, useSession = false, types = [], testUsername, testPassword, onProgress }) {
  const userPrompt = buildMultiPagePrompt({ pages, extraContext, interactive, types, testUsername, testPassword });
  if (onProgress) onProgress(`Exploring ${pages.length} selected page${pages.length === 1 ? '' : 's'}`);

  const browserTools = interactive ? INTERACTIVE_BROWSER_TOOLS : READONLY_BROWSER_TOOLS;

  // Each page costs a navigate + snapshot before any writing starts, so the flat
  // single-page budget runs out partway through a multi-page crawl and the whole
  // run is lost. Give it the base budget plus a slice per page.
  const timeoutMs = Math.min(
    CLI_TIMEOUT_MS + pages.length * PER_PAGE_TIMEOUT_MS,
    MAX_TIMEOUT_MS
  );

  const result = await runClaude({ userPrompt, browserTools, onProgress, useSession, timeoutMs });
  return {
    plan: parseJsonLoose(result),
    sourceUrl: pages[0]?.url || null,
    interactive,
    usedSession: Boolean(useSession),
  };
}

async function generateTestPlan(inputText, { interactive = false, useSession = false, types = [], extraContext = '', testUsername, testPassword, onProgress } = {}) {
  const detected = detectUrl(inputText);
  const isUrl = Boolean(detected);

  // For a URL, `detectUrl` already peels off any prose typed alongside the
  // link into its own context string — combine that with whatever the user
  // separately typed in the instructions field, rather than picking one.
  const combinedContext = [detected?.extraContext, extraContext].filter(Boolean).join('\n\n');

  const userPrompt = buildGenerateUserPrompt(
    isUrl
      ? { isUrl: true, url: detected.url, extraContext: combinedContext, interactive, types, testUsername, testPassword }
      : { isUrl: false, text: inputText, types, extraContext }
  );

  if (onProgress) {
    onProgress(isUrl
      ? `Launching a browser to explore ${detected.url}${interactive ? ' (interactive)' : ' (read-only)'}`
      : 'Reading your description');
  }

  const browserTools = isUrl
    ? (interactive ? INTERACTIVE_BROWSER_TOOLS : READONLY_BROWSER_TOOLS)
    : [];

  const result = await runClaude({ userPrompt, browserTools, onProgress, useSession: isUrl && useSession });
  return {
    plan: parseJsonLoose(result),
    sourceUrl: isUrl ? detected.url : null,
    interactive: isUrl ? interactive : false,
    usedSession: Boolean(isUrl && useSession),
  };
}

// Generation from a human-recorded flow (see server/lib/recorder.js) — a
// person drove a real browser themselves, so unlike every other generation
// path here, this one passes browserTools: [] deliberately: the model gets no
// --mcp-config/--allowedTools at all, and never touches a browser. It also
// never receives testUsername/testPassword — whatever was typed during
// recording already happened directly in the real browser, and a sensitive
// field's value was never captured in the first place (recorder.js), so there
// is nothing for the model to need here.
async function generateFromRecordings({ recordings, extraContext = '', types = [], onProgress }) {
  const userPrompt = buildRecordedFlowsPrompt({ recordings, extraContext, types });
  if (onProgress) onProgress(`Writing test cases from ${recordings.length} recorded test${recordings.length === 1 ? '' : 's'}`);

  const result = await runClaude({ userPrompt, browserTools: [], onProgress, timeoutMs: CLI_TIMEOUT_MS });
  return {
    plan: parseJsonLoose(result),
    sourceUrl: recordings[0]?.startUrl || null,
    interactive: false,
    usedSession: false,
  };
}

// Same idea, but for adding more recorded flows to a feature that already has
// test cases (recording again after generating, or recording one flow to fill
// in a specific manually-added draft scenario) — see the "record-scenario"/
// "record more flows" flows in public/app.js and the /scenarios/from-recordings
// route in runs.js. No browser tools, same reasoning as generateFromRecordings.
async function generateScenariosFromRecordings({ recordings, featureTitle, featureDescription, existingTitles, types, targetTitle, onProgress }) {
  const userPrompt = buildRecordedFlowsAppendPrompt({ recordings, featureTitle, featureDescription, existingTitles, types, targetTitle });
  if (onProgress) onProgress(`Writing test cases from ${recordings.length} recorded test${recordings.length === 1 ? '' : 's'}`);

  const result = await runClaude({ userPrompt, browserTools: [], onProgress, timeoutMs: CLI_TIMEOUT_MS });
  return parseJsonLoose(result);
}

// Stage 2 of generation: a fresh critique pass that de-duplicates, fills gaps and
// simplifies wording before the user ever sees the draft.
async function refineTestPlan({ featureTitle, featureDescription, requirements, scenariosJson, types, detectedIssues, onProgress }) {
  const userPrompt = buildRefineUserPrompt({
    featureTitle,
    featureDescription,
    requirements,
    scenariosJson,
    types,
    detectedIssues,
  });
  const result = await runClaude({ userPrompt, browserTools: [], onProgress });
  return parseJsonLoose(result);
}

// Writes only the test cases needed for requirements nothing currently covers.
async function fillCoverageGaps({ featureTitle, gaps, existingTitles, types, onProgress }) {
  const userPrompt = buildFillGapsUserPrompt({ featureTitle, gaps, existingTitles, types });
  const result = await runClaude({ userPrompt, browserTools: [], onProgress });
  return parseJsonLoose(result);
}

async function reviseScenario({ scenario, requirements, review, formattedSteps, onProgress }) {
  const userPrompt = buildUpdateUserPrompt({ scenario, requirements, review, formattedSteps });
  const result = await runClaude({ userPrompt, browserTools: [], onProgress });
  return parseJsonLoose(result);
}

// A manually-added scenario has only a title — write its steps. Grounded in
// the real page (read-only browsing, same as a plain-text/URL generate) when
// the run has a source URL; a plain text-only pass otherwise (a run from a
// description, or from recorded flows, has nothing to browse to).
async function generateScenarioFromTitle({ title, featureTitle, featureDescription, requirements, url, types, onProgress }) {
  const userPrompt = buildScenarioFromTitlePrompt({ title, featureTitle, featureDescription, requirements, url, types });
  if (onProgress) onProgress(url ? `Exploring ${url}` : 'Writing the steps');
  const result = await runClaude({ userPrompt, browserTools: url ? READONLY_BROWSER_TOOLS : [], onProgress, useSession: false });
  return parseJsonLoose(result);
}

async function reviseAllScenarios({ featureTitle, featureDescription, requirements, formattedScenarios, review, onProgress }) {
  const userPrompt = buildUpdateAllUserPrompt({
    featureTitle,
    featureDescription,
    requirements,
    formattedScenarios,
    review,
  });
  const result = await runClaude({ userPrompt, browserTools: [], onProgress });
  return parseJsonLoose(result);
}

module.exports = {
  hasSavedSession,
  detectUrl,
  discoverPages,
  discoverPagesFast,
  generateFromPages,
  generateFromRecordings,
  generateScenariosFromRecordings,
  generateTestPlan,
  refineTestPlan,
  fillCoverageGaps,
  reviseScenario,
  generateScenarioFromTitle,
  reviseAllScenarios,
  normalizeDataTable,
};
