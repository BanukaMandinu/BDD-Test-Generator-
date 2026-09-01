const crypto = require('crypto');
const express = require('express');
const { loadRun, saveRun, listRuns } = require('../lib/store');
const {
  reviseScenario,
  generateScenarioFromTitle,
  generateScenariosFromRecordings,
  reviseAllScenarios,
  fillCoverageGaps,
  normalizeDataTable,
} = require('../lib/claudeCli');
const { sanitizeRecordings } = require('../lib/recorder');
const { resolveTypes } = require('../lib/testTypes');
const { normalizeExamples, placeholdersInStep } = require('../lib/placeholders');
const {
  isRevisable,
  formatStepsForPrompt,
  formatScenarioForPrompt,
  reconcileSteps,
  newScenarioFromModel,
  formatExamplesForPrompt,
  applyOutlineFromModel,
} = require('../lib/revise');
const audit = require('../lib/audit');
const quality = require('../lib/quality');
const versions = require('../lib/versions');

const router = express.Router();
const MAX_REVIEW_LENGTH = 2000;

function getRunOr404(req, res) {
  const run = loadRun(req.params.id);
  if (!run) {
    res.status(404).json({ error: 'run not found' });
    return null;
  }
  return run;
}

router.get('/runs', (req, res) => {
  res.json(listRuns());
});

router.get('/runs/:id', (req, res) => {
  const run = getRunOr404(req, res);
  if (run) res.json(run);
});

