// Deterministic quality checks. No model call — these run on every generation and
// every update, are instant and free, and catch the three things that actually go
// wrong: near-duplicate scenarios, requirements nothing tests, and steps that
// drifted out of plain English into UI mechanics or jargon.

const { labelForType } = require('./testTypes');
const { placeholdersInScenario, exampleHeaders, exampleRowCount } = require('./placeholders');
const { inspectCucumber } = require('./cucumberChecks');

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'to', 'of', 'in', 'on',
  'at', 'for', 'with', 'and', 'or', 'that', 'this', 'it', 'its', 'as', 'by', 'from',
  'their', 'they', 'then', 'when', 'given', 'but',
]);

function tokenize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP_WORDS.has(w));
}

function jaccard(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  let shared = 0;
  for (const item of setA) if (setB.has(item)) shared++;
  return shared / (setA.size + setB.size - shared);
}

// Two signals, because they fail differently. Near-identical STEPS mean the same
// test regardless of how the titles are worded — that's the strong signal. Overall
// overlap catches a rewording where both title and steps drifted a little.
function fingerprints(scenario) {
  const stepWords = [];
  for (const step of scenario.steps || []) {
    if (step.included === false) continue;
    stepWords.push(...tokenize(step.text));
  }
  return {
    steps: new Set(stepWords),
    all: new Set([...tokenize(scenario.title), ...stepWords]),
  };
}

const STEP_THRESHOLD = 0.9; // near-verbatim step sequence
const OVERALL_THRESHOLD = 0.8;

function findDuplicates(scenarios) {
  const live = scenarios.filter((s) => s.included !== false);
  const prints = live.map((s) => ({ scenario: s, ...fingerprints(s) }));
  const issues = [];

  for (let i = 0; i < prints.length; i++) {
    for (let j = i + 1; j < prints.length; j++) {
      const stepScore = jaccard(prints[i].steps, prints[j].steps);
      const overallScore = jaccard(prints[i].all, prints[j].all);

      const bySteps = stepScore >= STEP_THRESHOLD;
      const byOverall = overallScore >= OVERALL_THRESHOLD;
      if (!bySteps && !byOverall) continue;

      const detail = bySteps
        ? `their steps are ${Math.round(stepScore * 100)}% the same`
        : `${Math.round(overallScore * 100)}% overlap overall`;

      issues.push({
        kind: 'duplicate',
        severity: 'warning',
        scenarioIds: [prints[i].scenario.id, prints[j].scenario.id],
        message: `"${prints[i].scenario.title}" and "${prints[j].scenario.title}" look like the same test — ${detail}.`,
      });
    }
  }
  return issues;
}

function findUncoveredRequirements(run) {
  const live = run.scenarios.filter((s) => s.included !== false);
  const coveredIds = new Set(live.flatMap((s) => s.coversRequirementIds || []));
  return run.requirements
    .filter((req) => !coveredIds.has(req.id))
    .map((req) => ({
      kind: 'uncovered-requirement',
      severity: 'warning',
      requirementId: req.id,
      message: `No test case covers: "${req.text}"`,
    }));
}

function findMissingTypes(run) {
  if (!Array.isArray(run.selectedTypes) || !run.selectedTypes.length) return [];
  const present = new Set(
    run.scenarios.filter((s) => s.included !== false).map((s) => s.testType).filter(Boolean)
  );
  return run.selectedTypes
    .filter((id) => !present.has(id))
    .map((id) => ({
      kind: 'missing-type',
      severity: 'warning',
      typeId: id,
      message: `You asked for ${labelForType(id)} tests but no scenario is tagged as one.`,
    }));
}

