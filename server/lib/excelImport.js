// Reads a test-case spreadsheet (.xlsx) back into the app's run shape, so a team's
// existing Excel sheet can be reviewed, revised and re-exported here.
//
// Deterministic — no model call. A workbook can hold many sheets (one per
// feature), so this is two steps: listSheets() so the user can choose, then
// parseSheet() for the chosen one. The Steps cell is Gherkin text, so it goes
// through the same parser as a .feature file rather than a second grammar.
//
// The file is untrusted: cells are read as text only (a formula is never
// evaluated) and row/size counts are bounded.

const ExcelJS = require('exceljs');
const { parseFeature } = require('./featureParser');

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 2000;
const MAX_COLUMNS = 30;

// Header text (lower-cased, punctuation stripped) -> the field it holds. Covers
// this app's own export and the team's tracker layout.
const HEADER_ALIASES = {
  testId: ['test id', 'testid', 'id', 'tc id', 'test case id', 'key'],
  summary: ['summary', 'title', 'test case', 'test case title', 'scenario', 'name'],
  description: ['description', 'objective', 'purpose'],
  steps: ['test steps', 'steps', 'test step', 'scenario steps', 'gherkin', 'bdd'],
  priority: ['priority'],
  testType: ['test type', 'type'],
};

// What the sheet looks like with no header row at all, as in a sheet whose
// first row is already TC-01: ID, Summary, Description, Steps.
const POSITIONAL = { testId: 1, summary: 2, description: 3, steps: 4 };

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

// Cell values come back as strings, numbers, dates, rich text, hyperlinks or
// formula results depending on how the sheet was authored.
function cellText(cell) {
  if (!cell || cell.value == null) return '';
  const text = typeof cell.text === 'string' ? cell.text : String(cell.value);
  return text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').trim();
}

function decode(base64) {
  const buffer = Buffer.from(String(base64 ?? ''), 'base64');
  if (!buffer.length) throw new Error('That file was empty.');
  if (buffer.length > MAX_BYTES) throw new Error('That file is too large to import (limit 2 MB).');
  // .xlsx is a zip container. Catching an obvious mismatch here (an old .xls, a
  // renamed file) gives a clearer message than the library's own parse error.
  if (buffer.subarray(0, 2).toString('latin1') !== 'PK') {
    throw new Error('That is not a .xlsx workbook. Old .xls files need to be re-saved as .xlsx first.');
  }
  return buffer;
}

async function load(base64) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(decode(base64));
  } catch (err) {
    if (/too large|empty|not a \.xlsx/i.test(err.message)) throw err;
    throw new Error('That workbook could not be read — it may be corrupt or password-protected.');
  }
  return workbook;
}

function findColumns(sheet) {
  const limit = Math.min(sheet.actualRowCount ? sheet.rowCount : 0, 10);
  for (let r = 1; r <= limit; r++) {
    const row = sheet.getRow(r);
    const found = {};
    for (let c = 1; c <= Math.min(row.cellCount, MAX_COLUMNS); c++) {
      const header = norm(cellText(row.getCell(c)));
      if (!header) continue;
      for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
        if (!(field in found) && aliases.includes(header)) found[field] = c;
      }
    }
    // A header row has to name at least a title and the steps to be trusted.
    if (found.summary && found.steps) return { columns: found, firstDataRow: r + 1, hasHeader: true };
  }
  return { columns: POSITIONAL, firstDataRow: 1, hasHeader: false };
}

// A cell that "reads like" Gherkin — used to tell a test-case sheet from a
// summary or notes sheet when offering the choice.
const STEP_LINE = /^\s*(given|when|then|and|but)\s/im;

function describeSheet(sheet) {
  const { columns, firstDataRow, hasHeader } = findColumns(sheet);
  let cases = 0;
  let withSteps = 0;
  const last = Math.min(sheet.rowCount, MAX_ROWS);
  for (let r = firstDataRow; r <= last; r++) {
    const row = sheet.getRow(r);
    const summary = cellText(row.getCell(columns.summary));
    const steps = cellText(row.getCell(columns.steps));
    if (!summary && !steps) continue;
    cases++;
    if (STEP_LINE.test(steps)) withSteps++;
  }
  return { name: sheet.name, testCases: cases, looksLikeTestCases: withSteps > 0, hasHeader };
}

