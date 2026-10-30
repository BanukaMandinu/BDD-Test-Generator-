const crypto = require('crypto');
const express = require('express');
const { loadRun, saveRun, listRuns } = require('../lib/store');
const {
  reviseScenario,
  describeScenario,
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
  applyDescriptionFromModel,
  cleanDescription,
} = require('../lib/revise');
const audit = require('../lib/audit');
const { originFromUrl } = require('../lib/session');
const quality = require('../lib/quality');
const versions = require('../lib/versions');
const autofix = require('../lib/autofix');

const router = express.Router();
const MAX_REVIEW_LENGTH = 2000;
// How many test cases are rewritten at once by the Fix button. Each one is its own
// model call, so this trades speed against how many the machine runs in parallel.
const FIX_CONCURRENCY = 3;

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

    // The link is what lets "Update all" check the suite against the real site,
    // so it is editable (an imported sheet arrives without one). Only a plain
    // http(s) link is kept; an empty value clears it.
    if ('sourceUrl' in incoming) {
      const raw = String(incoming.sourceUrl ?? '').trim();
      if (!raw) {
        updated.sourceUrl = null;
      } else {
        if (!originFromUrl(raw)) {
          return res.status(400).json({ error: 'That website link is not valid. Use a full address such as https://my-app.com.' });
        }
        updated.sourceUrl = (/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).slice(0, 2000);
      }
    }

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
    applyDescriptionFromModel(scenario, revised);
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
    // A description the reviewer already typed is theirs; the model only fills a blank.
    if (!scenario.description) applyDescriptionFromModel(scenario, generated);
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

    // The description is optional in the model's reply and easy to skip. A new test
    // case should always get one, so ask for it on its own if it did not come back.
    if (!scenario.description) {
      try {
        applyDescriptionFromModel(scenario, await describeScenario({
          scenario,
          featureTitle: run.featureTitle,
          featureDescription: run.featureDescription,
          requirements: run.requirements,
          formattedSteps: formatStepsForPrompt(scenario.steps),
        }));
      } catch (err) {
        console.error('describe after generate failed:', err.message); // the test case itself is fine without it
      }
    }

    run.quality = quality.inspect(run);
    saveRun(run);
    audit.record('generate-scenario', { runId: run.id, detail: scenario.id });
    res.json(scenario);
  } catch (err) {
    next(err);
  }
});

