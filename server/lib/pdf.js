// A printable PDF of a run's test cases: one block per ticked test case with its ID,
// precondition, steps and Examples — the same content and the same IDs as the Excel.
//
// It is built as a plain HTML page and printed by the browser the app already uses
// for recording and sign-in, so there is no extra library. The page runs with
// JavaScript off and every network request refused: it is only ever printed.

const { chromium } = require('playwright-core');
const { idPrefix, includedScenarios, PRIORITY_BY_TYPE } = require('./excel');
const { labelForType } = require('./testTypes');

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function tableHtml(rows, cls) {
  if (!Array.isArray(rows) || !rows.length) return '';
  const [head, ...body] = rows;
  return `<table class="${cls}">
    <thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody>
  </table>`;
}

function stepHtml(step) {
  const keyword = esc(step.keyword);
  return `<li><span class="kw kw-${keyword.toLowerCase()}">${keyword}</span> ${esc(step.text)}${tableHtml(step.dataTable, 'data')}</li>`;
}

function scenarioHtml(scenario, id, index) {
  const steps = (scenario.steps || []).filter((s) => s.included !== false);
  const isOutline = Boolean(scenario.isOutline) && Array.isArray(scenario.examples) && scenario.examples.length > 1;
  const type = scenario.testType ? labelForType(scenario.testType) : '';
  return `<section class="tc">
    <div class="tc-head"><span class="tc-id">${esc(id)}</span><h2>${esc(scenario.title)}</h2></div>
    ${type ? `<div class="tc-meta">${esc(type)} · Priority ${esc(PRIORITY_BY_TYPE[scenario.testType] || 'Medium')}</div>` : ''}
    ${scenario.description ? `<div class="pre"><b>Precondition</b> ${esc(scenario.description)}</div>` : ''}
    <ol class="steps">${steps.map(stepHtml).join('')}</ol>
    ${isOutline ? `<div class="examples"><b>Examples</b> — runs once per row</div>${tableHtml(scenario.examples, 'ex')}` : ''}
  </section>`;
}

function buildReportHtml(run, now = new Date()) {
  const prefix = idPrefix(run.featureTitle);
  const scenarios = includedScenarios(run);
  const rows = scenarios.map((s, i) => ({ s, id: s.testId || `${prefix}-${String(i + 1).padStart(3, '0')}` }));

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(run.featureTitle)}</title><style>
    * { box-sizing: border-box; }
    body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 10.5pt; color: #1b2230; margin: 0; }
    h1 { font-size: 21pt; margin: 0 0 4px; }
    .lede { color: #4a5568; margin: 0 0 6px; }
    .meta { color: #6b7385; font-size: 9pt; margin-bottom: 16px; }
    h3 { font-size: 11pt; margin: 18px 0 6px; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #d5d9e0; padding: 4px 8px; text-align: left; vertical-align: top; font-size: 9.5pt; }
    th { background: #f1f4fb; }
    .glance td:first-child { white-space: nowrap; font-weight: 600; width: 1%; }
    .tc { margin-top: 16px; padding-top: 10px; border-top: 2px solid #2f5fed; break-inside: avoid; }
    .tc-head { display: flex; gap: 10px; align-items: baseline; }
    .tc-id { background: #eaf0ff; color: #2f5fed; font-weight: 700; font-size: 9pt; padding: 2px 8px; border-radius: 10px; white-space: nowrap; }
    h2 { font-size: 12.5pt; margin: 0; }
    .tc-meta { color: #6b7385; font-size: 9pt; margin: 3px 0 0; }
    .pre { margin: 8px 0 0; padding: 6px 10px; background: #fff7e6; border-left: 3px solid #e0a100; }
    .steps { margin: 8px 0 0; padding-left: 0; list-style: none; }
    .steps li { margin: 3px 0; }
    .kw { display: inline-block; min-width: 46px; font-weight: 700; color: #2f5fed; }
    table.data, table.ex { width: auto; margin: 4px 0 4px 52px; }
    .examples { margin: 8px 0 3px; }
  </style></head><body>
    <h1>${esc(run.featureTitle)}</h1>
    ${run.featureDescription ? `<p class="lede">${esc(run.featureDescription)}</p>` : ''}
    <div class="meta">${scenarios.length} test case${scenarios.length === 1 ? '' : 's'} · ${esc(now.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }))}${run.sourceUrl ? ` · ${esc(run.sourceUrl)}` : ''}</div>
    <h3>Test cases at a glance</h3>
    <table class="glance"><thead><tr><th>ID</th><th>Test case</th><th>Type</th><th>Priority</th></tr></thead><tbody>
      ${rows.map(({ s, id }) => `<tr><td>${esc(id)}</td><td>${esc(s.title)}</td><td>${esc(s.testType ? labelForType(s.testType) : '')}</td><td>${esc(PRIORITY_BY_TYPE[s.testType] || 'Medium')}</td></tr>`).join('')}
    </tbody></table>
    ${rows.map(({ s, id }, i) => scenarioHtml(s, id, i)).join('')}
  </body></html>`;
}

// Same preference order as the sign-in window: an installed build ships without
// Playwright's own browsers, so the installed Chrome or Edge is how this works.
const ATTEMPTS = [{ channel: 'chrome' }, { channel: 'msedge' }, {}];

async function launchHeadless() {
  let lastError;
  for (const attempt of ATTEMPTS) {
    try {
      return await chromium.launch({ headless: true, ...attempt });
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

async function renderPdf(run) {
  let browser;
  try {
    browser = await launchHeadless();
  } catch (err) {
    const e = new Error('Could not open a browser to make the PDF. Install Google Chrome or Microsoft Edge and try again.');
    e.status = 500;
    throw e;
  }

  try {
    const context = await browser.newContext({ javaScriptEnabled: false });
    await context.route('**/*', (route) => route.abort());
    const page = await context.newPage();
    await page.setContent(buildReportHtml(run), { waitUntil: 'load', timeout: 30000 });
    const title = esc(run.featureTitle).slice(0, 80);
    return await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '18mm', bottom: '18mm', left: '15mm', right: '15mm' },
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: `<div style="width:100%;font-size:8px;color:#6b7385;padding:0 15mm;display:flex;justify-content:space-between;font-family:Arial,sans-serif"><span>${title}</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`,
    });
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { buildReportHtml, renderPdf };