async function listSheets(base64) {
  const workbook = await load(base64);
  const sheets = workbook.worksheets
    // Hidden sheets are usually lookups or scratch space, not something to review.
    .filter((s) => s.state === 'visible')
    .map(describeSheet);
  if (!sheets.length) throw new Error('That workbook has no visible sheets.');
  return sheets;
}

// One cell's steps -> a Scenario block, parsed by the .feature parser. A title or
// step line that happens to start with a Gherkin keyword can't forge structure,
// because each row is parsed on its own and only its scenario is kept.
function rowToScenario(title, stepsText, testId) {
  const safeTitle = title.replace(/\s*\n\s*/g, ' ').trim() || 'Untitled test case';
  const parsed = parseFeature(`Feature: x\nScenario: ${safeTitle}\n${stepsText}`);
  const scenario = parsed.scenarios[0];
  if (!scenario) return { scenario: null, warnings: parsed.warnings };
  scenario.title = safeTitle;
  if (testId) scenario.testId = testId.slice(0, 40);
  return { scenario, warnings: parsed.warnings };
}

async function parseSheet(base64, sheetName) {
  const workbook = await load(base64);
  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) throw new Error(`The sheet "${sheetName}" wasn't found in that workbook.`);

  const { columns, firstDataRow, hasHeader } = findColumns(sheet);
  const warnings = [];
  if (!hasHeader) {
    warnings.push('No header row was recognised, so columns A–D were read as Test ID, Summary, Description and Test Steps.');
  }

  const scenarios = [];
  const descriptions = new Set();
  const skipped = [];
  const last = Math.min(sheet.rowCount, MAX_ROWS);

  for (let r = firstDataRow; r <= last; r++) {
    const row = sheet.getRow(r);
    const testId = columns.testId ? cellText(row.getCell(columns.testId)) : '';
    const summary = cellText(row.getCell(columns.summary));
    const stepsText = cellText(row.getCell(columns.steps));
    const description = columns.description ? cellText(row.getCell(columns.description)) : '';

    if (!summary && !stepsText) continue; // blank row

    const { scenario, warnings: rowWarnings } = rowToScenario(summary, stepsText, testId);
    if (!scenario) {
      skipped.push(testId || `row ${r}`);
      continue;
    }
    // Older exports appended " (outline — N cases)" to the summary; take it off so
    // re-importing one doesn't keep the tag.
    scenario.title = scenario.title.replace(/\s*\(outline\s*[—-]\s*\d+ cases?\)\s*$/i, '');
    // Each test case keeps its own description; the feature only takes one when
    // every row shares it (below).
    if (description) scenario.description = description.slice(0, 2000);
    scenarios.push(scenario);
    if (description) descriptions.add(description);
    for (const w of rowWarnings) if (!warnings.includes(w)) warnings.push(w);
  }

  if (skipped.length) {
    const shown = skipped.slice(0, 8).join(', ');
    warnings.push(
      `${skipped.length} row${skipped.length === 1 ? ' had' : 's had'} no recognisable Given/When/Then steps and ${skipped.length === 1 ? 'was' : 'were'} skipped: ${shown}${skipped.length > 8 ? ', …' : ''}.`
    );
  }
  if (sheet.rowCount > MAX_ROWS) {
    warnings.push(`Only the first ${MAX_ROWS} rows were read.`);
  }

  return {
    featureTitle: sheet.name,
    // A single shared description is the feature's; otherwise per-row text
    // would be misleading as one description, so leave it blank.
    featureDescription: descriptions.size === 1 ? [...descriptions][0] : '',
    scenarios,
    warnings,
  };
}

module.exports = { listSheets, parseSheet, MAX_BYTES };
