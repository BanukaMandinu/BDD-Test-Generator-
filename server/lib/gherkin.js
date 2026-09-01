const { tagForType } = require('./testTypes');
const { isOutline, exampleRowCount } = require('./placeholders');

function slugify(text) {
  return (
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '') || 'feature'
  );
}

// Renders a data table as aligned Gherkin pipe rows. Pipes, backslashes and
// newlines inside a cell must be escaped or they'd break the column split.
function dataTableLines(table, indent) {
  const escaped = table.map((row) =>
    row.map((cell) =>
      String(cell ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/\|/g, '\\|')
        .replace(/\n/g, '\\n')
    )
  );

  const width = Math.max(...escaped.map((r) => r.length));
  const colWidths = [];
  for (let c = 0; c < width; c++) {
    colWidths[c] = Math.max(...escaped.map((r) => (r[c] || '').length));
  }

  return escaped.map((row) => {
    const cells = [];
    for (let c = 0; c < width; c++) cells.push((row[c] || '').padEnd(colWidths[c]));
    return `${indent}| ${cells.join(' | ')} |`;
  });
}

function toFeatureText(run) {
  const lines = [`Feature: ${run.featureTitle}`];
  if (run.featureDescription) lines.push(`  ${run.featureDescription}`);
  lines.push('');

  // When a run covers several pages, mark which page each group came from. A
  // Gherkin comment keeps the file valid and survives a round-trip through the
  // importer, which skips comments.
  const pagesInRun = new Set(
    run.scenarios.filter((s) => s.included !== false && s.page).map((s) => s.page)
  );
  const showPageComments = pagesInRun.size > 1;
  let lastPage = null;

  for (const scenario of run.scenarios) {
    if (scenario.included === false) continue;

    if (showPageComments && scenario.page && scenario.page !== lastPage) {
      lines.push(`  # Page: ${scenario.page}`);
      lastPage = scenario.page;
    }

    const tag = tagForType(scenario.testType);
    if (tag) lines.push(`  ${tag}`);

    // Only emit "Scenario Outline" when it's genuinely parameterised — an outline
    // with no placeholders (or no Examples rows) is invalid Gherkin.
    const outline = isOutline(scenario) && exampleRowCount(scenario) > 0;
    lines.push(`  ${outline ? 'Scenario Outline' : 'Scenario'}: ${scenario.title}`);

    for (const step of scenario.steps) {
      if (step.included === false) continue;
      lines.push(`    ${step.keyword} ${step.text}`);
      if (Array.isArray(step.dataTable) && step.dataTable.length) {
        lines.push(...dataTableLines(step.dataTable, '      '));
      }
    }

    if (outline) {
      lines.push('');
      lines.push('    Examples:');
      lines.push(...dataTableLines(scenario.examples, '      '));
    }

    lines.push('');
  }

  return lines.join('\n');
}

module.exports = { toFeatureText, dataTableLines, slugify };