// Writes (or rewrites) one test case's Description from its title and steps.
router.post('/runs/:id/scenarios/:scenarioId/describe', async (req, res, next) => {
  try {
    const run = getRunOr404(req, res);
    if (!run) return;

    const scenario = run.scenarios.find((s) => s.id === req.params.scenarioId);
    if (!scenario) return res.status(404).json({ error: 'scenario not found' });

    if (!scenario.steps.some((st) => st.included !== false && String(st.text || '').trim())) {
      return res.status(400).json({ error: 'Add some steps first — the description is worked out from them.' });
    }

    versions.snapshot(run, `describe: ${scenario.title}`);

    const result = await describeScenario({
      scenario,
      featureTitle: run.featureTitle,
      featureDescription: run.featureDescription,
      requirements: run.requirements,
      formattedSteps: formatStepsForPrompt(scenario.steps),
    });

    const description = cleanDescription(result?.description);
    if (!description) {
      return res.status(502).json({ error: 'No description came back. Try again.' });
    }
    scenario.description = description;

    saveRun(run);
    audit.record('describe-scenario', { runId: run.id, detail: scenario.id });
    res.json({ description });
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

        const description = cleanDescription(s.description);

        return {
          ...(description ? { description } : {}),
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
      if (first.description) targetScenario.description = first.description;
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

        const description = cleanDescription(s.description);

        return {
          id: crypto.randomUUID(),
          ...(description ? { description } : {}),
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
    const checkWebsite = req.body?.checkWebsite === true && Boolean(run.sourceUrl);
    const refToScenario = new Map();
    const formattedScenarios = targets
      .map((scenario, i) => {
        refToScenario.set(i + 1, scenario);
        return formatScenarioForPrompt(scenario, i + 1);
      })
      .join('\n\n');

    versions.snapshot(run, 'review all');
    const before = new Map(targets.map((s) => [s.id, autofix.fingerprint(s)]));

    const revised = await reviseAllScenarios({
      featureTitle: run.featureTitle,
      featureDescription: run.featureDescription,
      requirements: run.requirements,
      formattedScenarios,
      review,
      url: checkWebsite ? run.sourceUrl : null,
      useSession: checkWebsite && req.body?.useSession === true,
      onProgress: (message) => send('progress', { message }),
    });

    if (revised.note) send('progress', { message: String(revised.note).slice(0, 300) });

    let updatedCount = 0;
    let flaggedCount = 0;
    const added = [];
    const outcomes = new Map(); // scenario id -> { changed, flagged }

    for (const returned of revised.scenarios || []) {
      const ref = Number(returned.ref);
      const scenario = Number.isFinite(ref) ? refToScenario.get(ref) : null;

      if (scenario) {
        scenario.title = returned.title || scenario.title;
        applyDescriptionFromModel(scenario, returned);
        scenario.steps = reconcileSteps(scenario.steps, returned.steps);
        applyOutlineFromModel(scenario, returned);
        scenario.review = '';
        scenario.lastReviewApplied = review;
        // Removal is only ever a proposal, and only when a live site was checked:
        // the case is unticked (so it drops out of export and further reviews) but
        // stays on screen with the reason, and History can restore it.
        const flagged = checkWebsite && returned.remove === true;
        if (flagged) {
          scenario.included = false;
          scenario.lastReviewApplied = `Suggested removal — ${String(returned.removeReason || 'not found on the website').slice(0, 300)}`;
          flaggedCount++;
        }
        outcomes.set(scenario.id, { changed: autofix.fingerprint(scenario) !== before.get(scenario.id), flagged });
        updatedCount++;
      } else if (returned.steps?.length) {
        added.push(newScenarioFromModel(returned));
      }
    }

    // One line per test case, so the activity log shows what happened to each.
    targets.forEach((scenario) => {
      const at = run.scenarios.indexOf(scenario);
      const name = `${autofix.labelFor(scenario, at)} ${autofix.shortTitle(scenario.title)}`;
      const outcome = outcomes.get(scenario.id);
      if (!outcome) send('progress', { message: `${name} — not returned by the review, left as it was` });
      else if (outcome.flagged) send('progress', { message: `${name} — unticked: ${autofix.shortTitle(scenario.lastReviewApplied.replace(/^Suggested removal — /, ''), 160)}` });
      else if (outcome.changed) send('progress', { message: `${name} — updated`, kind: 'done' });
      else send('progress', { message: `${name} — already fine, unchanged` });
    });
    added.forEach((scenario) => send('progress', { message: `New: ${autofix.shortTitle(scenario.title)} — added`, kind: 'done' }));

    run.scenarios.push(...added);

    if (!updatedCount && !added.length) {
      throw new Error('The review came back with no usable changes. Try rewording it.');
    }

    run.quality = quality.inspect(run);
    saveRun(run);
    audit.record('update-all', {
      runId: run.id,
      detail: `${updatedCount} revised, ${added.length} added${flaggedCount ? `, ${flaggedCount} flagged for removal` : ''}${checkWebsite ? ' (checked against website)' : ''}`,
    });

    const changedCount = [...outcomes.values()].filter((o) => o.changed && !o.flagged).length;
    send('progress', {
      message: `Revised ${changedCount} of ${updatedCount} test case${updatedCount === 1 ? '' : 's'}${added.length ? `, added ${added.length} new one${added.length === 1 ? '' : 's'}` : ''}${flaggedCount ? `, unticked ${flaggedCount} that the website doesn't seem to have` : ''}`,
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

// Fixes the problems the quality check reported. Optional body fields narrow it to
// one issue (kind + scenarioIds + message, as the per-issue Fix button sends) or
// one kind; with none it fixes everything fixable. The issue list is recomputed
// here from the saved run, never taken from the client.
router.post('/runs/:id/fix-issues', async (req, res) => {
  const run = loadRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'run not found' });

  const kind = typeof req.body?.kind === 'string' ? req.body.kind : null;
  if (kind && !autofix.FIXABLE_KINDS.includes(kind)) {
    return res.status(400).json({ error: 'Those issues cannot be fixed automatically.' });
  }
  const onlyIds = Array.isArray(req.body?.scenarioIds) ? new Set(req.body.scenarioIds.map(String)) : null;
  const onlyMessage = typeof req.body?.message === 'string' ? req.body.message : null;

  const wanted = (issue) =>
    autofix.FIXABLE_KINDS.includes(issue.kind)
    && (!kind || issue.kind === kind)
    && (!onlyMessage || issue.message === onlyMessage)
    && (issue.scenarioIds || []).length > 0
    && (!onlyIds || issue.scenarioIds.some((id) => onlyIds.has(id)));

  const wantedIssues = quality.inspect(run).issues.filter(wanted);
  if (!wantedIssues.length) {
    return res.status(400).json({ error: 'There is nothing to fix here — the quality check has changed since it was shown. Reload the run and try again.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);

  const name = (scenario) => `${autofix.labelFor(scenario, run.scenarios.indexOf(scenario))} ${autofix.shortTitle(scenario.title)}`;
  const inScope = (issue) => (issue.scenarioIds || []).filter((id) => !onlyIds || onlyIds.has(id));

  try {
    const affected = new Set(wantedIssues.flatMap(inScope));
    send('progress', {
      message: `Fixing ${wantedIssues.length} issue${wantedIssues.length === 1 ? '' : 's'} across ${affected.size} test case${affected.size === 1 ? '' : 's'}`,
    });

    versions.snapshot(run, 'fix quality issues');
    const tally = { mechanical: 0, flagged: 0, rewritten: 0, unchanged: 0, failed: 0, skipped: 0 };

    // 1. Mechanical outline repairs: one right answer, so no model call.
    const outlineIds = new Set(wantedIssues.filter((i) => i.kind === 'outline').flatMap(inScope));
    for (const scenario of run.scenarios) {
      if (scenario.included === false || !outlineIds.has(scenario.id)) continue;
      const notes = autofix.fixOutlineMechanically(scenario);
      if (!notes.length) continue;
      tally.mechanical++;
      send('progress', { message: `${name(scenario)} — ${notes.join('; ')}`, kind: 'done' });
    }

    // 2. Duplicates: untick the later one, with the reason on its card.
    const dupes = autofix.flagDuplicates(run.scenarios, wantedIssues.filter((i) => i.kind === 'duplicate'));
    for (const d of dupes) {
      tally.flagged++;
      send('progress', { message: `${name(d.scenario)} — unticked: same test as ${name(d.of.scenario)}` });
    }

    // 3. Everything that needs judgment: one model call per test case, a few at a time.
    const remaining = quality.inspect(run).issues.filter((i) => i.kind !== 'duplicate' && wanted(i));
    const issuesByScenario = new Map();
    for (const issue of remaining) {
      for (const id of inScope(issue)) {
        if (!issuesByScenario.has(id)) issuesByScenario.set(id, []);
        issuesByScenario.get(id).push(issue);
      }
    }

    const queue = [];
    for (const scenario of run.scenarios) {
      const issues = issuesByScenario.get(scenario.id);
      if (!issues || scenario.included === false) continue;
      if (!scenario.steps.some(isRevisable)) {
        tally.skipped++;
        send('progress', { message: `${name(scenario)} — skipped: every step is unticked, so there is nothing it may rewrite` });
        continue;
      }
      queue.push({ scenario, issues, n: queue.length + 1 });
    }

    // Keep the instant fixes even if the slow part is interrupted.
    if (tally.mechanical || tally.flagged) saveRun(run);

    await autofix.runPool(queue, FIX_CONCURRENCY, async ({ scenario, issues, n }) => {
      const position = `[${n}/${queue.length}]`;
      send('progress', { message: `${position} ${name(scenario)} — rewriting (${issues.length} issue${issues.length === 1 ? '' : 's'})` });
      const before = autofix.fingerprint(scenario);
      try {
        const revised = await reviseScenario({
          scenario,
          requirements: run.requirements,
          review: autofix.buildFixNote(issues),
          formattedSteps: formatStepsForPrompt(scenario.steps),
          formattedExamples: formatExamplesForPrompt(scenario),
        });
        // The title is never part of a quality fix, so it is left exactly as it was.
        scenario.steps = reconcileSteps(scenario.steps, revised.steps);
        applyOutlineFromModel(scenario, revised);
        if (autofix.fingerprint(scenario) !== before) {
          scenario.lastReviewApplied = `Quality fix — ${issues.length} issue${issues.length === 1 ? '' : 's'}`;
          tally.rewritten++;
          send('progress', { message: `${position} ${name(scenario)} — fixed`, kind: 'done' });
        } else {
          tally.unchanged++;
          send('progress', { message: `${position} ${name(scenario)} — no change needed` });
        }
      } catch (err) {
        tally.failed++;
        send('progress', { message: `${position} ${name(scenario)} — could not be fixed: ${autofix.shortTitle(err.message, 160)}`, kind: 'failed' });
      }
    });

    run.quality = quality.inspect(run);
    saveRun(run);
    audit.record('fix-issues', {
      runId: run.id,
      detail: `${tally.mechanical} repaired, ${tally.rewritten} rewritten, ${tally.flagged} unticked, ${tally.failed} failed`,
    });

    const parts = [];
    if (tally.mechanical) parts.push(`${tally.mechanical} repaired`);
    if (tally.rewritten) parts.push(`${tally.rewritten} rewritten`);
    if (tally.flagged) parts.push(`${tally.flagged} duplicate${tally.flagged === 1 ? '' : 's'} unticked`);
    if (tally.unchanged) parts.push(`${tally.unchanged} needed no change`);
    if (tally.skipped) parts.push(`${tally.skipped} skipped`);
    if (tally.failed) parts.push(`${tally.failed} failed`);
    send('progress', { message: `${parts.join(', ') || 'Nothing changed'}. ${quality.summarize(run.quality)}` });
    send('done', run);
  } catch (err) {
    console.error('fix-issues failed:', err.message);
    send('failed', { error: err.message });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

module.exports = router;
