// "Record a flow": opens a real headed browser the user drives by hand,
// captures their clicks/typing/navigation as structured actions, and lets
// them checkpoint one or more "tests" before handing the transcript off to
// Claude — no Playwright MCP, no agentic exploration, because the recording
// already IS the exploration.
//
// One concurrent session, matching the rest of this app (session.js holds one
// global signed-in session; store.js runs have no ownership concept) —
// simplicity over generality for a local, single-operator tool.

const crypto = require('crypto');
const { chromium } = require('playwright-core');
const sessionStore = require('./session');

const IDLE_TIMEOUT_MS = 20 * 60 * 1000; // reset only on real captured actions, never on a status poll
const MAX_ACTIONS_PER_FLOW = 300;
const MAX_FLOWS_PER_SESSION = 20;
const NAV_DEDUPE_MS = 300;

// Card/SSN/token-shaped strings scrubbed out of typed values AND clicked-element
// accessible names — a clicked row's label being a real customer's name is a
// live leak path this feature introduces that the existing agentic paths don't
// have in the same raw form (they only ever produce curated model output).
const CARD_NUMBER_RE = /\b(?:\d[ -]?){13,19}\b/;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/;
const LONG_TOKEN_RE = /\b[a-zA-Z0-9_-]{24,}\b/;

const sessions = new Map();
const wiredPages = new WeakSet();

function looksSecretShaped(s) {
  return CARD_NUMBER_RE.test(s) || SSN_RE.test(s) || LONG_TOKEN_RE.test(s);
}

// Node-side backstop: the injected page script already suppresses password/
// sensitive-field values at the source, but a person can type a card number or
// SSN into a field with no special type/autocomplete hint at all.
function scrubAction(raw) {
  const action = { type: String(raw?.type ?? '').slice(0, 40) };
  if (typeof raw.role === 'string') action.role = raw.role.slice(0, 60);
  if (typeof raw.name === 'string') action.name = looksSecretShaped(raw.name) ? '(redacted)' : raw.name.slice(0, 120);
  if (raw.sensitive) {
    action.sensitive = true; // value deliberately omitted — never captured client-side either
  } else if (typeof raw.value === 'string') {
    // Wide enough to hold a short structural snapshot (assert-snapshot) as
    // well as an ordinary field value, without going so wide that a whole
    // page of text could plausibly ride through in one "value".
    action.value = looksSecretShaped(raw.value) ? '(redacted)' : raw.value.slice(0, 500);
  } else if (typeof raw.checked === 'boolean') {
    action.checked = raw.checked;
  }
  if (Array.isArray(raw.fileNames)) action.fileNames = raw.fileNames.slice(0, 10).map((n) => String(n).slice(0, 200));
  if (typeof raw.url === 'string') action.url = raw.url.slice(0, 2000);
  return action;
}

// Structural validation for recordings arriving over HTTP, from a client that
// only ever has them via a status poll or a session it just stopped — used
// both by the initial "generate a new run from recordings" path and by
// "append more scenarios from recordings" to an existing run. Content-level
// scrubbing (secrets, PII-shaped strings) already happened at capture time in
// pushAction()/scrubAction(); this only re-validates shape/size, since the
// request body is otherwise untrusted input like any other.
function sanitizeRecordings(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map((r) => {
      const actions = (Array.isArray(r?.actions) ? r.actions : []).slice(0, MAX_ACTIONS_PER_FLOW);
      if (!actions.length) return null;
      return {
        title: String(r?.title ?? '').slice(0, 200),
        startUrl: String(r?.startUrl ?? '').slice(0, 2000),
        actions: actions.map((a) => ({
          type: String(a?.type ?? '').slice(0, 40),
          ...(a?.role != null ? { role: String(a.role).slice(0, 60) } : {}),
          ...(a?.name != null ? { name: String(a.name).slice(0, 120) } : {}),
          ...(a?.value != null ? { value: String(a.value).slice(0, 500) } : {}),
          ...(a?.url != null ? { url: String(a.url).slice(0, 2000) } : {}),
          ...(a?.sensitive === true ? { sensitive: true } : {}),
          ...(typeof a?.checked === 'boolean' ? { checked: a.checked } : {}),
          ...(Array.isArray(a?.fileNames) ? { fileNames: a.fileNames.slice(0, 10).map((n) => String(n).slice(0, 200)) } : {}),
        })),
      };
    })
    .filter(Boolean)
    .slice(0, MAX_FLOWS_PER_SESSION);
}

