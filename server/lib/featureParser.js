// Parses a .feature file back into the app's run shape, so a colleague can send
// you one and you can review, revise and re-export it here.
//
// Deliberately deterministic — no model call. It understands the constructs this
// app emits (Feature, tags, Scenario, Scenario Outline + Examples, data tables)
// plus the common ones it doesn't emit (Background, Rule), which are flattened
// rather than dropped so no steps are silently lost.

const crypto = require('crypto');
const { TEST_TYPES } = require('./testTypes');

const STEP_KEYWORDS = ['Given', 'When', 'Then', 'And', 'But', '*'];

// @happy-path -> happy-path, so a file we exported round-trips its types.
const TAG_TO_TYPE = new Map(TEST_TYPES.map((t) => [t.tag.toLowerCase(), t.id]));

function splitTableRow(line) {
  const trimmed = line.trim();
  const body = trimmed.slice(1, trimmed.endsWith('|') ? -1 : undefined);

  const cells = [];
  let cell = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\\') {
      const next = body[i + 1];
      // Only these three are escape sequences in Gherkin tables.
      if (next === '|') { cell += '|'; i++; continue; }
      if (next === 'n') { cell += '\n'; i++; continue; }
      if (next === '\\') { cell += '\\'; i++; continue; }
      cell += ch;
      continue;
    }
    if (ch === '|') { cells.push(cell.trim()); cell = ''; continue; }
    cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

const isTableRow = (line) => line.trim().startsWith('|');
const isComment = (line) => line.trim().startsWith('#');

function matchKeyword(line, keywords) {
  const trimmed = line.trim();
  for (const kw of keywords) {
    // "Scenario:" / "Scenario Outline:" etc. — colon required.
    if (trimmed.toLowerCase().startsWith(`${kw.toLowerCase()}:`)) {
      return { keyword: kw, rest: trimmed.slice(kw.length + 1).trim() };
    }
  }
  return null;
}

function matchStep(line) {
  const trimmed = line.trim();
  for (const kw of STEP_KEYWORDS) {
    if (kw === '*' ? trimmed.startsWith('* ') : new RegExp(`^${kw}\\s`, 'i').test(trimmed)) {
      return {
        // Gherkin treats * as a generic bullet; And is the closest thing we model.
        keyword: kw === '*' ? 'And' : kw,
        text: trimmed.slice(kw.length).trim(),
      };
    }
  }
  return null;
}

function tagsToType(tags) {
  for (const tag of tags) {
    const id = TAG_TO_TYPE.get(tag.toLowerCase());
    if (id) return id;
  }
  return null;
}

function newStep(keyword, text) {
  return { id: crypto.randomUUID(), keyword, text, included: true, dataTable: null };
}

const SCENARIO_KEYWORDS = ['Scenario Outline', 'Scenario Template', 'Scenario', 'Example'];

function parseFeature(text) {
  const lines = String(text ?? '').split(/\r?\n/);

  const warnings = [];
  const scenarios = [];
  let featureTitle = '';
  const descriptionLines = [];

  let pendingTags = [];
  let background = null;      // steps to prepend to every scenario
  let current = null;         // scenario being built
  let lastStep = null;        // step a data table would attach to
  let inExamples = false;     // collecting an Examples table
  let seenFeature = false;
  let sawRule = false;

  const finishScenario = () => {
    if (current && current.steps.length) scenarios.push(current);
    current = null;
    lastStep = null;
    inExamples = false;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || isComment(line)) continue;

    // ---- Tags ----
    if (line.startsWith('@')) {
      pendingTags = line.split(/\s+/).filter((t) => t.startsWith('@'));
      continue;
    }

    // ---- Feature ----
    const feature = matchKeyword(line, ['Feature']);
    if (feature) {
      finishScenario();
      featureTitle = feature.rest;
      seenFeature = true;
      pendingTags = [];
      continue;
    }

    // ---- Rule: flattened, its scenarios are kept as ordinary ones ----
    const rule = matchKeyword(line, ['Rule']);
    if (rule) {
      finishScenario();
      if (!sawRule) {
        warnings.push('"Rule:" blocks were flattened — their scenarios were kept, the grouping was not.');
        sawRule = true;
      }
      pendingTags = [];
      continue;
    }

    // ---- Background: steps get prepended to each scenario ----
    const bg = matchKeyword(line, ['Background']);
    if (bg) {
      finishScenario();
      background = [];
      pendingTags = [];
      continue;
    }

    // ---- Scenario / Scenario Outline ----
    const scenario = matchKeyword(line, SCENARIO_KEYWORDS);
    if (scenario) {
      finishScenario();
      const outline = /outline|template/i.test(scenario.keyword);
      current = {
        id: crypto.randomUUID(),
        title: scenario.rest,
        testType: tagsToType(pendingTags),
        included: true,
        review: '',
        isOutline: outline,
        examples: null,
        coversRequirementIds: [],
        steps: background ? background.map((s) => newStep(s.keyword, s.text)) : [],
      };
      background = background || null;
      pendingTags = [];
      continue;
    }

    // ---- Examples ----
    const examples = matchKeyword(line, ['Examples', 'Scenarios']);
    if (examples) {
      if (current) {
        inExamples = true;
        current.examples = [];
        lastStep = null;
      }
      pendingTags = [];
      continue;
    }

    // ---- Table rows: belong to Examples, or to the last step ----
    if (isTableRow(line)) {
      const cells = splitTableRow(line);
      if (inExamples && current) {
        current.examples.push(cells);
      } else if (lastStep) {
        lastStep.dataTable = lastStep.dataTable || [];
        lastStep.dataTable.push(cells);
      }
      continue;
    }

    // ---- Steps ----
    const step = matchStep(line);
    if (step) {
      inExamples = false;
      if (background && !current) {
        background.push({ keyword: step.keyword, text: step.text });
        continue;
      }
      if (!current) {
        // Steps before any Scenario header — keep them in a catch-all rather
        // than discarding content the sender may care about.
        current = {
          id: crypto.randomUUID(),
          title: 'Imported steps',
          testType: null,
          included: true,
          review: '',
          isOutline: false,
          examples: null,
          coversRequirementIds: [],
          steps: [],
        };
        warnings.push('Some steps appeared before any "Scenario:" line — they were grouped into "Imported steps".');
      }
      lastStep = newStep(step.keyword, step.text);
      current.steps.push(lastStep);
      continue;
    }

    // ---- Anything else under Feature is description ----
    if (seenFeature && !current && !background) descriptionLines.push(line);
  }

  finishScenario();

  if (background && background.length) {
    warnings.push(`"Background:" isn't modelled here — its ${background.length} step${background.length === 1 ? '' : 's'} ${background.length === 1 ? 'was' : 'were'} copied into each scenario.`);
  }

  // Tidy up: an outline with no usable Examples is invalid, so demote it.
  for (const s of scenarios) {
    if (Array.isArray(s.examples) && s.examples.length < 2) {
      if (s.examples.length === 0) s.examples = null;
    }
    if (s.isOutline && (!s.examples || s.examples.length < 2)) {
      s.isOutline = false;
      s.examples = null;
      warnings.push(`"${s.title}" was a Scenario Outline with no Examples rows — imported as a plain Scenario.`);
    }
  }

  return {
    featureTitle: featureTitle || 'Imported feature',
    featureDescription: descriptionLines.join(' ').trim(),
    scenarios,
    warnings,
  };
}

module.exports = { parseFeature, splitTableRow };
