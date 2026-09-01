const ExcelJS = require('exceljs');
const { labelForType, tagForType } = require('./testTypes');
const { isOutline, exampleRowCount } = require('./placeholders');

// Matches the column layout the team's scripts-to-excel skill defines, so a sheet
// from here drops straight into the existing QA tracker.
const TEST_CASE_COLUMNS = [
  { header: 'Test ID', key: 'testId', width: 12 },
  { header: 'Summary', key: 'summary', width: 52 },
  { header: 'Description', key: 'description', width: 46 },
  { header: 'Test Steps', key: 'steps', width: 74 },
  { header: 'Priority', key: 'priority', width: 10 },
  { header: 'Test Type', key: 'testType', width: 14 },
];

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F5FED' } };
const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
const THIN_BORDER = { style: 'thin', color: { argb: 'FFD5D9E0' } };

function styleHeader(sheet) {
  const row = sheet.getRow(1);
  row.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
    cell.border = { bottom: THIN_BORDER };
  });
  row.height = 22;
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
}

function bodyStyle(sheet, fromRow) {
  for (let r = fromRow; r <= sheet.rowCount; r++) {
    sheet.getRow(r).eachCell((cell) => {
      cell.alignment = { vertical: 'top', wrapText: true };
      cell.border = { bottom: THIN_BORDER };
      cell.font = { size: 10 };
    });
  }
}

// A step plus its data table, rendered as the Gherkin text a tester reads.
function stepLines(step) {
  const lines = [`${step.keyword} ${step.text}`];
  if (Array.isArray(step.dataTable) && step.dataTable.length) {
    for (const row of step.dataTable) lines.push(`  | ${row.join(' | ')} |`);
  }
  return lines;
}

// Priority is inferred from the kind of test, since we don't ask the user to set
// it per case. Happy path and security are what you run first.
const PRIORITY_BY_TYPE = {
  'happy-path': 'High',
  security: 'High',
  'negative-path': 'Medium',
  validation: 'Medium',
  permissions: 'High',
  'data-integrity': 'Medium',
  api: 'Medium',
  'edge-case': 'Low',
  performance: 'Low',
  accessibility: 'Medium',
};

function idPrefix(featureTitle) {
  const initials = String(featureTitle || 'TC')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((w) => w[0].toUpperCase())
    .join('');
  return initials.length >= 2 ? initials : 'TC';
}

function includedScenarios(run) {
  return run.scenarios.filter((s) => s.included !== false);
}

function addTestCasesSheet(workbook, run) {
  const sheet = workbook.addWorksheet('Test Cases');
  sheet.columns = TEST_CASE_COLUMNS;

  const prefix = idPrefix(run.featureTitle);
  includedScenarios(run).forEach((scenario, i) => {
    const lines = scenario.steps.filter((st) => st.included !== false).flatMap(stepLines);

    // A Scenario Outline only makes sense in the sheet with its Examples table.
    if (isOutline(scenario) && exampleRowCount(scenario) > 0) {
      lines.push('', 'Examples:');
      for (const row of scenario.examples) lines.push(`  | ${row.join(' | ')} |`);
    }

    const steps = lines.join('\n');

    const requirementText = (scenario.coversRequirementIds || [])
      .map((id) => run.requirements.find((r) => r.id === id)?.text)
      .filter(Boolean)
      .join('; ');

    sheet.addRow({
      testId: `${prefix}-${String(i + 1).padStart(3, '0')}`,
      summary: isOutline(scenario) ? `${scenario.title} (outline — ${exampleRowCount(scenario)} cases)` : scenario.title,
      description: requirementText || run.featureDescription || run.featureTitle,
      steps,
      priority: PRIORITY_BY_TYPE[scenario.testType] || 'Medium',
      testType: 'Cucumber',
    });
  });

  styleHeader(sheet);
  bodyStyle(sheet, 2);
  sheet.autoFilter = { from: 'A1', to: 'F1' };
  return sheet;
}

