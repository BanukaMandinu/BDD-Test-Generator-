// Single source of truth for the test-case types a run can ask for. The UI builds
// its checkboxes from GET /api/test-types, so adding a type here is all it takes.
//
// `tag` becomes the Gherkin @tag on every scenario of that type.
// `guidance` is injected into the generation prompt only when the type is selected.
const TEST_TYPES = [
  {
    id: 'happy-path',
    label: 'Happy path',
    tag: '@happy-path',
    blurb: 'The main flow working correctly',
    default: true,
    guidance:
      'The primary successful flow — the thing the feature exists to do, with valid input and a user who is allowed to do it. One or two scenarios, not more; this is the baseline, not the bulk.',
  },
  {
    id: 'negative-path',
    label: 'Negative path',
    tag: '@negative',
    blurb: 'Wrong input, refusals, failures',
    default: true,
    guidance:
      'What happens when the action legitimately fails or is refused: wrong credentials, an action taken in the wrong state, something that no longer exists, a rule that blocks it. Assert both the message shown AND that the underlying change did NOT happen.',
  },
  {
    id: 'validation',
    label: 'Field validation',
    tag: '@validation',
    blurb: 'Required fields, formats, limits',
    default: true,
    guidance:
      'Field-level rules: required fields left empty, wrong format, values too long or too short, disallowed characters. One scenario per distinct rule — or a Scenario Outline when the only difference is the value.',
  },
  {
    id: 'edge-case',
    label: 'Edge cases',
    tag: '@edge-case',
    blurb: 'Boundaries, empty states, expiry, duplicates',
    default: true,
    guidance:
      'The awkward cases that bite in production: exact boundary values (the limit itself, one under, one over), an empty list or first-time-user state, something that has expired, something that already exists, an action repeated twice.',
  },
  {
    id: 'permissions',
    label: 'Permissions & roles',
    tag: '@permissions',
    blurb: 'Who is and is not allowed',
    default: false,
    guidance:
      'Authorisation by role: who may perform this and who must be refused. Cover at least one allowed role and one denied role, and confirm a denied user sees no data they should not see.',
  },
  {
    id: 'api',
    label: 'Backend / API',
    tag: '@api',
    blurb: 'Service behaviour behind the screen',
    default: false,
    guidance:
      'Behaviour at the service layer rather than the screen: the request is accepted or rejected, the right status is returned, the stored record actually changes, and a bad request is refused without side effects. Describe these in plain business terms ("the order is rejected and nothing is saved"), NOT as HTTP mechanics or endpoint paths, unless the source material named them.',
  },
  {
    id: 'performance',
    label: 'Performance',
    tag: '@performance',
    blurb: 'Speed and behaviour under load',
    default: false,
    guidance:
      'Responsiveness and behaviour under load: the action completes within an acceptable time, a large data set still renders, many simultaneous users are handled. Only state a specific number if the source material gave one — otherwise say "within the agreed response time" and leave the target to be filled in.',
  },
  {
    id: 'security',
    label: 'Security',
    tag: '@security',
    blurb: 'Access control, injection, data exposure',
    default: false,
    guidance:
      'Defensive checks: a signed-out or unauthorised user cannot reach protected data directly, input containing script or query syntax is handled safely, sensitive values are never displayed or logged in full, and a session ends when it should. Describe the expected safe outcome — never include a working exploit payload.',
  },
  {
    id: 'accessibility',
    label: 'Accessibility',
    tag: '@accessibility',
    blurb: 'Keyboard, screen reader, contrast',
    default: false,
    guidance:
      'WCAG-oriented checks: the whole flow is operable by keyboard alone, focus order is sensible and visible, every field has a label a screen reader announces, errors are announced and not signalled by colour alone, and images have meaningful alternative text.',
  },
  {
    id: 'data-integrity',
    label: 'Data integrity',
    tag: '@data-integrity',
    blurb: 'Persistence, concurrency, audit trail',
    default: false,
    guidance:
      'The data stays correct: a change survives a reload and a new session, two people editing the same record do not silently overwrite each other, a failed multi-step action leaves nothing half-saved, and a recorded change is traceable to who made it and when.',
  },
];

const BY_ID = new Map(TEST_TYPES.map((t) => [t.id, t]));

function defaultTypeIds() {
  return TEST_TYPES.filter((t) => t.default).map((t) => t.id);
}

// Accepts whatever the client sent and returns a clean, ordered list of known ids.
// Falls back to the defaults rather than generating nothing.
function resolveTypes(requested) {
  const wanted = new Set(Array.isArray(requested) ? requested : []);
  const resolved = TEST_TYPES.filter((t) => wanted.has(t.id));
  return resolved.length ? resolved : TEST_TYPES.filter((t) => t.default);
}

function tagForType(id) {
  return BY_ID.get(id)?.tag || null;
}

function labelForType(id) {
  return BY_ID.get(id)?.label || id;
}

// The public shape the UI needs — guidance stays server-side.
function publicList() {
  return TEST_TYPES.map(({ id, label, tag, blurb, default: isDefault }) => ({
    id,
    label,
    tag,
    blurb,
    default: isDefault,
  }));
}

module.exports = { TEST_TYPES, defaultTypeIds, resolveTypes, tagForType, labelForType, publicList };
