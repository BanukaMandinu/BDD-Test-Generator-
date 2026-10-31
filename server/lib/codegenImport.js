// Reads a script made by Playwright's code generator (the VS Code extension's "Record
// new", or `npx playwright codegen`) and turns it into the same recorded flows the
// app's own recorder produces, so the existing "write test cases from recordings"
// path can use it.
//
// Deliberately a reader, not an interpreter: the script is only ever scanned as text.
// Nothing in it is run, and a line that is not understood is skipped and counted.
// Codegen scripts routinely contain real passwords, so every typed value goes through
// the recorder's scrubber, and anything aimed at a password-like field is dropped.

const { scrubAction } = require('./recorder');

const MAX_BYTES = 500 * 1024;
const MAX_FLOWS = 20;
const MAX_ACTIONS = 300;

const SECRET_NAME_RE = /pass(word|code|phrase)?|secret|token|api[\s_-]?key|\bpin\b|otp|cvv|cvc|card|ssn|security code/i;

// One string literal: 'x', "x" or `x`, with backslash escapes. The closing quote
// must match the opening one, so the pattern needs the number of its quote group.
const str = (quoteGroup) => '([\'"`])((?:\\\\.|(?!\\' + quoteGroup + ').)*)\\' + quoteGroup;
const STR = str(1);
const unescape = (s) => s.replace(/\\(['"`\\])/g, '$1').replace(/\\n/g, '\n');

// Groups: 1/2 = which getBy…/get_by_… call; 3,4 = its first string argument;
// 5,6 = the JS `{ name: '…' }` option; 7,8 = the Python `name="…"` argument.
const LOCATOR_RE = new RegExp(
  '(?:getBy(Role|Label|Placeholder|Text|TestId|Title|AltText)|get_by_(role|label|placeholder|text|test_id|title|alt_text)|locator)\\(\\s*' + str(3) +
  '(?:\\s*,\\s*(?:\\{[^}]*?\\bname\\s*:\\s*' + str(5) + '[^}]*\\}|name\\s*=\\s*' + str(7) + '))?',
  'g'
);

// The last locator in a chain is the element acted on (earlier ones only narrow it).
function locatorOf(stmt) {
  let last = null;
  for (const m of stmt.matchAll(LOCATOR_RE)) last = m;
  if (!last) return null;
  const kind = String(last[1] || last[2] || 'locator').toLowerCase().replace(/_/g, '');
  const arg = unescape(last[4] ?? '');
  const optName = last[6] != null ? unescape(last[6]) : last[8] != null ? unescape(last[8]) : null;
  // Only a lone `locator('#id')` can be a CSS selector; the others carry a real label.

  if (kind === 'role') return { role: arg, name: optName || '' };
  if (kind === 'label' || kind === 'placeholder') return { role: 'textbox', name: arg };
  return { role: '', name: arg };
}

const strArg = (stmt, after) => {
  const idx = stmt.indexOf(after);
  if (idx < 0) return null;
  const m = new RegExp(STR).exec(stmt.slice(idx + after.length));
  return m ? unescape(m[2]) : null;
};

const baseName = (p) => String(p).split(/[\\/]/).pop();

// One statement -> one action, or null when it is not something we model.
function actionFor(stmt) {
  const goto = /(?:^|\.)goto\(\s*(['"`])((?:\\.|(?!\1).)*)\1/.exec(stmt);
  if (goto) return { type: 'navigate', url: unescape(goto[2]) };

  const el = locatorOf(stmt);
  if (!el) return null;
  const secretField = SECRET_NAME_RE.test(el.name) || el.role === 'password';
  const base = { role: el.role || undefined, name: el.name || undefined };

  // Assertions first: `expect(...).toBeVisible()` also contains a locator.
  if (/\b(toBeVisible|to_be_visible)\(/.test(stmt)) return { type: 'assert-visible', ...base };
  if (/\b(toHaveText|toContainText|to_have_text|to_contain_text)\(/.test(stmt)) {
    const value = strArg(stmt, /toHaveText\(|toContainText\(|to_have_text\(|to_contain_text\(/.exec(stmt)[0]);
    return secretField ? { type: 'assert-text', ...base, sensitive: true } : { type: 'assert-text', ...base, value: value ?? '' };
  }
  if (/\b(toHaveValue|to_have_value)\(/.test(stmt)) {
    const value = strArg(stmt, /toHaveValue\(|to_have_value\(/.exec(stmt)[0]);
    return secretField ? { type: 'assert-value', ...base, sensitive: true } : { type: 'assert-value', ...base, value: value ?? '' };
  }
  if (/\bexpect\(/.test(stmt)) return null; // some other assertion — not modelled

  if (/\.(fill|pressSequentially|type)\(/.test(stmt)) {
    const value = strArg(stmt, /\.(?:fill|pressSequentially|type)\(/.exec(stmt)[0]);
    return secretField ? { type: 'fill', ...base, sensitive: true } : { type: 'fill', ...base, value: value ?? '' };
  }
  if (/\.(selectOption|select_option)\(/.test(stmt)) {
    return { type: 'select', ...base, value: strArg(stmt, /\.(?:selectOption|select_option)\(/.exec(stmt)[0]) ?? '' };
  }
  if (/\.check\(/.test(stmt)) return { type: 'check', ...base, checked: true };
  if (/\.uncheck\(/.test(stmt)) return { type: 'check', ...base, checked: false };
  if (/\.(setInputFiles|set_input_files)\(/.test(stmt)) {
    const names = [...stmt.matchAll(new RegExp(STR, 'g'))].map((m) => baseName(unescape(m[2]))).filter((n) => /\.\w{1,6}$/.test(n));
    return { type: 'upload', ...base, fileNames: names };
  }
  if (/\.(click|dblclick)\(/.test(stmt)) return { type: 'click', ...base };
  return null;
}

// Cuts the script into one chunk per test (JS `test('x', ...)` or Python `def test_x(`).
function splitTests(source, fallbackTitle) {
  const starts = [];
  const re = /\btest(?:\.\w+)?\(\s*(['"`])((?:\\.|(?!\1).)*)\1\s*,|^\s*(?:async\s+)?def\s+(test_\w+)\s*\(/gm;
  for (const m of source.matchAll(re)) {
    starts.push({ index: m.index, title: m[2] ? unescape(m[2]) : m[3].replace(/^test_/, '').replace(/_/g, ' ') });
  }
  if (!starts.length) return [{ title: fallbackTitle, body: source }];
  return starts.map((s, i) => ({ title: s.title, body: source.slice(s.index, starts[i + 1]?.index ?? source.length) }));
}

function parseCodegen(content, filename = '') {
  const source = String(content ?? '');
  if (Buffer.byteLength(source, 'utf8') > MAX_BYTES) {
    throw new Error('That script is too large to import (limit 500 KB).');
  }
  if (!source.trim()) throw new Error('The file was empty.');

  const fallback = baseName(filename).replace(/\.\w+$/, '').replace(/[-_.]+/g, ' ').trim() || 'Imported script';
  const flows = [];
  let skipped = 0;

  for (const { title, body } of splitTests(source, fallback).slice(0, MAX_FLOWS)) {
    // Drop comments, join `.chained()\n.calls()` back into one statement per line.
    const statements = body
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*(\/\/|#).*$/gm, '')
      .replace(/\n\s*\./g, '.')
      .split('\n')
      .map((l) => l.trim().replace(/^await\s+/, '').replace(/;$/, ''))
      .filter((l) => /^(page\w*|expect|frame\w*)\b/.test(l) || /\bpage\w*\./.test(l));

    const actions = [];
    for (const stmt of statements) {
      const action = actionFor(stmt);
      if (!action) {
        // Only calls that look like browser steps count as "not understood".
        if (/\.(click|fill|press|hover|check|select|goto|expect|to_)|^expect\(/i.test(stmt)) skipped++;
        continue;
      }
      actions.push(scrubAction(action));
      if (actions.length >= MAX_ACTIONS) break;
    }
    if (!actions.length) continue;

    const nav = actions.find((a) => a.type === 'navigate');
    flows.push({
      title: title.slice(0, 200),
      startUrl: nav?.url || '',
      actions: actions.map((a, seq) => ({ seq, ...a })),
    });
  }

  const warnings = [];
  if (!flows.length) {
    throw new Error('No browser steps were found in that file. It should be a script from Playwright codegen — lines like page.goto(…), page.getByRole(…).click().');
  }
  if (skipped) warnings.push(`${skipped} line${skipped === 1 ? '' : 's'} used something this importer doesn't read (such as a custom helper or an unusual assertion) and ${skipped === 1 ? 'was' : 'were'} skipped.`);
  if (flows.some((f) => f.actions.some((a) => a.sensitive))) warnings.push('Values typed into password-like fields were dropped, not imported.');
  if (flows.some((f) => !f.startUrl)) warnings.push('One script has no page.goto(…), so it has no start link.');
  return { flows, warnings };
}

module.exports = { parseCodegen, MAX_BYTES };