// Requirement-to-test traceability. In regulated work this is often the artifact
// an auditor asks for, so it gets its own sheet with explicit gaps called out.
function addTraceabilitySheet(workbook, run) {
  const sheet = workbook.addWorksheet('Traceability');
  sheet.columns = [
    { header: 'Req ID', key: 'reqId', width: 10 },
    { header: 'Requirement', key: 'requirement', width: 62 },
    { header: 'Covered By', key: 'coveredBy', width: 56 },
    { header: 'Test Count', key: 'count', width: 11 },
    { header: 'QA Confirmed', key: 'confirmed', width: 13 },
    { header: 'Status', key: 'status', width: 14 },
  ];

  const live = includedScenarios(run);

  run.requirements.forEach((req, i) => {
    const covering = live.filter((s) => (s.coversRequirementIds || []).includes(req.id));
    const status = covering.length === 0 ? 'GAP — no test' : req.covered ? 'Confirmed' : 'Awaiting review';

    const row = sheet.addRow({
      reqId: `REQ-${String(i + 1).padStart(3, '0')}`,
      requirement: req.text,
      coveredBy: covering.map((s) => s.title).join('\n') || '—',
      count: covering.length,
      confirmed: req.covered ? 'Yes' : 'No',
      status,
    });

    if (covering.length === 0) {
      row.getCell('status').font = { bold: true, color: { argb: 'FFC0392B' }, size: 10 };
    } else if (req.covered) {
      row.getCell('status').font = { color: { argb: 'FF1A9E5C' }, size: 10 };
    }
  });

  styleHeader(sheet);
  bodyStyle(sheet, 2);

  // Re-apply status colours, which bodyStyle overwrote.
  run.requirements.forEach((req, i) => {
    const covering = live.filter((s) => (s.coversRequirementIds || []).includes(req.id));
    const cell = sheet.getRow(i + 2).getCell('status');
    if (covering.length === 0) cell.font = { bold: true, color: { argb: 'FFC0392B' }, size: 10 };
    else if (req.covered) cell.font = { color: { argb: 'FF1A9E5C' }, size: 10 };
  });

  sheet.autoFilter = { from: 'A1', to: 'F1' };
  return sheet;
}

function addSummarySheet(workbook, run) {
  const sheet = workbook.addWorksheet('Summary');
  sheet.columns = [
    { header: 'Field', key: 'field', width: 26 },
    { header: 'Value', key: 'value', width: 78 },
  ];

  const live = includedScenarios(run);
  const byType = live.reduce((acc, s) => {
    const label = s.testType ? labelForType(s.testType) : 'Untyped';
    acc[label] = (acc[label] || 0) + 1;
    return acc;
  }, {});

  const covered = run.requirements.filter((r) => r.covered).length;
  const gaps = run.requirements.filter(
    (r) => !live.some((s) => (s.coversRequirementIds || []).includes(r.id))
  ).length;

  const rows = [
    ['Feature', run.featureTitle],
    ['Description', run.featureDescription || '—'],
    ['Generated', new Date(run.createdAt).toLocaleString()],
    ['Source', run.sourceUrl || 'Written description'],
    ['Explored interactively', run.sourceUrl ? (run.exploredInteractively ? 'Yes' : 'No — read-only') : 'n/a'],
    ['Review pass applied', run.refined ? 'Yes' : 'No'],
    ['Test cases exported', String(live.length)],
    ['Test cases excluded', String(run.scenarios.length - live.length)],
    ['Requirements', String(run.requirements.length)],
    ['Requirements QA-confirmed', `${covered} of ${run.requirements.length}`],
    ['Requirements with no test', String(gaps)],
    ['', ''],
    ['Breakdown by type', ''],
    ...Object.entries(byType).map(([k, v]) => [`  ${k}`, String(v)]),
  ];

  for (const [field, value] of rows) sheet.addRow({ field, value });

  styleHeader(sheet);
  bodyStyle(sheet, 2);
  for (let r = 2; r <= sheet.rowCount; r++) {
    sheet.getRow(r).getCell('field').font = { bold: true, size: 10 };
  }
  return sheet;
}

async function buildWorkbook(run) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'BDD Test Generator';
  workbook.created = new Date();

  addSummarySheet(workbook, run);
  addTestCasesSheet(workbook, run);
  addTraceabilitySheet(workbook, run);

  return workbook.xlsx.writeBuffer();
}

// Traceability on its own, for when that's the only thing being handed over.
async function buildTraceabilityWorkbook(run) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'BDD Test Generator';
  workbook.created = new Date();
  addTraceabilitySheet(workbook, run);
  addSummarySheet(workbook, run);
  return workbook.xlsx.writeBuffer();
}

module.exports = { buildWorkbook, buildTraceabilityWorkbook, tagForType };
