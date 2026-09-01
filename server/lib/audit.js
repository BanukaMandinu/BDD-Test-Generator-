const fs = require('fs');
const path = require('path');

const AUDIT_LOG = path.join(__dirname, '..', '..', 'data', 'audit.log');

// Append-only audit trail of who did what, when. Never logs requirement/scenario
// content itself (that may be sensitive) — only the action, run id, and actor.
function record(action, { actor, runId, detail } = {}) {
  fs.mkdirSync(path.dirname(AUDIT_LOG), { recursive: true });
  const entry = {
    ts: new Date().toISOString(),
    action,
    actor: actor || 'local-user',
    runId: runId || null,
    detail: detail || null,
  };
  fs.appendFileSync(AUDIT_LOG, JSON.stringify(entry) + '\n', 'utf8');
}

module.exports = { record };