function summarizeFlow(flow) {
  return { id: flow.id, title: flow.title, actionCount: flow.actions.length };
}

function currentState(session) {
  return {
    recording: !session.closed,
    currentFlowActionCount: session.currentFlow ? session.currentFlow.actions.length : 0,
    savedFlows: session.flows.map(summarizeFlow),
    closed: session.closed,
  };
}

function newFlow(session) {
  return { id: crypto.randomUUID(), title: `Test ${session.flows.length + 1}`, startUrl: session.currentUrl, actions: [] };
}

function resetIdleTimer(session) {
  clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => {
    finalizeAndClose(session.id).catch(() => {});
  }, IDLE_TIMEOUT_MS);
}

function pushAction(session, action) {
  if (!session.currentFlow) session.currentFlow = newFlow(session);
  if (session.currentFlow.actions.length >= MAX_ACTIONS_PER_FLOW) return;
  session.currentFlow.actions.push({ seq: session.seq++, ...action });
  resetIdleTimer(session);
}

// Saves whatever is buffered as one finished test, if it has anything in it —
// an empty checkpoint (Enter pressed twice with nothing in between) is a no-op,
// not an empty scenario for Claude to puzzle over.
function saveCheckpoint(session) {
  if (session.currentFlow && session.currentFlow.actions.length && session.flows.length < MAX_FLOWS_PER_SESSION) {
    session.flows.push(session.currentFlow);
  }
  session.currentFlow = null;
  resetIdleTimer(session);
}

// How long a closed session's already-recorded flows stay retrievable after
// the browser window itself is gone. The overlay's "Finish", a manual window
// close, a disconnect, and the idle timer all close the browser well before
// the user's app tab has any chance to react — an immediate delete here raced
// the app's own /stop call and lost real, already-saved recordings (a
// reported bug). start() no longer treats a merely-closed session as
// "occupying" the one-session slot, so this grace period doesn't block
// starting a fresh recording either.
const CLOSED_SESSION_GRACE_MS = 5 * 60 * 1000;

async function finalizeAndClose(sessionId) {
  const session = sessions.get(sessionId);
  if (!session || session.closed) return;
  saveCheckpoint(session);
  session.closed = true;
  clearTimeout(session.idleTimer);
  await session.context.close().catch(() => {});
  if (session.browser) await session.browser.close().catch(() => {});
  session.reapTimer = setTimeout(() => sessions.delete(sessionId), CLOSED_SESSION_GRACE_MS);
}

async function handleAction(session, raw) {
  if (session.closed || !raw || typeof raw !== 'object') return currentState(session);

  if (raw.type === '__save_checkpoint') {
    saveCheckpoint(session);
  } else if (raw.type === '__finish') {
    // Let this exposeFunction call return to the page before we close the very
    // context it's running in.
    setImmediate(() => finalizeAndClose(session.id).catch(() => {}));
  } else if (raw.type === 'navigate') {
    session.currentUrl = String(raw.url ?? session.currentUrl).slice(0, 2000);
    pushAction(session, scrubAction(raw));
  } else {
    pushAction(session, scrubAction(raw));
  }

  return currentState(session);
}

function wirePage(session, page) {
  if (wiredPages.has(page)) return;
  wiredPages.add(page);

  page.on('framenavigated', (frame) => {
    if (session.closed || frame !== page.mainFrame()) return;
    const url = frame.url();
    const now = Date.now();
    if (session.lastNav && session.lastNav.url === url && now - session.lastNav.at < NAV_DEDUPE_MS) return;
    session.lastNav = { url, at: now };
    handleAction(session, { type: 'navigate', url }).catch(() => {});
  });

  page.on('close', () => {
    if (!session.closed && session.context.pages().length === 0) {
      finalizeAndClose(session.id).catch(() => {});
    }
  });
}

