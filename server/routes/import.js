const express = require('express');
const crypto = require('crypto');
const { parseFeature } = require('../lib/featureParser');
const excelImport = require('../lib/excelImport');
const { saveRun } = require('../lib/store');
const { resolveTypes, TEST_TYPES } = require('../lib/testTypes');
const { normalizeExamples, placeholdersInStep } = require('../lib/placeholders');
const { normalizeDataTable } = require('../lib/claudeCli');
const quality = require('../lib/quality');
const audit = require('../lib/audit');
const { originFromUrl } = require('../lib/session');

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

  const testId = typeof raw?.testId === 'string' && raw.testId.trim() ? raw.testId.trim().slice(0, 40) : null;

  // A spreadsheet row's own Description, kept so the export puts it back in that
  // row's Description column instead of a repeated feature-level text.
  const description = typeof raw?.description === 'string' && raw.description.trim() ? raw.description.trim().slice(0, 2000) : null;

  return {
    id: crypto.randomUUID(),
    ...(testId ? { testId } : {}),
    ...(description ? { description } : {}),
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

// Said out loud, because a silent cut means someone ships a suite they believe is
// complete: what the size limits dropped, and what was skipped for having no steps.
function capWarnings(rawScenarios, keptCount) {
  const list = Array.isArray(rawScenarios) ? rawScenarios : [];
  const considered = list.slice(0, MAX_SCENARIOS);
  const warnings = [];
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  if (list.length > MAX_SCENARIOS) {
    warnings.push(`The file has ${list.length} test cases; only the first ${MAX_SCENARIOS} were imported.`);
  }
  const noSteps = considered.length - keptCount;
  if (noSteps > 0) {
    warnings.push(`${plural(noSteps, 'test case')} had no usable steps and ${noSteps === 1 ? 'was' : 'were'} skipped.`);
  }
  const tooManySteps = considered.filter((s) => Array.isArray(s?.steps) && s.steps.length > MAX_STEPS_PER_SCENARIO).length;
  if (tooManySteps) {
    warnings.push(`${plural(tooManySteps, 'test case')} had more than ${MAX_STEPS_PER_SCENARIO} steps; the steps after that were dropped.`);
  }
  const tooManyRows = considered.filter((s) => Array.isArray(s?.examples) && s.examples.length > MAX_TABLE_ROWS).length;
  if (tooManyRows) {
    warnings.push(`${plural(tooManyRows, 'Examples table')} had more than ${MAX_TABLE_ROWS} rows; the rows after that were dropped.`);
  }
  return warnings;
}

// A shared file may carry the run's website link. Only a plain http(s) link is kept.
function cleanSourceUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw || !originFromUrl(raw)) return null;
  return (/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).slice(0, 2000);
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
    sourceUrl: cleanSourceUrl(parsed.sourceUrl),
    requirements,
    scenarios,
    selectedTypes: types.map((t) => t.id),
    warnings: capWarnings(parsed.scenarios, scenarios.length),
  };
}

// Shared by .feature and spreadsheet imports: both arrive as parsed scenarios
// with no requirements list.
function buildFromParsed(parsed, notice) {
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
    warnings: [...parsed.warnings, ...capWarnings(parsed.scenarios, scenarios.length), notice],
  };
}

function buildFromFeature(text) {
  return buildFromParsed(
    parseFeature(text),
    'A .feature file carries no requirements list, so the Coverage tab starts empty. Send the JSON share file instead to keep coverage.'
  );
}

function buildFromSheet(parsed) {
  return buildFromParsed(
    parsed,
    'A spreadsheet carries no requirements list, so the Coverage tab starts empty.'
  );
}

const isXlsx = (filename) => /\.xlsx$/i.test(filename || '');

function looksLikeJson(content, filename) {
  if (/\.json$/i.test(filename || '')) return true;
  return content.trim().startsWith('{');
}

// Step 1 of a spreadsheet import: which sheets does the workbook have? A
// workbook usually holds one sheet per feature, so the user picks one.
router.post('/import/sheets', async (req, res) => {
  const content = typeof req.body?.content === 'string' ? req.body.content : '';
  const filename = String(req.body?.filename ?? '').slice(0, 260);
  if (!isXlsx(filename)) {
    return res.status(400).json({ error: 'Only .xlsx workbooks have sheets to choose from.' });
  }
  try {
    res.json({ sheets: await excelImport.listSheets(content) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/import', async (req, res, next) => {
  try {
    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    const filename = String(req.body?.filename ?? '').slice(0, 260);
    const xlsx = isXlsx(filename);

    if (!content.trim()) {
      return res.status(400).json({ error: 'The file was empty.' });
    }
    // A workbook arrives base64-encoded; excelImport enforces its limit on the
    // decoded bytes.
    if (!xlsx && Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
      return res.status(400).json({ error: 'That file is too large to import (limit 2 MB).' });
    }

    let built;
    if (xlsx) {
      const sheetName = String(req.body?.sheet ?? '').slice(0, 200);
      if (!sheetName) return res.status(400).json({ error: 'Choose which sheet to import.' });
      try {
        built = buildFromSheet(await excelImport.parseSheet(content, sheetName));
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
    } else if (looksLikeJson(content, filename)) {
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
        error: 'No test cases were found in that file. Expected a .feature file, a JSON share file exported from this app, or an Excel sheet with Summary and Test Steps columns.',
      });
    }

    const run = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      input: xlsx
        ? `Imported from ${filename}, sheet "${built.featureTitle}"`
        : `Imported from ${filename || 'a shared file'}`,
      sourceUrl: built.sourceUrl || null,
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
