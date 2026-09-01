const crypto = require('crypto');
const { normalizeDataTable } = require('./claudeCli');
const { normalizeExamples, placeholdersInScenario } = require('./placeholders');

// A step's checkbox controls two things at once: whether it lands in the export,
// and whether a review is allowed to rewrite it. Ticked = live (revisable),
// unticked = frozen (reproduced verbatim, still kept in the document).
function isRevisable(step) {
  return step.included !== false;
}

function stepTableLines(step, indent) {
  if (!Array.isArray(step.dataTable) || !step.dataTable.length) return [];
  return step.dataTable.map((row) => `${indent}| ${row.join(' | ')} |`);
}

// Renders one scenario's steps for the prompt, tagging each so the model knows
// which it may touch.
function formatStepsForPrompt(steps) {
  const lines = [];
  steps.forEach((step, i) => {
    const tag = isRevisable(step) ? '[REVISE]' : '[KEEP]';
    lines.push(`${i + 1}. ${tag} ${step.keyword} ${step.text}`);
    lines.push(...stepTableLines(step, '     '));
  });
  return lines.join('\n');
}

// Renders an Examples table for the prompt, or '' when the scenario isn't an outline.
function formatExamplesForPrompt(scenario) {
  if (!Array.isArray(scenario.examples) || !scenario.examples.length) return '';
  return scenario.examples.map((row) => `| ${row.join(' | ')} |`).join('\n');
}

function formatScenarioForPrompt(scenario, ref) {
  const parts = [
    `--- Scenario ref ${ref} ---`,
    `Title: ${scenario.title}`,
  ];
  if (scenario.isOutline) parts.push('This is a Scenario Outline.');
  parts.push(formatStepsForPrompt(scenario.steps));

  const examples = formatExamplesForPrompt(scenario);
  if (examples) parts.push('Examples:', examples);

  return parts.join('\n');
}

// Applies a model reply's outline fields to a scenario, keeping the flag honest:
// an outline needs both placeholders in its steps and an Examples table.
function applyOutlineFromModel(scenario, returned) {
  const examples = normalizeExamples(returned.examples);
  const hasPlaceholders = placeholdersInScenario(scenario).length > 0;

  if ((returned.isOutline || hasPlaceholders) && examples) {
    scenario.isOutline = true;
    scenario.examples = examples;
  } else if (returned.isOutline === false && !hasPlaceholders) {
    scenario.isOutline = false;
    scenario.examples = null;
  } else if (hasPlaceholders && !examples) {
    // Placeholders survived but the model dropped the table — keep the old one
    // rather than emitting a scenario Cucumber can't run.
    scenario.isOutline = true;
  }
  return scenario;
}

function normalizeText(text) {
  return String(text ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// Rebuilds a scenario's step list from what the model returned, then enforces the
// contract it was given: every frozen ([KEEP]) step must survive. If the model
// dropped one, put it back at its original position rather than silently losing
// content the reviewer had excluded from the rewrite.
function reconcileSteps(originalSteps, returnedSteps) {
  // A model reply with no steps is a failed revision, not an instruction to
  // empty the scenario — keep what we had.
  const usable = (returnedSteps || []).filter((st) => st && String(st.text || '').trim());
  if (!usable.length) return originalSteps;

  const frozen = originalSteps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => !isRevisable(step));

  // Reuse ids/flags where the returned text matches an original step, so ticks
  // and identities survive a round-trip that only reworded its neighbours.
  const unclaimed = originalSteps.map((step) => ({ step, taken: false }));
  const matchOriginal = (text) => {
    const key = normalizeText(text);
    const hit = unclaimed.find((c) => !c.taken && normalizeText(c.step.text) === key);
    if (hit) hit.taken = true;
    return hit ? hit.step : null;
  };

  const rebuilt = usable.map((st) => {
    const original = matchOriginal(st.text);
    return {
      id: original?.id || crypto.randomUUID(),
      keyword: st.keyword || original?.keyword || 'And',
      text: st.text,
      included: original ? original.included !== false : true,
      dataTable: normalizeDataTable(st.dataTable) ?? (original?.dataTable ?? null),
    };
  });

  // Re-insert any frozen step the model failed to reproduce.
  for (const { step, index } of frozen) {
    const stillPresent = rebuilt.some((s) => s.id === step.id || normalizeText(s.text) === normalizeText(step.text));
    if (!stillPresent) {
      rebuilt.splice(Math.min(index, rebuilt.length), 0, { ...step });
    }
  }

  return rebuilt;
}

function newScenarioFromModel(returned) {
  const examples = normalizeExamples(returned.examples);
  return {
    id: crypto.randomUUID(),
    title: returned.title || 'New scenario',
    included: true,
    review: '',
    coversRequirementIds: [],
    addedByReview: true,
    isOutline: Boolean(returned.isOutline && examples),
    examples: returned.isOutline && examples ? examples : null,
    steps: (returned.steps || []).map((st) => ({
      id: crypto.randomUUID(),
      keyword: st.keyword || 'And',
      text: st.text,
      included: true,
      dataTable: normalizeDataTable(st.dataTable),
    })),
  };
}

module.exports = {
  isRevisable,
  formatExamplesForPrompt,
  applyOutlineFromModel,
  formatStepsForPrompt,
  formatScenarioForPrompt,
  reconcileSteps,
  newScenarioFromModel,
};
