// Where the app keeps what the user creates: runs, version history, the audit log,
// the pasted sign-in and the browser profile.
//
// Run from the project folder these sit beside the code (data/, .browser-profile),
// as they always have. The installed desktop app sets BDD_DATA_DIR to a folder in
// the user's profile instead, because the install folder is deleted and rewritten
// by every update — anything kept there is lost with it.

const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const OVERRIDE = process.env.BDD_DATA_DIR ? path.resolve(process.env.BDD_DATA_DIR) : null;

const DATA_DIR = OVERRIDE || path.join(PROJECT_ROOT, 'data');
const PROFILE_DIR = OVERRIDE ? path.join(OVERRIDE, 'browser-profile') : path.join(PROJECT_ROOT, '.browser-profile');

module.exports = { PROJECT_ROOT, DATA_DIR, PROFILE_DIR };
