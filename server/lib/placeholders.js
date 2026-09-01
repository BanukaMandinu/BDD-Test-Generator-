// Scenario Outline placeholder handling.
//
// Cucumber substitutes <name> tokens in a Scenario Outline's steps from the
// Examples table, once per data row. The Examples header names must match the
// placeholder names exactly, so most of this file exists to keep those two sides
// in sync and to report it when they drift.

const PLACEHOLDER_RE = /<([^<>]+)>/g;

// Every placeholder name used anywhere in a step — its text, and any cell of a
// data table attached to it (Gherkin allows placeholders in both).
function placeholdersInStep(step) {
  const found = [];
  const scan = (text) => {
    for (const m of String(text ?? '').matchAll(PLACEHOLDER_RE)) found.push(m[1].trim());
  };

  scan(step.text);
  if (Array.isArray(step.dataTable)) {
    for (const row of step.dataTable) for (const cell of row) scan(cell);
  }
  return found;
}

function placeholdersInScenario(scenario) {
  const names = new Set();
  for (const step of scenario.steps || []) {
    for (const name of placeholdersInStep(step)) names.add(name);
  }
  return [...names];
}

// Examples is stored the same shape as a data table: first row is the header.
function exampleHeaders(scenario) {
  const rows = scenario.examples;
  if (!Array.isArray(rows) || !rows.length) return [];
  return rows[0].map((h) => String(h ?? '').trim());
}

function exampleRowCount(scenario) {
  const rows = scenario.examples;
  return Array.isArray(rows) && rows.length ? rows.length - 1 : 0;
}

// Renaming an Examples column has to rewrite every <old> token in the scenario,
// or the outline silently breaks.
function renamePlaceholder(scenario, oldName, newName) {
  const from = String(oldName).trim();
  const to = String(newName).trim();
  if (!from || !to || from === to) return scenario;

  const swap = (text) =>
    String(text ?? '').split(`<${from}>`).join(`<${to}>`);

  for (const step of scenario.steps || []) {
    step.text = swap(step.text);
    if (Array.isArray(step.dataTable)) {
      step.dataTable = step.dataTable.map((row) => row.map(swap));
    }
  }
  return scenario;
}

// Normalizes whatever the model or client sent into a clean rows array, or null.
function normalizeExamples(raw) {
  if (!Array.isArray(raw) || raw.length < 1) return null;
  const rows = raw.filter(Array.isArray).map((row) => row.map((c) => String(c ?? '')));
  if (!rows.length) return null;

  const width = Math.max(...rows.map((r) => r.length));
  return rows.map((r) => [...r, ...Array(width - r.length).fill('')]);
}

// A scenario is a genuine outline only if it's flagged AND actually parameterised.
function isOutline(scenario) {
  return Boolean(scenario.isOutline) && placeholdersInScenario(scenario).length > 0;
}

module.exports = {
  PLACEHOLDER_RE,
  placeholdersInStep,
  placeholdersInScenario,
  exampleHeaders,
  exampleRowCount,
  renamePlaceholder,
  normalizeExamples,
  isOutline,
};
