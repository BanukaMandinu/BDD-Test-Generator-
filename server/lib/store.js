const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const RUNS_DIR = path.join(DATA_DIR, 'runs');

function ensureDirs() {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
}

function runPath(id) {
  // id is always server-generated (crypto.randomUUID), never taken from a URL param verbatim,
  // but we still guard against path traversal defensively.
  const safeId = String(id).replace(/[^a-zA-Z0-9-]/g, '');
  if (!safeId || safeId !== String(id)) throw new Error('Invalid run id');
  return path.join(RUNS_DIR, `${safeId}.json`);
}

function saveRun(run) {
  ensureDirs();
  run.updatedAt = new Date().toISOString();
  fs.writeFileSync(runPath(run.id), JSON.stringify(run, null, 2), 'utf8');
  return run;
}

function loadRun(id) {
  ensureDirs();
  const file = runPath(id);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function listRuns() {
  ensureDirs();
  return fs
    .readdirSync(RUNS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const run = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, f), 'utf8'));
      return {
        id: run.id,
        featureTitle: run.featureTitle,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        scenarioCount: run.scenarios.length,
        requirementCount: run.requirements.length,
      };
    })
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

module.exports = { saveRun, loadRun, listRuns, DATA_DIR };
