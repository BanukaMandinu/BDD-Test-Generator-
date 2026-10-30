// Fixes for the problems the quality check reports.
//
// Two tiers, because they fail differently:
//   1. Mechanical fixes — an outline with one Examples row, a column nothing uses,
//      a flagged outline with no placeholders. These have exactly one correct
//      answer, so they are done here, instantly, with no model call.
//   2. Everything else (wording, structure, step reuse, voice) needs judgment, so
//      the route sends each affected test case to the model on its own, with only
//      that case's problems as the brief.
//
// Nothing here deletes a test case. A duplicate is unticked with a reason, which
// is reversible and shows on the card, the same as a website-check removal.

const { PLACEHOLDER_RE, placeholdersInScenario, exampleHeaders, exampleRowCount } = require('./placeholders');

// What the Fix button can act on. Uncovered requirements and missing test types
// need new test cases written, which is a different job from repairing one.
const FIXABLE_KINDS = ['outline', 'duplicate', 'cucumber', 'reuse', 'language'];

function labelFor(scenario, index) {
  return scenario.testId || `#${index + 1}`;
}

function shortTitle(title, max = 70) {
  const t = String(title ?? '').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// Cheap "did anything change" check for reporting which cases a pass touched.
function fingerprint(scenario) {
  return JSON.stringify([
    scenario.title,
    scenario.description || null,
    Boolean(scenario.isOutline),
    scenario.examples || null,
    (scenario.steps || []).map((s) => [s.keyword, s.text, s.dataTable || null, s.included !== false]),
  ]);
}

function fillTokens(text, values) {
  return String(text ?? '').replace(PLACEHOLDER_RE, (whole, name) => {
    const key = name.trim();
    return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : whole;
  });
}

// Mutates the scenario; returns a note for each thing it changed (empty = untouched).
function fixOutlineMechanically(scenario) {
  const notes = [];
  const used = placeholdersInScenario(scenario);

  // Flagged as an outline but nothing is parameterised.
  if (scenario.isOutline && !used.length) {
    scenario.isOutline = false;
    scenario.examples = null;
    return ['no <placeholders> in its steps, so it is now a plain Scenario'];
  }

  // Parameterised and already has a matching table, just never flagged.
  if (!scenario.isOutline && used.length && exampleRowCount(scenario) > 0) {
    const headers = exampleHeaders(scenario);
    if (used.every((name) => headers.includes(name))) {
      scenario.isOutline = true;
      notes.push('it uses <placeholders> with an Examples table, so it is now a Scenario Outline');
    }
  }

  if (!(scenario.isOutline && used.length)) return notes;

  // Columns no step refers to are dead weight.
  const headers = exampleHeaders(scenario);
  const keep = headers.map((h, i) => (used.includes(h) ? i : -1)).filter((i) => i >= 0);
  if (keep.length && keep.length < headers.length) {
    const dropped = headers.filter((h, i) => !keep.includes(i)).filter(Boolean);
    scenario.examples = scenario.examples.map((row) => keep.map((i) => row[i] ?? ''));
    notes.push(`removed the unused Examples column${dropped.length === 1 ? '' : 's'} ${dropped.map((h) => `"${h}"`).join(', ')}`);
  }

  // One row is just a Scenario with the value written in.
  const finalHeaders = exampleHeaders(scenario);
  if (exampleRowCount(scenario) === 1 && used.every((name) => finalHeaders.includes(name))) {
    const row = scenario.examples[1];
    const values = {};
    finalHeaders.forEach((h, i) => { values[h] = String(row[i] ?? '').trim(); });

    if (used.every((name) => values[name])) {
      for (const step of scenario.steps || []) {
        step.text = fillTokens(step.text, values);
        if (Array.isArray(step.dataTable)) {
          step.dataTable = step.dataTable.map((r) => r.map((cell) => fillTokens(cell, values)));
        }
      }
      scenario.isOutline = false;
      scenario.examples = null;
      notes.push('it had only one Examples row, so it is now a plain Scenario with the value filled in');
    }
  }

  return notes;
}

// Unticks the later of each duplicate pair. Returns what it flagged.
function flagDuplicates(scenarios, duplicateIssues) {
  const byId = new Map(scenarios.map((s, i) => [s.id, { scenario: s, index: i }]));
  const flagged = [];

  for (const issue of duplicateIssues) {
    const [firstId, secondId] = issue.scenarioIds || [];
    const first = byId.get(firstId);
    const second = byId.get(secondId);
    if (!first || !second) continue;
    if (first.scenario.included === false || second.scenario.included === false) continue;

    second.scenario.included = false;
    second.scenario.lastReviewApplied = `Suggested removal — looks like the same test as "${shortTitle(first.scenario.title, 100)}"`;
    flagged.push({ ...second, of: first });
  }
  return flagged;
}

// The brief for the model: just this test case's problems, and a hard limit on scope.
function buildFixNote(issues) {
  const seen = new Set();
  const lines = [];
  for (const issue of issues) {
    const text = issue.instruction || issue.message;
    if (seen.has(text)) continue;
    seen.add(text);
    lines.push(`- ${text}`);
    if (lines.length >= 12) break;
  }
  return [
    'Fix ONLY these quality problems in this test case. Keep exactly what it verifies, keep its title, and leave every step that is not affected word-for-word as it is.',
    ...lines,
  ].join('\n');
}

// Runs worker(item, position) over items with a fixed number in flight. A worker
// that throws is the worker's problem — it must catch its own errors.
async function runPool(items, limit, worker) {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const position = next++;
      await worker(items[position], position);
    }
  });
  await Promise.all(lanes);
}

module.exports = {
  FIXABLE_KINDS,
  labelFor,
  shortTitle,
  fingerprint,
  fixOutlineMechanically,
  flagDuplicates,
  buildFixNote,
  runPool,
};