// Wording that means a step has slipped from describing intent into describing
// mechanics, or into spec-speak a stakeholder would stumble over.
const MECHANICS_PATTERNS = [
  { re: /\b(click|clicks|clicking|tap|taps)\b/i, why: 'describes a UI action instead of intent' },
  { re: /#[a-z][\w-]*|\.[a-z][\w-]*\s*(selector|class)|css selector|xpath/i, why: 'contains a selector' },
  { re: /\b(button|checkbox|dropdown|textbox|radio button)\b.*\b(id|name|class)\b/i, why: 'refers to an element by its attributes' },
  { re: /\b(GET|POST|PUT|PATCH|DELETE)\s+\/|\bendpoint\b|\bpayload\b|\bHTTP\s*\d{3}\b/i, why: 'uses HTTP mechanics' },
  { re: /\bshall\b|\bthe system shall\b/i, why: 'uses spec-speak ("shall")' },
  { re: /https?:\/\/\S+/i, why: 'hardcodes a URL' },
  { re: /\b(assert|verify that the|validate that the)\b.*\b(returns|equals)\b/i, why: 'reads like assertion code' },
];

const MAX_STEP_WORDS = 22;

function lintSteps(scenarios) {
  const issues = [];
  for (const scenario of scenarios) {
    if (scenario.included === false) continue;
    for (const step of scenario.steps || []) {
      if (step.included === false) continue;

      for (const { re, why } of MECHANICS_PATTERNS) {
        if (re.test(step.text)) {
          issues.push({
            kind: 'language',
            severity: 'info',
            scenarioIds: [scenario.id],
            stepId: step.id,
            message: `"${step.text}" — ${why}.`,
          });
          break; // one flag per step is enough
        }
      }

      const wordCount = String(step.text || '').trim().split(/\s+/).length;
      if (wordCount > MAX_STEP_WORDS) {
        issues.push({
          kind: 'language',
          severity: 'info',
          scenarioIds: [scenario.id],
          stepId: step.id,
          message: `A step is ${wordCount} words long — split it so it holds one idea: "${step.text.slice(0, 60)}…"`,
        });
      }
    }
  }
  return issues;
}

// Scenario Outline correctness. Cucumber fails outright on a placeholder with no
// matching Examples column, so these are the highest-value checks here.
function checkOutlines(scenarios) {
  const issues = [];

  for (const scenario of scenarios) {
    if (scenario.included === false) continue;

    const used = placeholdersInScenario(scenario);
    const headers = exampleHeaders(scenario);
    const rowCount = exampleRowCount(scenario);
    const flagged = Boolean(scenario.isOutline);

    // A placeholder with no column is a hard Cucumber error.
    for (const name of used) {
      if (!headers.includes(name)) {
        issues.push({
          kind: 'outline',
          severity: 'error',
          scenarioIds: [scenario.id],
          message: `"${scenario.title}" uses <${name}> but the Examples table has no "${name}" column — Cucumber would fail on this.`,
        });
      }
    }

    // A column nothing uses is dead weight.
    for (const header of headers) {
      if (header && !used.includes(header)) {
        issues.push({
          kind: 'outline',
          severity: 'info',
          scenarioIds: [scenario.id],
          message: `"${scenario.title}" has an Examples column "${header}" that no step uses.`,
        });
      }
    }

    if (flagged && !used.length) {
      issues.push({
        kind: 'outline',
        severity: 'warning',
        scenarioIds: [scenario.id],
        message: `"${scenario.title}" is marked as a Scenario Outline but has no <placeholder> in any step.`,
      });
    }

    if (used.length && !flagged) {
      issues.push({
        kind: 'outline',
        severity: 'error',
        scenarioIds: [scenario.id],
        message: `"${scenario.title}" uses <placeholders> but isn't a Scenario Outline — placeholders only substitute inside an outline.`,
      });
    }

    if (flagged && used.length && rowCount === 0) {
      issues.push({
        kind: 'outline',
        severity: 'error',
        scenarioIds: [scenario.id],
        message: `"${scenario.title}" is a Scenario Outline with no Examples rows to run.`,
      });
    }

    if (flagged && rowCount === 1) {
      issues.push({
        kind: 'outline',
        severity: 'info',
        scenarioIds: [scenario.id],
        message: `"${scenario.title}" is an outline with only one Examples row — a plain Scenario is simpler unless you plan to add more.`,
      });
    }
  }

  return issues;
}

// Runs every check and returns a flat, ordered issue list plus a summary.
function inspect(run) {
  const cucumber = inspectCucumber(run.scenarios);
  const issues = [
    ...checkOutlines(run.scenarios),
    ...cucumber.issues,
    ...findDuplicates(run.scenarios),
    ...findUncoveredRequirements(run),
    ...findMissingTypes(run),
    ...lintSteps(run.scenarios),
  ];

  const counts = issues.reduce((acc, i) => {
    acc[i.kind] = (acc[i.kind] || 0) + 1;
    return acc;
  }, {});

  return { issues, counts, metrics: cucumber.metrics, checkedAt: new Date().toISOString() };
}

// One-line summary for the activity log.
function summarize({ counts }) {
  const parts = [];
  if (counts.duplicate) parts.push(`${counts.duplicate} possible duplicate${counts.duplicate === 1 ? '' : 's'}`);
  if (counts['uncovered-requirement']) parts.push(`${counts['uncovered-requirement']} uncovered requirement${counts['uncovered-requirement'] === 1 ? '' : 's'}`);
  if (counts['missing-type']) parts.push(`${counts['missing-type']} requested type${counts['missing-type'] === 1 ? '' : 's'} missing`);
  if (counts.cucumber) parts.push(`${counts.cucumber} Cucumber issue${counts.cucumber === 1 ? '' : 's'}`);
  if (counts.reuse) parts.push(`${counts.reuse} step-reuse note${counts.reuse === 1 ? '' : 's'}`);
  if (counts.outline) parts.push(`${counts.outline} outline issue${counts.outline === 1 ? '' : 's'}`);
  if (counts.language) parts.push(`${counts.language} wording note${counts.language === 1 ? '' : 's'}`);
  return parts.length ? `Quality check: ${parts.join(', ')}` : 'Quality check: nothing flagged';
}

module.exports = { inspect, summarize, findDuplicates, findUncoveredRequirements, lintSteps, checkOutlines };
