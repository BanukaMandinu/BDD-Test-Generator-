const express = require('express');
const crypto = require('crypto');
const {
  generateTestPlan,
  refineTestPlan,
  normalizeDataTable,
  hasSavedSession,
  detectUrl,
  discoverPages,
  discoverPagesFast,
  generateFromPages,
  generateFromRecordings,
} = require('../lib/claudeCli');
const { saveRun } = require('../lib/store');
const { resolveTypes, publicList } = require('../lib/testTypes');
const quality = require('../lib/quality');
const { normalizeExamples, placeholdersInStep } = require('../lib/placeholders');
const audit = require('../lib/audit');
const sessionStore = require('../lib/session');
const { sanitizeRecordings } = require('../lib/recorder');

const router = express.Router();
const MAX_INPUT_LENGTH = 20000;
const MAX_INSTRUCTIONS_LENGTH = 4000;
const MAX_CREDENTIAL_LENGTH = 200;

// Defense in depth: the prompt tells the model never to repeat the literal
// credentials, but a saved run/exported file must never carry the plaintext
// password forward even if that instruction is somehow not followed. Walking
// the object tree and matching against each string's real value (rather than
// a JSON.stringify(run)-then-split/join, which searched for the raw secret
// inside JSON-*escaped* text and silently failed to match whenever the
// secret contained a `"`, `\`, or control character JSON.stringify encodes)
// catches every string field in the run, present and future, without having
// to enumerate them by hand.
function redactSecrets(run, secrets) {
  const values = secrets.filter((s) => s && s.length >= 3);
  if (!values.length) return run;

  function scrub(value) {
    if (typeof value === 'string') {
      let out = value;
      for (const secret of values) out = out.split(secret).join('(redacted)');
      return out;
    }
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === 'object') {
      const copy = {};
      for (const key of Object.keys(value)) copy[key] = scrub(value[key]);
      return copy;
    }
    return value;
  }

  return scrub(run);
}

router.get('/test-types', (req, res) => res.json(publicList()));

// Lets the UI show whether a signed-in session is available to reuse.
router.get('/session', (req, res) => {
  const pasted = sessionStore.describe();
  res.json({ available: hasSavedSession(), pasted });
});

// The snippet the user runs in their own Chrome console.
router.get('/session/snippet', (req, res) => res.json({ snippet: sessionStore.BROWSER_SNIPPET }));