// Full-run save: used for edits, step removal, ticks/unticks, review text, and
// coverage checkbox changes. The client always sends back the whole run object
// it was given, so this only ever overwrites what the UI actually rendered.
router.put('/runs/:id', (req, res, next) => {
  try {
    const existing = getRunOr404(req, res);
    if (!existing) return;

    const incoming = req.body;
    if (!incoming || typeof incoming !== 'object') {
      return res.status(400).json({ error: 'invalid run payload' });
    }

    const updated = {
      ...existing,
      featureTitle: String(incoming.featureTitle ?? existing.featureTitle),
      featureDescription: String(incoming.featureDescription ?? existing.featureDescription),
      requirements: Array.isArray(incoming.requirements) ? incoming.requirements : existing.requirements,
      scenarios: Array.isArray(incoming.scenarios) ? incoming.scenarios : existing.scenarios,
      id: existing.id,
      createdAt: existing.createdAt,
      input: existing.input,
    };

    versions.snapshot(existing, 'manual edit');

    // Ticks and edits change what the checks see, so re-run them on every save.
    updated.quality = quality.inspect(updated);
    saveRun(updated);
    audit.record('save', { runId: updated.id });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

router.post('/runs/:id/scenarios/:scenarioId/update', async (req, res, next) => {
  try {
    const run = getRunOr404(req, res);
    if (!run) return;

    const review = typeof req.body?.review === 'string' ? req.body.review.trim() : '';
    if (!review) {
      return res.status(400).json({ error: 'review is required' });
    }
    if (review.length > MAX_REVIEW_LENGTH) {
      return res.status(400).json({ error: `review must be under ${MAX_REVIEW_LENGTH} characters` });
    }

    const scenario = run.scenarios.find((s) => s.id === req.params.scenarioId);
    if (!scenario) {
      return res.status(404).json({ error: 'scenario not found' });
    }

    if (!scenario.steps.some(isRevisable)) {
      return res.status(400).json({
        error: 'Every step in this test case is unticked, so there is nothing for the review to change. Tick the steps you want reworked.',
      });
    }

    versions.snapshot(run, `review: ${scenario.title}`);

    const revised = await reviseScenario({
      scenario,
      requirements: run.requirements,
      review,
      formattedSteps: formatStepsForPrompt(scenario.steps),
      formattedExamples: formatExamplesForPrompt(scenario),
    });

    scenario.title = revised.title || scenario.title;
    scenario.steps = reconcileSteps(scenario.steps, revised.steps);
    applyOutlineFromModel(scenario, revised);
    scenario.review = '';
    scenario.lastReviewApplied = review;

    run.quality = quality.inspect(run);
    saveRun(run);
    audit.record('update-scenario', { runId: run.id, detail: scenario.id });
    res.json(scenario);
  } catch (err) {
    next(err);
  }
});

// Writes the steps for a manually-added scenario that so far only has a
// title. Grounded in the real page (read-only browsing) when the run has a
// source URL to revisit; a plain text-only pass otherwise.
router.post('/runs/:id/scenarios/:scenarioId/generate', async (req, res, next) => {
  try {
    const run = getRunOr404(req, res);
    if (!run) return;

    const scenario = run.scenarios.find((s) => s.id === req.params.scenarioId);
    if (!scenario) {
      return res.status(404).json({ error: 'scenario not found' });
    }

    const title = typeof req.body?.title === 'string' ? req.body.title.trim().slice(0, 300) : '';
    if (!title) {
      return res.status(400).json({ error: 'Give this scenario a title first.' });
    }

    versions.snapshot(run, `generate: ${title}`);

    const types = resolveTypes(run.selectedTypes);
    const validTypeIds = new Set(types.map((t) => t.id));

    const generated = await generateScenarioFromTitle({
      title,
      featureTitle: run.featureTitle,
      featureDescription: run.featureDescription,
      requirements: run.requirements,
      url: run.sourceUrl || null,
      types,
    });

    scenario.title = generated.title || title;
    scenario.testType = validTypeIds.has(generated.testType) ? generated.testType : null;
    scenario.steps = (generated.steps || []).map((st) => ({
      id: crypto.randomUUID(),
      keyword: st.keyword || 'And',
      text: st.text,
      included: true,
      dataTable: normalizeDataTable(st.dataTable),
    }));
    applyOutlineFromModel(scenario, generated);
    scenario.isDraft = false;

    run.quality = quality.inspect(run);
    saveRun(run);
    audit.record('generate-scenario', { runId: run.id, detail: scenario.id });
    res.json(scenario);
  } catch (err) {
    next(err);
  }
});

// Adds scenarios to an existing run from one or more newly recorded flows —
// either as fresh appended test cases ("Record a flow" from the results view,
// after the run already exists) or, when scenarioId names a still-draft
// scenario, using the FIRST recording to fill that specific one in ("Record a
// flow instead" on a manually-added scenario's own Generate footer). Any
// recordings beyond the first still land as new appended scenarios either way
// — recording more than one test never silently drops the extras.
router.post('/runs/:id/scenarios/from-recordings', async (req, res) => {
  const run = getRunOr404(req, res);
  if (!run) return;

  const recordings = sanitizeRecordings(req.body?.recordings);
  if (!recordings.length) {
    return res.status(400).json({ error: 'No recorded tests to generate from.' });
  }

  let targetScenario = null;
  if (typeof req.body?.scenarioId === 'string') {
    targetScenario = run.scenarios.find((s) => s.id === req.body.scenarioId && s.isDraft);
    if (!targetScenario) {
      return res.status(404).json({ error: 'That draft scenario was not found — it may have already been filled in or removed.' });
    }
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);

  try {
    const types = resolveTypes(run.selectedTypes);
    const validTypeIds = new Set(types.map((t) => t.id));
    const live = run.scenarios.filter((s) => s.included !== false && !s.isDraft);

    const result = await generateScenariosFromRecordings({
      recordings,
      featureTitle: run.featureTitle,
      featureDescription: run.featureDescription,
      existingTitles: live.map((s) => s.title),
      types,
      targetTitle: targetScenario ? targetScenario.title : null,
      onProgress: (message) => send('progress', { message }),
    });

    const added = (result.scenarios || [])
      .filter((s) => s.steps?.length)
      .map((s) => {
        const examples = normalizeExamples(s.examples);
        const steps = (s.steps || []).map((st) => ({
          id: crypto.randomUUID(),
          keyword: st.keyword || 'And',
          text: st.text,
          included: true,
          dataTable: normalizeDataTable(st.dataTable),
        }));
        const hasPlaceholders = steps.some((st) => placeholdersInStep(st).length > 0);
        const outline = Boolean(s.isOutline || hasPlaceholders) && Boolean(examples);

        return {
          title: s.title,
          testType: validTypeIds.has(s.testType) ? s.testType : null,
          isOutline: outline,
          examples: outline ? examples : null,
          steps,
        };
      });

    if (!added.length) throw new Error('No usable test cases came back. Try again.');

    versions.snapshot(run, `record: ${recordings.length} test${recordings.length === 1 ? '' : 's'}`);

    let filledDraft = false;
    if (targetScenario) {
      const [first, ...rest] = added;
      targetScenario.title = first.title || targetScenario.title;
      targetScenario.testType = first.testType;
      targetScenario.isOutline = first.isOutline;
      targetScenario.examples = first.examples;
      targetScenario.steps = first.steps;
      targetScenario.isDraft = false;
      filledDraft = true;
      for (const s of rest) {
        run.scenarios.push({ id: crypto.randomUUID(), included: true, review: '', coversRequirementIds: [], ...s });
      }
    } else {
      for (const s of added) {
        run.scenarios.push({ id: crypto.randomUUID(), included: true, review: '', coversRequirementIds: [], ...s });
      }
    }

    if (!run.sourceUrl && recordings[0]?.startUrl) run.sourceUrl = recordings[0].startUrl;

    run.quality = quality.inspect(run);
    saveRun(run);
    audit.record('generate-from-recordings', {
      runId: run.id,
      detail: `${added.length} added from ${recordings.length} recording${recordings.length === 1 ? '' : 's'}${filledDraft ? ' (1 filled a draft)' : ''}`,
    });

    send('progress', { message: `Added ${added.length} test case${added.length === 1 ? '' : 's'}` });
    for (const s of added) send('progress', { message: `· ${s.title}` });
    send('done', run);
  } catch (err) {
    console.error('generate-from-recordings failed:', err.message);
    send('failed', { error: err.message });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

// Fills coverage gaps: writes test cases for requirements nothing currently
// covers, without touching anything that already exists.
router.post('/runs/:id/fill-gaps', async (req, res) => {
  const run = loadRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'run not found' });

  const live = run.scenarios.filter((s) => s.included !== false);
  const coveredIds = new Set(live.flatMap((s) => s.coversRequirementIds || []));
  const gaps = run.requirements
    .map((req_, index) => ({ ...req_, index }))
    .filter((r) => !coveredIds.has(r.id));

  if (!gaps.length) {
    return res.status(400).json({ error: 'Every requirement already has at least one test case.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);

  try {
    send('progress', { message: `Writing test cases for ${gaps.length} uncovered requirement${gaps.length === 1 ? '' : 's'}` });

    const types = resolveTypes(run.selectedTypes);
    const validTypeIds = new Set(types.map((t) => t.id));

    const result = await fillCoverageGaps({
      featureTitle: run.featureTitle,
      gaps: gaps.map((g) => ({ index: g.index, text: g.text })),
      existingTitles: live.map((s) => s.title),
      types,
      onProgress: (message) => send('progress', { message }),
    });

    const added = (result.scenarios || [])
      .filter((s) => s.steps?.length)
      .map((s) => {
        const examples = normalizeExamples(s.examples);
        const steps = (s.steps || []).map((st) => ({
          id: crypto.randomUUID(),
          keyword: st.keyword,
          text: st.text,
          included: true,
          dataTable: normalizeDataTable(st.dataTable),
        }));
        const hasPlaceholders = steps.some((st) => placeholdersInStep(st).length > 0);
        const outline = Boolean(s.isOutline || hasPlaceholders) && Boolean(examples);

        return {
          id: crypto.randomUUID(),
          title: s.title,
          testType: validTypeIds.has(s.testType) ? s.testType : null,
          included: true,
          review: '',
          addedToFillGap: true,
          isOutline: outline,
          examples: outline ? examples : null,
          coversRequirementIds: (s.coversRequirements || [])
            .map((i) => run.requirements[i]?.id)
            .filter(Boolean),
          steps,
        };
      });

    if (!added.length) throw new Error('No usable test cases came back. Try again.');

    versions.snapshot(run, 'fill coverage gaps');
    run.scenarios.push(...added);
    run.quality = quality.inspect(run);
    saveRun(run);
    audit.record('fill-gaps', { runId: run.id, detail: `${added.length} added for ${gaps.length} gaps` });

    send('progress', { message: `Added ${added.length} test case${added.length === 1 ? '' : 's'}` });
    for (const s of added) send('progress', { message: `· ${s.title}` });
    send('done', run);
  } catch (err) {
    console.error('fill-gaps failed:', err.message);
    send('failed', { error: err.message });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

// ---- History & diff ----
// Every mutation snapshots the prior state, so a reviewer can see exactly what a
// review pass changed rather than taking the rewrite on trust.
router.get('/runs/:id/versions', (req, res) => {
  const run = getRunOr404(req, res);
  if (run) res.json(versions.list(run.id));
});

router.get('/runs/:id/versions/:versionId/diff', (req, res, next) => {
  try {
    const run = getRunOr404(req, res);
    if (!run) return;

    const version = versions.load(run.id, req.params.versionId);
    if (!version) return res.status(404).json({ error: 'version not found' });

    res.json(versions.diff(version, run));
  } catch (err) {
    next(err);
  }
});

// Universal update: applies one review note across the whole feature in a single
// pass, so the wording stays consistent and no duplicate scenarios appear. Only
// ticked scenarios take part, and inside them only ticked steps may be rewritten.
// Streamed over SSE because it's a slower call than a single-scenario revision.
router.post('/runs/:id/update-all', async (req, res) => {
  const run = loadRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'run not found' });

  const review = typeof req.body?.review === 'string' ? req.body.review.trim() : '';
  if (!review) return res.status(400).json({ error: 'review is required' });
  if (review.length > MAX_REVIEW_LENGTH) {
    return res.status(400).json({ error: `review must be under ${MAX_REVIEW_LENGTH} characters` });
  }

  const targets = run.scenarios.filter((s) => s.included !== false);
  if (!targets.length) {
    return res.status(400).json({
      error: 'No test cases are ticked, so there is nothing to update. Tick the test cases you want this review applied to.',
    });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);

  try {
    const skipped = run.scenarios.length - targets.length;
    send('progress', {
      message: `Applying your review to ${targets.length} ticked test case${targets.length === 1 ? '' : 's'}${skipped ? ` (${skipped} unticked, left alone)` : ''}`,
    });

    // ref is the scenario's 1-based position in the batch we send; the model
    // echoes it back so we can map each revision to the right scenario.
    const refToScenario = new Map();
    const formattedScenarios = targets
      .map((scenario, i) => {
        refToScenario.set(i + 1, scenario);
        return formatScenarioForPrompt(scenario, i + 1);
      })
      .join('\n\n');

    versions.snapshot(run, 'review all');

    const revised = await reviseAllScenarios({
      featureTitle: run.featureTitle,
      featureDescription: run.featureDescription,
      requirements: run.requirements,
      formattedScenarios,
      review,
      onProgress: (message) => send('progress', { message }),
    });

    let updatedCount = 0;
    const added = [];

    for (const returned of revised.scenarios || []) {
      const ref = Number(returned.ref);
      const scenario = Number.isFinite(ref) ? refToScenario.get(ref) : null;

      if (scenario) {
        scenario.title = returned.title || scenario.title;
        scenario.steps = reconcileSteps(scenario.steps, returned.steps);
        applyOutlineFromModel(scenario, returned);
        scenario.review = '';
        scenario.lastReviewApplied = review;
        updatedCount++;
      } else if (returned.steps?.length) {
        added.push(newScenarioFromModel(returned));
      }
    }

    run.scenarios.push(...added);

    if (!updatedCount && !added.length) {
      throw new Error('The review came back with no usable changes. Try rewording it.');
    }

    run.quality = quality.inspect(run);
    saveRun(run);
    audit.record('update-all', {
      runId: run.id,
      detail: `${updatedCount} revised, ${added.length} added`,
    });

    send('progress', {
      message: `Revised ${updatedCount} test case${updatedCount === 1 ? '' : 's'}${added.length ? `, added ${added.length} new one${added.length === 1 ? '' : 's'}` : ''}`,
    });
    send('done', run);
  } catch (err) {
    console.error('update-all failed:', err.message);
    send('failed', { error: err.message });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

module.exports = router;