// Runs inside the recorded page itself — must be fully self-contained, since
// Playwright serializes this via toString() and re-executes it standalone in
// every frame of every page the context opens (confirmed: addInitScript and
// exposeFunction both propagate into same-origin iframes).
function injectedRecorder() {
  if (window.__bddRecorderInstalled) return;
  window.__bddRecorderInstalled = true;

  var SENSITIVE_NAME_RE = /pass|secret|token|ssn|social|security|\bcard\b|cvv|cvc|\bpin\b/i;
  var SENSITIVE_AUTOCOMPLETE = ['current-password', 'new-password', 'cc-number', 'cc-csc', 'cc-exp', 'one-time-code'];

  function isFormField(el) {
    if (!el || !el.tagName) return false;
    var tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
  }

  function isSensitiveField(el) {
    var type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'password') return true;
    var ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (SENSITIVE_AUTOCOMPLETE.indexOf(ac) !== -1) return true;
    var probe = [el.name, el.id, el.getAttribute('aria-label'), el.placeholder].filter(Boolean).join(' ');
    return SENSITIVE_NAME_RE.test(probe);
  }

  function describeEl(el) {
    if (!el) return { role: '', name: '' };
    var role = el.getAttribute('role') || el.tagName.toLowerCase();
    var labelEl = el.labels && el.labels[0];
    var name = el.getAttribute('aria-label')
      || (labelEl && labelEl.textContent)
      || el.getAttribute('placeholder')
      || (el.textContent || '').trim().slice(0, 80)
      || el.getAttribute('name')
      || '';
    return { role: role, name: String(name).trim().slice(0, 120) };
  }

  var pendingRefresh = null;
  function report(action) {
    try {
      var result = window.__bddRecorderAction && window.__bddRecorderAction(action);
      if (result && result.then) result.then(function (state) { if (state && pendingRefresh) pendingRefresh(state); }).catch(function () {});
    } catch (e) { /* the page itself may be navigating away — never let this throw */ }
  }

  function getFieldValue(el) {
    if (!el) return '';
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return String(el.value || '');
    return (el.textContent || '').trim();
  }

  function getVisibleText(el) {
    if (!el) return '';
    return (el.innerText != null ? el.innerText : (el.textContent || '')).trim();
  }

  // A lightweight, poor-man's structural snapshot: role + accessible name per
  // node, indented by depth. Not Playwright's real ARIA snapshot (that's not
  // something a page-injected script can produce) — just enough structure for
  // Claude to describe what was actually on screen at that point.
  function buildSnapshot(el, depth) {
    if (!el || depth > 3) return '';
    var d = describeEl(el);
    var indent = new Array(depth + 1).join('  ');
    var line = indent + '- ' + (d.role || 'node') + (d.name ? (': "' + d.name + '"') : '');
    var lines = [line];
    var children = el.children || [];
    var count = 0;
    for (var i = 0; i < children.length && count < 8; i++) {
      var childLines = buildSnapshot(children[i], depth + 1);
      if (childLines) { lines.push(childLines); count++; }
    }
    return lines.join('\n');
  }

  // Assertion picking: clicking one of the overlay's four "Assert" buttons
  // arms this, then the NEXT click anywhere on the page is intercepted
  // (preventDefault+stopPropagation, so picking never actually activates a
  // link or submits a form) and turned into an assertion action instead of a
  // normal click. Scoped to the top frame only — see the note below on why
  // the overlay itself only ever builds there.
  var pickMode = null; // null | 'visible' | 'text' | 'value' | 'snapshot'
  var highlighted = null;
  var pickHintEl = null;
  var onPickModeChanged = null; // set by buildOverlay() so button highlighting stays in sync

  function clearHighlight() {
    if (highlighted) {
      highlighted.style.outline = highlighted.__bddPrevOutline || '';
      highlighted = null;
    }
  }

  function setPickMode(mode) {
    pickMode = mode;
    document.body.style.cursor = mode ? 'crosshair' : '';
    if (!mode) clearHighlight();
    if (pickHintEl) pickHintEl.style.display = mode ? 'block' : 'none';
    if (onPickModeChanged) onPickModeChanged();
  }

  document.addEventListener('change', function (e) {
    var el = e.target;
    if (!el || !isFormField(el)) return;
    var desc = describeEl(el);
    if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
      report({ type: 'check', role: desc.role, name: desc.name, checked: el.checked });
      return;
    }
    if (el.tagName === 'INPUT' && el.type === 'file') {
      var names = [];
      for (var i = 0; i < (el.files ? el.files.length : 0); i++) names.push(el.files[i].name);
      report({ type: 'upload', role: 'file', name: desc.name, fileNames: names });
      return;
    }
    if (isSensitiveField(el)) {
      report({ type: 'fill', role: desc.role, name: desc.name, sensitive: true });
      return;
    }
    report({ type: el.tagName === 'SELECT' ? 'select' : 'fill', role: desc.role, name: desc.name, value: String(el.value || '') });
  }, true);

  document.addEventListener('click', function (e) {
    // The overlay's own controls (Save/Finish/Assert buttons, the drag
    // handle) must keep working normally even while a pick mode is armed —
    // otherwise clicking "Finish & close" mid-pick gets swallowed as an
    // assertion target instead of actually finishing the recording.
    if (e.target.closest && e.target.closest('#__bddRecorderOverlay')) return;

    if (pickMode) {
      e.preventDefault();
      e.stopPropagation();
      var target = e.target;
      var mode = pickMode;
      var desc = describeEl(target);
      setPickMode(null);

      if (mode === 'visible') {
        report({ type: 'assert-visible', role: desc.role, name: desc.name });
      } else if (mode === 'text') {
        report({ type: 'assert-text', role: desc.role, name: desc.name, value: getVisibleText(target).slice(0, 400) });
      } else if (mode === 'value') {
        if (isSensitiveField(target)) {
          report({ type: 'assert-value', role: desc.role, name: desc.name, sensitive: true });
        } else {
          report({ type: 'assert-value', role: desc.role, name: desc.name, value: getFieldValue(target).slice(0, 400) });
        }
      } else if (mode === 'snapshot') {
        report({ type: 'assert-snapshot', role: desc.role, name: desc.name, value: buildSnapshot(target, 0).slice(0, 450) });
      }
      return;
    }

    var el = e.target && e.target.closest
      ? e.target.closest('button, a, [role="button"], [role="link"], [role="tab"], [role="menuitem"], input[type="submit"], input[type="button"], li, td')
      : null;
    if (!el) return;
    var desc = describeEl(el);
    report({ type: 'click', role: desc.role, name: desc.name });
  }, true);

  document.addEventListener('submit', function (e) {
    var desc = describeEl(e.target);
    report({ type: 'submit', role: 'form', name: desc.name });
  }, true);

  document.addEventListener('drop', function (e) {
    var desc = describeEl(e.target);
    report({ type: 'drop', role: desc.role, name: desc.name });
  }, true);

  // Overlay UI is top-frame only — the listeners above stay active in every
  // iframe so a click inside a same-site embedded widget is still captured,
  // but without this guard a nested toolbar would render inside every iframe
  // on the page, including third-party ones.
  if (window.top !== window.self) return;

  function buildOverlay() {
    var bar = document.createElement('div');
    bar.id = '__bddRecorderOverlay';
    bar.style.position = 'fixed';
    bar.style.right = '16px';
    bar.style.bottom = '16px';
    bar.style.zIndex = '2147483647';
    bar.style.display = 'flex';
    bar.style.flexDirection = 'column';
    bar.style.borderRadius = '16px';
    bar.style.background = 'rgba(17, 19, 28, 0.88)';
    bar.style.backdropFilter = 'blur(16px)';
    bar.style.webkitBackdropFilter = 'blur(16px)';
    bar.style.color = '#fff';
    bar.style.fontFamily = '-apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
    bar.style.fontSize = '12px';
    bar.style.boxShadow = '0 16px 40px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.07)';
    bar.style.maxWidth = '270px';
    bar.style.overflow = 'hidden';

    // A one-time keyframes rule for the live "recording" dot's pulse.
    var pulseStyle = document.createElement('style');
    pulseStyle.textContent = '@keyframes __bddPulse{0%{box-shadow:0 0 0 0 rgba(240,69,59,.55)}70%{box-shadow:0 0 0 6px rgba(240,69,59,0)}100%{box-shadow:0 0 0 0 rgba(240,69,59,0)}}';
    document.head.appendChild(pulseStyle);

    // The bar's position is a starting suggestion, not a mandate — a fixed
    // corner can sit right on top of something on the actual page the user
    // needs to reach (a chat widget, a "buy now" button, a cookie banner).
    // Dragging this header repositions the whole overlay anywhere on screen.
    var header = document.createElement('div');
    header.style.display = 'flex';
    header.style.alignItems = 'center';
    header.style.gap = '8px';
    header.style.padding = '11px 14px';
    header.style.cursor = 'move';
    header.style.userSelect = 'none';
    header.style.borderBottom = '1px solid rgba(255,255,255,0.08)';

    var dot = document.createElement('span');
    dot.style.width = '8px';
    dot.style.height = '8px';
    dot.style.borderRadius = '50%';
    dot.style.background = '#f0453b';
    dot.style.flexShrink = '0';
    dot.style.animation = '__bddPulse 1.6s ease-out infinite';

    var title = document.createElement('span');
    title.textContent = 'Recording';
    title.style.fontWeight = '700';
    title.style.fontSize = '12px';
    title.style.letterSpacing = '0.01em';

    var dragCue = document.createElement('span');
    dragCue.textContent = '⠿';
    dragCue.style.marginLeft = 'auto';
    dragCue.style.color = 'rgba(255,255,255,0.35)';
    dragCue.style.fontSize = '13px';

    header.appendChild(dot);
    header.appendChild(title);
    header.appendChild(dragCue);
    bar.appendChild(header);

    var body = document.createElement('div');
    body.style.display = 'flex';
    body.style.flexDirection = 'column';
    body.style.gap = '10px';
    body.style.padding = '12px 14px';
    bar.appendChild(body);

    var counter = document.createElement('div');
    counter.style.fontSize = '12.5px';
    counter.style.color = 'rgba(255,255,255,0.85)';
    counter.textContent = 'Test 1 — 0 actions';

    var row = document.createElement('div');
    row.style.display = 'flex';
    row.style.gap = '7px';

    function makeButton(label) {
      var b = document.createElement('button');
      b.textContent = label;
      b.type = 'button';
      b.style.cursor = 'pointer';
      b.style.border = 'none';
      b.style.borderRadius = '8px';
      b.style.padding = '7px 12px';
      b.style.fontSize = '12px';
      b.style.fontWeight = '600';
      b.style.transition = 'background-color .12s ease';
      return b;
    }

    var saveBtn = makeButton('Save test');
    saveBtn.style.background = '#2f5fed';
    saveBtn.style.color = '#fff';
    saveBtn.style.flex = '1';
    saveBtn.addEventListener('mouseenter', function () { saveBtn.style.background = '#2449c0'; });
    saveBtn.addEventListener('mouseleave', function () { saveBtn.style.background = '#2f5fed'; });

    var finishBtn = makeButton('Finish');
    finishBtn.style.background = 'rgba(255,255,255,0.10)';
    finishBtn.style.color = 'rgba(255,255,255,0.9)';
    finishBtn.addEventListener('mouseenter', function () { if (!finishBtn.disabled) finishBtn.style.background = 'rgba(255,255,255,0.18)'; });
    finishBtn.addEventListener('mouseleave', function () { if (!finishBtn.disabled) finishBtn.style.background = 'rgba(255,255,255,0.10)'; });

    row.appendChild(saveBtn);
    row.appendChild(finishBtn);

    var divider = document.createElement('div');
    divider.style.borderTop = '1px solid rgba(255,255,255,0.08)';

    var assertLabel = document.createElement('div');
    assertLabel.textContent = 'ASSERT';
    assertLabel.style.color = 'rgba(255,255,255,0.4)';
    assertLabel.style.fontSize = '9.5px';
    assertLabel.style.fontWeight = '700';
    assertLabel.style.letterSpacing = '0.08em';

    var assertRow = document.createElement('div');
    assertRow.style.display = 'flex';
    assertRow.style.gap = '5px';
    assertRow.style.flexWrap = 'wrap';

    var assertButtons = [];
    function makeAssertButton(label, mode) {
      var b = makeButton(label);
      b.style.padding = '5px 10px';
      b.style.fontSize = '11px';
      b.addEventListener('click', function () {
        setPickMode(pickMode === mode ? null : mode);
      });
      assertButtons.push({ btn: b, mode: mode });
      assertRow.appendChild(b);
      return b;
    }
    makeAssertButton('Visible', 'visible');
    makeAssertButton('Text', 'text');
    makeAssertButton('Value', 'value');
    makeAssertButton('Snapshot', 'snapshot');

    function refreshAssertButtons() {
      assertButtons.forEach(function (item) {
        item.btn.style.background = pickMode === item.mode ? '#2f5fed' : 'rgba(255,255,255,0.10)';
        item.btn.style.color = '#fff';
      });
    }
    onPickModeChanged = refreshAssertButtons;
    refreshAssertButtons();

    var pickHint = document.createElement('div');
    pickHint.style.color = '#ffb84d';
    pickHint.style.fontSize = '11px';
    pickHint.style.display = 'none';
    pickHint.textContent = 'Click an element on the page — Esc to cancel';
    pickHintEl = pickHint;

    body.appendChild(counter);
    body.appendChild(row);
    body.appendChild(divider);
    body.appendChild(assertLabel);
    body.appendChild(assertRow);
    body.appendChild(pickHint);

    function refresh(state) {
      counter.textContent = 'Test ' + (state.savedCount + 1) + ' — ' + state.currentFlowActionCount + ' action' + (state.currentFlowActionCount === 1 ? '' : 's');
    }
    pendingRefresh = refresh;

    saveBtn.addEventListener('click', function () { report({ type: '__save_checkpoint' }); });
    finishBtn.addEventListener('click', function () {
      finishBtn.disabled = true;
      finishBtn.style.background = 'rgba(255,255,255,0.10)';
      finishBtn.textContent = 'Closing…';
      report({ type: '__finish' });
    });

    // Hovering while a pick mode is armed highlights whatever's under the
    // cursor, so the user can see what they're about to select before
    // clicking to confirm it.
    document.addEventListener('mouseover', function (e) {
      if (!pickMode) return;
      clearHighlight();
      var el = e.target;
      if (el && el !== document.body && el !== document.documentElement) {
        highlighted = el;
        highlighted.__bddPrevOutline = highlighted.style.outline;
        highlighted.style.outline = '2px solid #2f5fed';
      }
    }, true);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && pickMode) {
        setPickMode(null);
        return;
      }
      if (e.key !== 'Enter') return;
      var active = document.activeElement;
      if (isFormField(active) || (active && active.isContentEditable)) return;
      var role = active && active.getAttribute && active.getAttribute('role');
      var interactiveRoles = ['combobox', 'listbox', 'option', 'menuitem', 'textbox', 'slider'];
      if (active && (active.tagName === 'BUTTON' || active.tagName === 'A' || interactiveRoles.indexOf(role) !== -1)) return;
      report({ type: '__save_checkpoint' });
    }, true);

    document.documentElement.appendChild(bar);

    // Switch from right/bottom to an equivalent left/top once real
    // dimensions exist, so dragging can move the bar freely in either
    // direction instead of only growing/shrinking a fixed corner offset.
    var startRect = bar.getBoundingClientRect();
    bar.style.left = startRect.left + 'px';
    bar.style.top = startRect.top + 'px';
    bar.style.right = 'auto';
    bar.style.bottom = 'auto';

    var dragging = false, dragStartX = 0, dragStartY = 0, barStartLeft = 0, barStartTop = 0;
    header.addEventListener('mousedown', function (e) {
      dragging = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      var r = bar.getBoundingClientRect();
      barStartLeft = r.left;
      barStartTop = r.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      var maxLeft = window.innerWidth - bar.offsetWidth - 4;
      var maxTop = window.innerHeight - bar.offsetHeight - 4;
      var newLeft = Math.max(4, Math.min(maxLeft, barStartLeft + (e.clientX - dragStartX)));
      var newTop = Math.max(4, Math.min(maxTop, barStartTop + (e.clientY - dragStartY)));
      bar.style.left = newLeft + 'px';
      bar.style.top = newTop + 'px';
    }, true);
    document.addEventListener('mouseup', function () { dragging = false; }, true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildOverlay);
  } else {
    buildOverlay();
  }
}

