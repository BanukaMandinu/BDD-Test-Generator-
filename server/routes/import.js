const express = require('express');
const crypto = require('crypto');
const { parseFeature } = require('../lib/featureParser');
const { saveRun } = require('../lib/store');
const { resolveTypes, TEST_TYPES } = require('../lib/testTypes');
const { normalizeExamples, placeholdersInStep } = require('../lib/placeholders');
const { normalizeDataTable } = require('../lib/claudeCli');
const quality = require('../lib/quality');
const audit = require('../lib/audit');

const router = express.Router();

// Generous, but bounded — an import is untrusted input from someone else.
const MAX_CONTENT_BYTES = 2 * 1024 * 1024;
const MAX_SCENARIOS = 500;
const MAX_STEPS_PER_SCENARIO = 200;
const MAX_TABLE_ROWS = 500;

const KEYWORDS = new Set(['Given', 'When', 'Then', 'And', 'But']);

function clampTable(table) {
  const normalized = normalizeDataTable(table);
  if (!normalized) return null;
  return normalized.slice(0, MAX_TABLE_ROWS);
}

// Rebuilds a step from untrusted input, assigning fresh ids and dropping
// anything unrecognised rather than trusting the shape wholesale.
function sanitizeStep(raw) {
  const text = String(raw?.text ?? '').slice(0, 2000);
  if (!text.trim()) return null;
  const keyword = KEYWORDS.has(raw?.keyword) ? raw.keyword : 'And';
  return {
    id: crypto.randomUUID(),
    keyword,
    text,
    included: raw?.included !== false,
    dataTable: clampTable(raw?.dataTable),
  };
}

function sanitizeScenario(raw, requirementIdByIndex, validTypeIds) {
  const steps = (Array.isArray(raw?.steps) ? raw.steps : [])
    .slice(0, MAX_STEPS_PER_SCENARIO)
    .map(sanitizeStep)
    .filter(Boolean);

  if (!steps.length) return null;

  const examples = normalizeExamples(raw?.examples);
  const hasPlaceholders = steps.some((st) => placeholdersInStep(st).length > 0);
  const outline = Boolean(raw?.isOutline || hasPlaceholders) && Boolean(examples) && examples.length > 1;

  // Coverage may arrive as ids (our JSON) or indices (hand-written) — accept both.
  const covers = Array.isArray(raw?.coversRequirementIds) ? raw.coversRequirementIds : [];
  const coversRequirementIds = covers
    .map((v) => (typeof v === 'number' ? requirementIdByIndex[v] : requirementIdByIndex.byOldId?.[v]))
    .filter(Boolean);

  return {
    id: crypto.randomUUID(),
    title: String(raw?.title ?? 'Untitled scenario').slice(0, 500),
    testType: validTypeIds.has(raw?.testType) ? raw.testType : null,
    included: raw?.included !== false,
    review: '',
    isOutline: outline,
    examples: outline ? examples.slice(0, MAX_TABLE_ROWS) : null,
    coversRequirementIds,
    steps,
  };
}

function buildFromJson(parsed) {
  const rawReqs = Array.isArray(parsed.requirements) ? parsed.requirements.slice(0, MAX_SCENARIOS) : [];

  // Remap requirement ids so an imported run can't collide with a local one,
  // while keeping each scenario's coverage pointing at the right requirement.
  const byOldId = {};
  const requirements = rawReqs
    .map((r) => {
      const text = String(r?.text ?? r ?? '').slice(0, 2000);
      if (!text.trim()) return null;
      const id = crypto.randomUUID();
      if (r?.id) byOldId[r.id] = id;
      return { id, text, covered: r?.covered === true };
    })
    .filter(Boolean);

  const requirementIdByIndex = requirements.map((r) => r.id);
  requirementIdByIndex.byOldId = byOldId;

  const selectedTypes = Array.isArray(parsed.selectedTypes) ? parsed.selectedTypes : [];
  const types = resolveTypes(selectedTypes);
  const validTypeIds = new Set(types.map((t) => t.id));

  const scenarios = (Array.isArray(parsed.scenarios) ? parsed.scenarios : [])
    .slice(0, MAX_SCENARIOS)
    .map((s) => sanitizeScenario(s, requirementIdByIndex, validTypeIds))
    .filter(Boolean);

  return {
    featureTitle: String(parsed.featureTitle ?? 'Imported feature').slice(0, 500),
    featureDescription: String(parsed.featureDescription ?? '').slice(0, 2000),
    requirements,
    scenarios,
    selectedTypes: types.map((t) => t.id),
    warnings: [],
  };
}

function buildFromFeature(text) {
  const parsed = parseFeature(text);
  // Keep whatever @tags mapped to a known type, without forcing the defaults.
  const validTypeIds = new Set(TEST_TYPES.map((t) => t.id));

  const requirementIdByIndex = [];
  requirementIdByIndex.byOldId = {};

  const scenarios = parsed.scenarios
    .slice(0, MAX_SCENARIOS)
    .map((s) => sanitizeScenario(s, requirementIdByIndex, validTypeIds))
    .filter(Boolean);

  const typesPresent = [...new Set(scenarios.map((s) => s.testType).filter(Boolean))];

  return {
    featureTitle: parsed.featureTitle,
    featureDescription: parsed.featureDescription,
    requirements: [],
    scenarios,
    // Only claim the types the file actually carries; otherwise the coverage
    // check would report every default type as "missing".
    selectedTypes: typesPresent,
    warnings: [
      ...parsed.warnings,
      'A .feature file carries no requirements list, so the Coverage tab starts empty. Send the JSON share file instead to keep coverage.',
    ],
  };
}

function looksLikeJson(content, filename) {
  if (/\.json$/i.test(filename || '')) return true;
  return content.trim().startsWith('{');
}

router.post('/import', (req, res, next) => {
  try {
    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    const filename = String(req.body?.filename ?? '').slice(0, 260);

    if (!content.trim()) {
      return res.status(400).json({ error: 'The file was empty.' });
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
      return res.status(400).json({ error: 'That file is too large to import (limit 2 MB).' });
    }

    let built;
    if (looksLikeJson(content, filename)) {
      let parsed;
      try {
        parsed = JSON.parse(content);
      } catch (e) {
        return res.status(400).json({ error: `That JSON file could not be read: ${e.message}` });
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return res.status(400).json({ error: 'That JSON file is not a shared test run.' });
      }
      built = buildFromJson(parsed);
    } else {
      built = buildFromFeature(content);
    }

    if (!built.scenarios.length) {
      return res.status(400).json({
        error: 'No test cases were found in that file. Expected a .feature file or a JSON share file exported from this app.',
      });
    }

    const run = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      input: `Imported from ${filename || 'a shared file'}`,
      sourceUrl: null,
      importedFrom: filename || null,
      importedAt: new Date().toISOString(),
      exploredInteractively: false,
      usedSavedSession: false,
      selectedTypes: built.selectedTypes,
      refined: false,
      refineFixes: [],
      featureTitle: built.featureTitle,
      featureDescription: built.featureDescription,
      requirements: built.requirements,
      scenarios: built.scenarios,
    };

    run.quality = quality.inspect(run);
    saveRun(run);
    audit.record('import', {
      runId: run.id,
      detail: `${run.scenarios.length} scenarios from ${filename || 'shared file'}`,
    });

    res.status(201).json({ run, warnings: built.warnings });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
