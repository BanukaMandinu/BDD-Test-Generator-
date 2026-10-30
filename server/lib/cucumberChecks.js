// Cucumber-specific quality checks — the things that make a suite good or bad as
// an actual Cucumber project, rather than just as readable English.
//
// The one that matters most is step reuse. Every distinct step phrasing needs its
// own step definition, so a suite that says "the customer is signed in" in one
// scenario and "a signed-in customer" in the next has doubled its glue code for
// no benefit. Nothing else in this file costs a team as much maintenance.

const GENERIC_ACTORS = [
  'user', 'customer', 'visitor', 'shopper', 'member', 'client', 'guest', 'buyer', 'person',
];

// Roles are legitimately different actors — don't flag admin vs student as drift.
const ROLE_WORDS = new Set([
  'admin', 'administrator', 'manager', 'owner', 'instructor', 'student', 'teacher',
  'operator', 'approver', 'reviewer', 'auditor', 'supervisor', 'agent', 'staff',
]);

// Mirrors Cucumber Expressions: two steps that reduce to the same shape share one
// step definition, which is exactly what we want to encourage.
function normalizeStep(text) {
  return String(text ?? '')
    .replace(/"[^"]*"/g, '{string}')
    .replace(/'[^']*'/g, '{string}')
    .replace(/<[^<>]+>/g, '{param}')
    .replace(/\b\d+(\.\d+)?\b/g, '{int}')
    .toLowerCase()
    .replace(/[^a-z0-9{}\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function words(text) {
  return normalizeStep(text).split(' ').filter(Boolean);
}

// Negation carries the whole meaning of a step, but word-overlap treats "not" as
// just another token — so "the student is enrolled" and "the student is not
// enrolled" score as identical when they are exact opposites. Polarity has to be
// compared separately, and a mismatch rules a pair out entirely.
const NEGATION_WORDS = new Set([
  'not', 'no', 'never', 'cannot', 'cant', 'without', 'nor', 'none', 'neither',
  'refused', 'rejected', 'denied', 'blocked', 'prevented', 'fails', 'failed',
  'unable', 'disallowed', 'forbidden', 'unchanged', 'empty',
]);

function isNegative(text) {
  const w = words(text);
  return w.some((word) => NEGATION_WORDS.has(word)) || /n't\b/i.test(String(text));
}

// Overlap coefficient, not Jaccard. Steps are short, and Jaccard punishes a
// one-word difference far too hard: "the user is signed in" vs "the user is
// logged in" scores only 0.67 by Jaccard despite plainly meaning the same thing.
function similarity(a, b) {
  // Opposites are never duplicates, however much wording they share.
  if (isNegative(a) !== isNegative(b)) return 0;

  const setA = new Set(words(a));
  const setB = new Set(words(b));
  if (!setA.size || !setB.size) return 0;

  // Guard the failure mode of overlap coefficient: a short step that happens to
  // be a subset of a much longer one would otherwise score a perfect 1.0.
  const ratio = Math.max(setA.size, setB.size) / Math.min(setA.size, setB.size);
  if (ratio > 2) return 0;

  let shared = 0;
  for (const w of setA) if (setB.has(w)) shared++;
  return shared / Math.min(setA.size, setB.size);
}

// Resolves And/But to whichever of Given/When/Then it continues, so structure can
// be judged on meaning rather than on the literal keyword.
function effectiveRoles(steps) {
  let last = null;
  return steps.map((step) => {
    if (step.keyword === 'Given' || step.keyword === 'When' || step.keyword === 'Then') {
      last = step.keyword;
    }
    return { step, role: last };
  });
}

// ---- Structure: Given = state, When = one action, Then = observable outcome ----
function checkStructure(scenarios) {
  const issues = [];

  for (const scenario of scenarios) {
    if (scenario.included === false) continue;
    const live = (scenario.steps || []).filter((s) => s.included !== false);
    if (!live.length) continue;

    const roles = effectiveRoles(live);
    const seq = roles.map((r) => r.role);
    const add = (severity, message) =>
      issues.push({ kind: 'cucumber', severity, scenarioIds: [scenario.id], message });

    if (!seq.includes('Then')) {
      add('warning', `"${scenario.title}" has no Then step, so it asserts nothing.`);
    }
    if (!seq.includes('When') && seq.includes('Then')) {
      add('info', `"${scenario.title}" has no When step — it checks state without acting. Fine for a content check, wrong if a behaviour is meant to be exercised.`);
    }

    const firstWhen = seq.indexOf('When');
    const firstThen = seq.indexOf('Then');
    if (firstThen !== -1 && firstWhen !== -1 && firstThen < firstWhen) {
      add('warning', `"${scenario.title}" puts a Then before its When. Order should be Given → When → Then.`);
    }

    // Setup must precede the FIRST action, so compare against the earliest of
    // When/Then — not the latest, which would let a mid-scenario Given slip past.
    const actionIndexes = [firstWhen, firstThen].filter((i) => i !== -1);
    const firstAction = actionIndexes.length ? Math.min(...actionIndexes) : -1;
    const givenAfterAction = firstAction === -1
      ? -1
      : seq.findIndex((role, i) => role === 'Given' && i > firstAction);
    if (givenAfterAction !== -1) {
      add('warning', `"${scenario.title}" sets up a Given after the action. Move all setup before the When.`);
    }

    // Two separate When blocks means two behaviours in one scenario.
    let whenBlocks = 0;
    let prev = null;
    for (const role of seq) {
      if (role === 'When' && prev !== 'When') whenBlocks++;
      prev = role;
    }
    if (whenBlocks > 1) {
      add('warning', `"${scenario.title}" has ${whenBlocks} separate When blocks — that's ${whenBlocks} behaviours. Split it into ${whenBlocks} scenarios.`);
    }
  }

  return issues;
}

// ---- Step-level smells ----
const STEP_SMELLS = [
  {
    re: /\s+and\s+(?:the\s+|they\s+|he\s+|she\s+|it\s+)?(?:then\s+)?\S/i,
    why: 'joins two actions with "and" — split it into two steps so each can be reused',
    roles: null,
  },
  { re: /\bshould\b/i, why: 'uses "should" — assert what happens ("the order is placed"), not what ought to', roles: ['Then'] },
  { re: /\bwill\b/i, why: 'uses "will" — write the outcome in the present tense', roles: ['Then'] },
  { re: /\bmust\b/i, why: 'uses "must" — that is requirement language, not an observed outcome', roles: ['Then'] },
  { re: /\btry\s+to\b|\battempts?\s+to\b/i, why: 'says "tries to" — state the action plainly', roles: ['When'] },
  { re: /\bcorrectly\b|\bproperly\b|\bsuccessfully\b|\bas expected\b/i, why: 'asserts something vague ("correctly", "as expected") — say what is actually true', roles: ['Then'] },
  { re: /\bverif(y|ies)\b|\bcheck(s)?\b|\bvalidates?\b/i, why: 'describes the act of testing — a step states a fact, the title says what is verified', roles: ['Then'] },
];

function checkStepSmells(scenarios) {
  const issues = [];

  for (const scenario of scenarios) {
    if (scenario.included === false) continue;
    const roles = effectiveRoles((scenario.steps || []).filter((s) => s.included !== false));

    for (const { step, role } of roles) {
      for (const smell of STEP_SMELLS) {
        if (smell.roles && !smell.roles.includes(role)) continue;
        if (smell.re.test(step.text)) {
          issues.push({
            kind: 'cucumber',
            severity: 'info',
            scenarioIds: [scenario.id],
            stepId: step.id,
            message: `"${step.keyword} ${step.text}" — ${smell.why}.`,
          });
          break;
        }
      }
    }
  }

  return issues;
}

// ---- Voice consistency across the whole suite ----
// Voice problems are suite-wide, but each one is fixed one test case at a time, so
// the issue carries the cases that break the majority convention (scenarioIds) and
// the convention itself (instruction) for whoever rewrites them.
const FIRST_PERSON_RE = /^i\s|\bi am\b|\bmy\b/i;
const THIRD_PERSON_RE = /\bthe (user|customer|visitor|shopper|member|client|guest|buyer)\b|\bthey\b/i;
const actorRe = (actor) => new RegExp(`\\b${actor}s?\\b`, 'i');

function checkVoice(scenarios) {
  const issues = [];
  const live = scenarios
    .filter((s) => s.included !== false)
    .map((scenario) => ({
      scenario,
      steps: (scenario.steps || []).filter((st) => st.included !== false),
    }));
  const liveSteps = live.flatMap((l) => l.steps);

  if (liveSteps.length < 3) return issues;

  const allText = liveSteps.map((s) => s.text.toLowerCase()).join(' ');

  const actorsUsed = GENERIC_ACTORS.filter((a) => new RegExp(`\\b${a}s?\\b`).test(allText));
  // Most-used noun wins, so the rewrite touches as few steps as possible.
  const actorCounts = actorsUsed.map((a) => liveSteps.filter((s) => actorRe(a).test(s.text)).length);
  const dominantActor = actorsUsed.length ? actorsUsed[actorCounts.indexOf(Math.max(...actorCounts))] : 'user';

  if (actorsUsed.length > 1) {
    const others = actorsUsed.filter((a) => a !== dominantActor);
    issues.push({
      kind: 'cucumber',
      severity: 'warning',
      scenarioIds: live
        .filter((l) => l.steps.some((st) => others.some((a) => actorRe(a).test(st.text))))
        .map((l) => l.scenario.id),
      instruction: `Refer to the actor as "${dominantActor}" everywhere — replace ${others.map((a) => `"${a}"`).join(', ')} with "${dominantActor}".`,
      message: `The suite mixes ${actorsUsed.map((a) => `"${a}"`).join(', ')} for the same actor. Pick one and use it everywhere — inconsistent nouns fragment step definitions.`,
    });
  }

  const firstPerson = liveSteps.filter((s) => FIRST_PERSON_RE.test(s.text)).length;
  const thirdPerson = liveSteps.filter((s) => THIRD_PERSON_RE.test(s.text)).length;
  if (firstPerson && thirdPerson) {
    const firstWins = firstPerson >= thirdPerson;
    const minority = firstWins ? THIRD_PERSON_RE : FIRST_PERSON_RE;
    issues.push({
      kind: 'cucumber',
      severity: 'warning',
      scenarioIds: live.filter((l) => l.steps.some((st) => minority.test(st.text))).map((l) => l.scenario.id),
      instruction: firstWins
        ? 'Write every step in the first person ("I …") — the rest of the suite does.'
        : `Write every step in the third person ("the ${dominantActor} …") — the rest of the suite does.`,
      message: `The suite mixes first person ("I …", ${firstPerson} step${firstPerson === 1 ? '' : 's'}) with third person (${thirdPerson}). Cucumber suites should commit to one voice.`,
    });
  }

  return issues;
}

// ---- Step reuse: the metric that decides how much glue code a team maintains ----
//
// Deliberately conservative. Telling apart "signed in"/"logged in" (synonyms, so
// unify) from "not changed"/"not created" (different verbs, so leave alone) needs
// semantic knowledge this code doesn't have, and a QA lead shown ten flags of
// which seven are wrong stops trusting the tool. So the threshold only catches
// near-verbatim pairs; unifying by meaning is the AI review pass's job, which is
// instructed to do exactly that. The headline value here is the reuse metric.
//
// 0.85 was picked against real cases: it catches inflection and spacing variants
// ("student account"/"students account", "on screen"/"onscreen") while leaving
// same-shape-different-verb pairs ("not changed"/"not created", both 0.8) alone.
const REUSE_SIMILARITY = 0.85;

function checkStepReuse(scenarios) {
  const issues = [];
  const byNormalized = new Map();

  for (const scenario of scenarios) {
    if (scenario.included === false) continue;
    for (const { step, role } of effectiveRoles((scenario.steps || []).filter((s) => s.included !== false))) {
      const key = `${role || 'Given'}|${normalizeStep(step.text)}`;
      if (!byNormalized.has(key)) {
        byNormalized.set(key, { role, normalized: normalizeStep(step.text), examples: [], count: 0, scenarioIds: new Set() });
      }
      const entry = byNormalized.get(key);
      entry.count++;
      entry.scenarioIds.add(scenario.id);
      if (entry.examples.length < 2) entry.examples.push(step.text);
    }
  }

  const entries = [...byNormalized.values()];
  const totalSteps = entries.reduce((n, e) => n + e.count, 0);

  // Near-duplicates that reduce to different shapes are the sprawl: they'd each
  // need their own step definition despite meaning the same thing.
  const flaggedPairs = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (entries[i].role !== entries[j].role) continue;
      const score = similarity(entries[i].normalized, entries[j].normalized);
      if (score >= REUSE_SIMILARITY) {
        flaggedPairs.push([entries[i], entries[j], score]);
      }
    }
  }

  for (const [a, b, score] of flaggedPairs.slice(0, 6)) {
    // The wording used more often is the one to keep; the other gets unified to it.
    const [keep, variant] = b.count > a.count ? [b, a] : [a, b];
    issues.push({
      kind: 'reuse',
      severity: 'info',
      scenarioIds: [...variant.scenarioIds],
      instruction: `The steps "${variant.examples[0]}" and "${keep.examples[0]}" are worded almost the same. If they mean the same thing, reword the first to use exactly the second's wording (keep any quoted values). If they differ in meaning, leave both alone.`,
      message: `Two steps are worded ${Math.round(score * 100)}% the same, so Cucumber needs a separate step definition for each. If they mean the same thing, use one wording: "${a.examples[0]}" / "${b.examples[0]}".`,
    });
  }

  if (flaggedPairs.length > 6) {
    issues.push({
      kind: 'reuse',
      severity: 'info',
      message: `${flaggedPairs.length - 6} more near-identical step pairs were found but not listed.`,
    });
  }

  return {
    issues,
    metrics: {
      totalSteps,
      uniqueSteps: entries.length,
      // How often the average step definition gets reused. 1.0 means every step
      // is bespoke — the worst case for maintenance.
      reuseRatio: entries.length ? Number((totalSteps / entries.length).toFixed(2)) : 0,
      nearDuplicatePairs: flaggedPairs.length,
    },
  };
}

function inspectCucumber(scenarios) {
  const reuse = checkStepReuse(scenarios);
  return {
    issues: [
      ...checkStructure(scenarios),
      ...checkVoice(scenarios),
      ...checkStepSmells(scenarios),
      ...reuse.issues,
    ],
    metrics: reuse.metrics,
  };
}

module.exports = {
  inspectCucumber,
  normalizeStep,
  checkStructure,
  checkStepSmells,
  checkVoice,
  checkStepReuse,
};