async function openContext(useSession) {
  const kind = useSession ? sessionStore.sessionKind() : 'none';

  // --start-maximized: the window opens filling the screen (still with normal
  // browser chrome — address bar, tabs — not kiosk mode), since a recording
  // session works best with maximum room to see the real page. The user can
  // still resize/un-maximize it by hand afterwards.
  if (kind === 'profile') {
    const context = await chromium.launchPersistentContext(sessionStore.PROFILE_DIR, {
      headless: false,
      viewport: null,
      args: ['--start-maximized'],
    });
    return { context, browser: null };
  }

  const browser = await chromium.launch({ headless: false, args: ['--start-maximized'] });
  const context = kind === 'storageState'
    ? await browser.newContext({ viewport: null, storageState: sessionStore.storageStatePath() })
    : await browser.newContext({ viewport: null });
  return { context, browser };
}

let starting = false; // closes a race: two /record/start calls arriving close
// together could both see sessions.size === 0 and both launch a browser,
// since the slow `await openContext()` below runs before either registers
// its session. This flag reserves the one-session slot synchronously.

async function start({ url, useSession = false }) {
  // A closed session still sitting in `sessions` (within its grace period,
  // waiting for a late /stop) has no open browser and isn't "in the way" —
  // only a still-open one should block starting a fresh recording.
  const occupied = [...sessions.values()].some((s) => !s.closed);
  if (occupied || starting) {
    const err = new Error('A recording session is already open. Finish it, or close the browser window, before starting another.');
    err.status = 409;
    throw err;
  }
  starting = true;

  let context, browser;
  try {
    ({ context, browser } = await openContext(useSession));
  } finally {
    starting = false;
  }
  const sessionId = crypto.randomUUID();
  const session = {
    id: sessionId,
    context,
    browser,
    currentUrl: url,
    flows: [],
    currentFlow: null,
    seq: 0,
    closed: false,
    idleTimer: null,
    lastNav: null,
  };
  sessions.set(sessionId, session);

  try {
    await context.exposeFunction('__bddRecorderAction', (raw) => handleAction(session, raw));
    await context.addInitScript(injectedRecorder);

    context.on('page', (page) => wirePage(session, page));

    let page = context.pages()[0];
    if (!page) page = await context.newPage();
    wirePage(session, page);

    if (browser) browser.on('disconnected', () => finalizeAndClose(sessionId).catch(() => {}));
    context.on('close', () => finalizeAndClose(sessionId).catch(() => {}));

    // A slow or failed first navigation shouldn't abort the session — the
    // window is already open and the user can navigate manually inside it.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  } catch (err) {
    sessions.delete(sessionId);
    await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    throw err;
  }

  resetIdleTimer(session);
  return { sessionId, startUrl: url };
}

