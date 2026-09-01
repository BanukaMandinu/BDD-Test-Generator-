const fs = require('fs');
const path = require('path');

const VERSIONS_DIR = path.join(__dirname, '..', '..', 'data', 'versions');
const MAX_VERSIONS_PER_RUN = 50;

function safeId(id) {
  const clean = String(id).replace(/[^a-zA-Z0-9-]/g, '');
  if (!clean || clean !== String(id)) throw new Error('Invalid id');
  return clean;
}

function runDir(runId) {
  return path.join(VERSIONS_DIR, safeId(runId));
}

// Snapshots the run as it is *before* a change, so history reads as "what it
// looked like at each point" and every later state can be diffed against it.
function snapshot(run, action) {
  const dir = runDir(run.id);
  fs.mkdirSync(dir, { recursive: true });

  const stamp = new Date().toISOString();
  const id = `${stamp.replace(/[:.]/g, '-')}`;
  const payload = {
    versionId: id,
    at: stamp,
    action,
    featureTitle: run.featureTitle,
    featureDescription: run.featureDescription,
    scenarios: run.scenarios,
    requirements: run.requirements,
  };

  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(payload), 'utf8');
  prune(dir);
  return id;
}

function prune(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const excess = files.length - MAX_VERSIONS_PER_RUN;
  for (let i = 0; i < excess; i++) {
    fs.unlinkSync(path.join(dir, files[i]));
  }
}

function list(runId) {
  const dir = runDir(runId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const v = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      return {
        versionId: v.versionId,
        at: v.at,
        action: v.action,
        scenarioCount: (v.scenarios || []).length,
      };
    })
    .sort((a, b) => new Date(b.at) - new Date(a.at));
}

function load(runId, versionId) {
  const file = path.join(runDir(runId), `${safeId(versionId)}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ---- Diffing ----

function stepText(step) {
  const base = `${step.keyword} ${step.text}`;
  if (Array.isArray(step.dataTable) && step.dataTable.length) {
    return base + '\n' + step.dataTable.map((r) => `| ${r.join(' | ')} |`).join('\n');
  }
  return base;
}

function diffSteps(oldSteps = [], newSteps = []) {
  const oldTexts = oldSteps.map(stepText);
  const newTexts = newSteps.map(stepText);
  const oldSet = new Set(oldTexts);
  const newSet = new Set(newTexts);

  return {
    added: newTexts.filter((t) => !oldSet.has(t)),
    removed: oldTexts.filter((t) => !newSet.has(t)),
    unchangedCount: newTexts.filter((t) => oldSet.has(t)).length,
  };
}

// Compares a stored version against the run's current state, matching scenarios
// by id so a reworded title still reads as a change rather than a delete+add.
function diff(version, run) {
  const oldById = new Map((version.scenarios || []).map((s) => [s.id, s]));
  const newById = new Map(run.scenarios.map((s) => [s.id, s]));

  const added = run.scenarios
    .filter((s) => !oldById.has(s.id))
    .map((s) => ({ id: s.id, title: s.title, stepCount: s.steps.length }));

  const removed = (version.scenarios || [])
    .filter((s) => !newById.has(s.id))
    .map((s) => ({ id: s.id, title: s.title, stepCount: (s.steps || []).length }));

  const changed = [];
  for (const [id, oldScenario] of oldById) {
    const newScenario = newById.get(id);
    if (!newScenario) continue;

    const titleChanged = oldScenario.title !== newScenario.title;
    const steps = diffSteps(oldScenario.steps, newScenario.steps);
    const includedChanged = (oldScenario.included !== false) !== (newScenario.included !== false);

    if (titleChanged || steps.added.length || steps.removed.length || includedChanged) {
      changed.push({
        id,
        titleBefore: titleChanged ? oldScenario.title : null,
        titleAfter: titleChanged ? newScenario.title : null,
        title: newScenario.title,
        includedBefore: oldScenario.included !== false,
        includedAfter: newScenario.included !== false,
        steps,
      });
    }
  }

  const featureTitleChanged =
    version.featureTitle !== run.featureTitle
      ? { before: version.featureTitle, after: run.featureTitle }
      : null;

  return {
    from: { versionId: version.versionId, at: version.at, action: version.action },
    featureTitleChanged,
    added,
    removed,
    changed,
    isEmpty: !added.length && !removed.length && !changed.length && !featureTitleChanged,
  };
}

module.exports = { snapshot, list, load, diff };