router.post('/session/paste', (req, res) => {
  try {
    const result = sessionStore.saveFromPaste(req.body?.session);
    audit.record('session-paste', {
      detail: `${result.cookieCount} cookies, ${result.localStorageCount} localStorage from ${result.origin || 'unknown origin'}`,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/session', (req, res) => {
  sessionStore.clearStorageState();
  audit.record('session-clear', {});
  res.json({ cleared: true });
});

// Maps the model's zero-based requirement indices onto our generated ids.
function mapCoverage(coversRequirements, requirements) {
  return (coversRequirements || [])
    .map((i) => requirements[i]?.id)
    .filter(Boolean);
}

function buildSteps(rawSteps) {
  return (rawSteps || []).map((st) => ({
    id: crypto.randomUUID(),
    keyword: st.keyword,
    text: st.text,
    included: true,
    dataTable: normalizeDataTable(st.dataTable),
  }));
}

function buildScenarios(rawScenarios, requirements, validTypeIds) {
  return (rawScenarios || []).map((s) => {
    const steps = buildSteps(s.steps);
    const examples = normalizeExamples(s.examples);

    // Trust the placeholders over the flag: a scenario is an outline if it's
    // actually parameterised and has an Examples table to draw from.
    const hasPlaceholders = steps.some((st) => placeholdersInStep(st).length > 0);
    const outline = Boolean(s.isOutline || hasPlaceholders) && Boolean(examples);

    return {
      id: crypto.randomUUID(),
      title: s.title,
      testType: validTypeIds.has(s.testType) ? s.testType : null,
      included: true,
      review: '',
      isOutline: outline,
      examples: outline ? examples : null,
      page: typeof s.page === 'string' && s.page.trim() ? s.page.trim().slice(0, 500) : null,
      coversRequirementIds: mapCoverage(s.coversRequirements, requirements),
      steps,
    };
  });
}

// Step 1 of the URL flow: map the site's pages so the user can pick which to
// cover. Streamed, because crawling several pages takes a while.
router.post('/discover', async (req, res) => {
  const raw = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
  const useSession = req.body?.useSession === true;
  const maxPages = Math.min(Math.max(Number(req.body?.maxPages) || 12, 1), 25);
  // The fast crawler is the default; "thorough" opts back into the slower,
  // fully AI-driven crawl — an escape hatch for sites the fast path can't
  // read (heavy WAF, JS-only nav with no real links to follow).
  const thorough = req.body?.thorough === true;

  let url;
  try {
    url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('bad protocol');
  } catch {
    return res.status(400).json({ error: 'Please give a full http(s) URL to explore.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);

  try {
    const explore = thorough ? discoverPages : discoverPagesFast;
    const result = await explore(url.toString(), {
      useSession,
      maxPages,
      onProgress: (message) => send('progress', { message }),
    });

    if (!result.pages.length) {
      throw new Error('No pages were found. The site may block automated browsing, or it may be a single page — in which case just generate from the URL directly.');
    }

    audit.record('discover', { detail: `${result.pages.length} pages at ${url.origin}${thorough ? ' (thorough)' : ''}` });
    send('progress', { message: `Found ${result.pages.length} page${result.pages.length === 1 ? '' : 's'}` });
    send('done', result);
  } catch (err) {
    console.error('discover failed:', err.message);
    send('failed', { error: err.message });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

router.post('/generate', async (req, res) => {
  const input = typeof req.body?.input === 'string' ? req.body.input.trim() : '';
  const interactive = req.body?.interactive === true;
  const useSession = req.body?.useSession === true;
  const refine = req.body?.refine !== false; // critique pass on unless explicitly disabled
  const types = resolveTypes(req.body?.types);
  const validTypeIds = new Set(types.map((t) => t.id));

  const instructions = typeof req.body?.instructions === 'string'
    ? req.body.instructions.trim().slice(0, MAX_INSTRUCTIONS_LENGTH)
    : '';

  // Credentials are only ever meaningful when the agent is actually allowed to
  // act on the page — buildInteractiveInstructions() also gates on this, but
  // dropping them here too means a non-interactive run never even holds onto
  // them in memory longer than this request.
  const testUsername = interactive && typeof req.body?.testUsername === 'string'
    ? req.body.testUsername.trim().slice(0, MAX_CREDENTIAL_LENGTH)
    : '';
  const testPassword = interactive && typeof req.body?.testPassword === 'string'
    ? req.body.testPassword.slice(0, MAX_CREDENTIAL_LENGTH)
    : '';

  // Present when the user picked pages from the discovery step. Same
  // http(s)-only check /discover and /record/start already enforce — without
  // it a crafted `pages` payload could hand the model a file:// URL to
  // navigate to via its browser tools, reading local disk content into the
  // generated run.
  const pages = (Array.isArray(req.body?.pages) ? req.body.pages : [])
    .map((p) => {
      try {
        const url = new URL(String(p?.url ?? ''));
        if (!['http:', 'https:'].includes(url.protocol)) return null;
        return {
          url: url.toString(),
          title: String(p?.title ?? '').slice(0, 200),
          purpose: String(p?.purpose ?? '').slice(0, 300),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .slice(0, 25);

  // Present when the user recorded one or more flows themselves (see
  // server/lib/recorder.js) rather than exploring or describing. Content-level
  // scrubbing (secrets, PII-shaped strings) already happened at capture time,
  // before this data was ever shown back to the user in a status poll — this
  // is structural validation only, the same layering `pages` gets above.
  const recordings = sanitizeRecordings(req.body?.recordings);

  if (!pages.length && !recordings.length && !input) return res.status(400).json({ error: 'input is required' });
  if (input.length > MAX_INPUT_LENGTH) {
    return res.status(400).json({ error: `input must be under ${MAX_INPUT_LENGTH} characters` });
  }

  // A bare URL — nothing left over once the link itself is removed — must go
  // through /discover first, so the user sees the site's actual pages before
  // committing to a generation run. This mirrors the UI gate (isLikelyUrl() in
  // app.js) so it's an enforced rule, not just a disabled button someone could
  // route around by calling the API directly. A URL alongside real prose still
  // generates directly — detectUrl() already folds that prose into context.
  // A recording carries its own ground truth, so it's exempt the same way a
  // page-picker selection already is.
  if (!pages.length && !recordings.length) {
    const detected = detectUrl(input);
    if (detected && !detected.extraContext) {
      return res.status(400).json({
        error: 'Explore this site first, then generate from the pages you pick — use "Explore the whole site first" instead.',
      });
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
    send('progress', { message: `Writing ${types.length} type${types.length === 1 ? '' : 's'} of test: ${types.map((t) => t.label).join(', ')}` });

    // ---- Stage 1: draft ----
    const onProgress = (message) => send('progress', { message });
    const pagesExtraContext = [input, instructions].filter(Boolean).join('\n\n');
    const { plan, sourceUrl, interactive: didInteract, usedSession } = recordings.length
      ? await generateFromRecordings({ recordings, extraContext: instructions, types, onProgress })
      : pages.length
      ? await generateFromPages({ pages, extraContext: pagesExtraContext, interactive, useSession, types, testUsername, testPassword, onProgress })
      : await generateTestPlan(input, { interactive, useSession, types, extraContext: instructions, testUsername, testPassword, onProgress });

    const requirements = (plan.requirements || []).map((r) => ({
      id: crypto.randomUUID(),
      text: String(r.text ?? r),
      covered: false,
    }));

    let run = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      input,
      instructions,
      // Never store the credentials themselves — only whether they were used,
      // which is enough context to make sense of the run later. Forced false
      // for a recorded run regardless of what the request carried: the model
      // never touched a browser or a credential for this path.
      usedTestCredentials: recordings.length ? false : Boolean(testUsername && testPassword),
      sourceUrl,
      exploredInteractively: recordings.length ? false : didInteract,
      usedSavedSession: recordings.length ? false : Boolean(usedSession),
      coveredPages: pages.length ? pages.map((p) => p.url) : null,
      // Only counts/titles/start URLs — never the raw captured actions. Once
      // scenarios exist the transcript has done its job; not retaining it is a
      // data-minimization win given this feature captures live interaction
      // data off a real site.
      recordedFlows: recordings.length
        ? recordings.map((r) => ({ title: r.title, actionCount: r.actions.length, startUrl: r.startUrl }))
        : null,
      selectedTypes: types.map((t) => t.id),
      refined: false,
      refineFixes: [],
      featureTitle: plan.featureTitle || 'Untitled feature',
      featureDescription: plan.featureDescription || '',
      requirements,
      scenarios: buildScenarios(plan.scenarios, requirements, validTypeIds),
    };

    send('progress', { message: `Draft: ${run.scenarios.length} test cases` });

    // ---- Quality check on the draft ----
    let report = quality.inspect(run);
    send('progress', { message: quality.summarize(report) });

    // ---- Stage 2: critique pass (patch-based) ----
    if (refine) {
      send('progress', { message: 'Reviewing the draft for repetition, gaps and wording' });
      try {
        // Send the draft with explicit ref numbers so corrections can be mapped back.
        const refToScenario = new Map();
        const draftForPrompt = run.scenarios.map((s, i) => {
          refToScenario.set(i + 1, s);
          return {
            ref: i + 1,
            title: s.title,
            testType: s.testType,
            isOutline: s.isOutline || false,
            ...(s.examples ? { examples: s.examples } : {}),
            steps: s.steps.map((st) => ({
              keyword: st.keyword,
              text: st.text,
              ...(st.dataTable ? { dataTable: st.dataTable } : {}),
            })),
            coversRequirements: s.coversRequirementIds
              .map((id) => run.requirements.findIndex((r) => r.id === id))
              .filter((i) => i >= 0),
          };
        });

        const refined = await refineTestPlan({
          featureTitle: run.featureTitle,
          featureDescription: run.featureDescription,
          requirements: run.requirements,
          types,
          detectedIssues: report.issues,
          scenariosJson: JSON.stringify(draftForPrompt, null, 1),
          onProgress: (message) => send('progress', { message }),
        });

        const ops = Array.isArray(refined.operations) ? refined.operations : [];
        const deleted = new Set();
        const fixes = [];
        let replacedCount = 0;
        const addedScenarios = [];

        for (const op of ops) {
          const ref = Number(op.ref);
          const target = Number.isFinite(ref) ? refToScenario.get(ref) : null;
          const why = op.why ? String(op.why) : '';

          if (op.op === 'delete' && target) {
            deleted.add(target.id);
            fixes.push(`Removed "${target.title}"${why ? ` — ${why}` : ''}`);
          } else if (op.op === 'replace' && target && op.steps?.length) {
            const [rebuilt] = buildScenarios([op], run.requirements, validTypeIds);
            target.title = rebuilt.title || target.title;
            target.testType = rebuilt.testType ?? target.testType;
            target.steps = rebuilt.steps;
            target.isOutline = rebuilt.isOutline;
            target.examples = rebuilt.examples;
            // The refine schema carries no "page", so keep the label we already had.
            target.page = rebuilt.page ?? target.page;
            target.coversRequirementIds = rebuilt.coversRequirementIds.length
              ? rebuilt.coversRequirementIds
              : target.coversRequirementIds;
            replacedCount++;
            fixes.push(`Reworked "${target.title}"${why ? ` — ${why}` : ''}`);
          } else if (op.op === 'add' && op.steps?.length) {
            const [built] = buildScenarios([op], run.requirements, validTypeIds);
            addedScenarios.push(built);
            fixes.push(`Added "${built.title}"${why ? ` — ${why}` : ''}`);
          }
        }

        // Refuse a patch that would empty the suite — keep the draft instead.
        const survivors = run.scenarios.filter((s) => !deleted.has(s.id));
        if (survivors.length + addedScenarios.length === 0) {
          send('progress', { message: 'Review wanted to delete everything — keeping the draft instead' });
        } else {
          run.scenarios = [...survivors, ...addedScenarios];
          run.refined = true;
          run.refineFixes = fixes.slice(0, 40);
          run.refineVerdict = refined.verdict ? String(refined.verdict) : '';

          if (!ops.length) {
            send('progress', { message: 'Review found nothing to change — the draft was already clean' });
          } else {
            send('progress', {
              message: `Review applied: ${deleted.size} removed, ${replacedCount} reworked, ${addedScenarios.length} added → ${run.scenarios.length} test cases`,
            });
            for (const fix of run.refineFixes) send('progress', { message: `· ${fix}` });
          }
        }
      } catch (err) {
        // A failed critique must never lose the draft the user already paid for.
        console.error('refine pass failed:', err.message);
        send('progress', { message: `Review pass failed (${err.message}) — keeping the draft` });
      }

      report = quality.inspect(run);
      send('progress', { message: quality.summarize(report) });
    }

    run.quality = report;
    // Last step before this leaves the server, in either direction (saved to
    // disk, or sent to the browser) — the model was told never to repeat the
    // literal credentials, but this is the backstop that guarantees it.
    run = redactSecrets(run, [testUsername, testPassword]);
    saveRun(run);
    audit.record('generate', {
      runId: run.id,
      detail: `${run.scenarios.length} scenarios, types=[${run.selectedTypes.join(',')}]${sourceUrl ? ` from ${sourceUrl}` : ''}${didInteract ? ' interactive' : ''}${run.refined ? ' refined' : ''}`,
    });
    send('done', run);
  } catch (err) {
    console.error('generate failed:', err.message);
    send('failed', { error: err.message });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

module.exports = router;