function status(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  return currentState(session);
}

async function stop(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  await finalizeAndClose(sessionId);
  const flows = session.flows;
  clearTimeout(session.reapTimer);
  sessions.delete(sessionId);
  return { flows };
}

function discardFlow(sessionId, flowId) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  session.flows = session.flows.filter((f) => f.id !== flowId);
  return currentState(session);
}

// Read-only — lets the UI show what was actually captured in one saved flow
// (on request, not on every status poll) without touching session state.
function getFlow(sessionId, flowId) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  return session.flows.find((f) => f.id === flowId) || null;
}

// Same idea, but for the flow still being recorded (not yet checkpointed with
// "Save test") — so a user who forgets what they've clicked so far can check,
// without that requiring every cheap status poll to carry full action detail.
function getCurrentFlow(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  return session.currentFlow || { id: null, title: `Test ${session.flows.length + 1}`, startUrl: session.currentUrl, actions: [] };
}

// Safety net for a clean shutdown/restart — does not cover a hard crash, which
// is an acceptable residual risk for a local, single-operator tool (worst case
// the user closes the leftover browser window by hand).
function closeAllSessions() {
  return Promise.all([...sessions.keys()].map((id) => finalizeAndClose(id).catch(() => {})));
}
process.on('exit', () => { closeAllSessions(); });
process.on('SIGINT', () => { closeAllSessions().finally(() => process.exit(0)); });
process.on('SIGTERM', () => { closeAllSessions().finally(() => process.exit(0)); });

module.exports = { start, status, stop, discardFlow, getFlow, getCurrentFlow, scrubAction, sanitizeRecordings, injectedRecorder };
