// Offline test suite for the generator's own logic. Deliberately makes NO calls to
// Claude — it covers the deterministic parts where a regression would silently
// corrupt someone's test cases: step reconciliation, the quality checks, Gherkin
// export formatting, and type resolution.
//
//   npm test

const assert = require('assert');
const { reconcileSteps, formatStepsForPrompt } = require('../server/lib/revise');
const quality = require('../server/lib/quality');
const { resolveTypes, defaultTypeIds, tagForType, publicList } = require('../server/lib/testTypes');
const { scrubAction } = require('../server/lib/recorder');
const { detectUrl } = require('../server/lib/claudeCli');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, message: err.message });
    console.log(`  ✗ ${name}`);
    console.log(`      ${err.message}`);
  }
}

function group(name, fn) {
  console.log(`\n${name}`);
  fn();
}

const step = (id, keyword, text, included = true, dataTable = null) => ({ id, keyword, text, included, dataTable });
const scenario = (id, title, steps, extra = {}) => ({
  id,
  title,
  included: true,
  testType: 'happy-path',
  coversRequirementIds: [],
  steps,
  ...extra,
});

// ---------------------------------------------------------------------------
group('revise.reconcileSteps — unticked steps must never be lost', () => {
  const original = [
    step('a', 'Given', 'a user is logged in'),
    step('b', 'When', 'FROZEN must survive', false),
    step('c', 'Then', 'the dashboard is shown'),
  ];

  test('keeps a frozen step the model reproduced', () => {
    const out = reconcileSteps(original, [
      { keyword: 'Given', text: 'a customer is logged in' },
      { keyword: 'When', text: 'FROZEN must survive' },
      { keyword: 'Then', text: 'the dashboard is shown' },
    ]);
    assert.strictEqual(out.length, 3);
    const frozen = out.find((s) => s.text === 'FROZEN must survive');
    assert.ok(frozen, 'frozen step missing');
    assert.strictEqual(frozen.included, false, 'frozen step lost its unticked state');
  });

  test('restores a frozen step the model dropped', () => {
    const out = reconcileSteps(original, [
      { keyword: 'Given', text: 'a customer is logged in' },
      { keyword: 'Then', text: 'the dashboard is shown' },
    ]);
    const frozen = out.find((s) => s.text === 'FROZEN must survive');
    assert.ok(frozen, 'dropped frozen step was not restored');
    assert.strictEqual(frozen.included, false);
  });

  test('falls back to the original on an empty reply', () => {
    assert.strictEqual(reconcileSteps(original, []), original);
    assert.strictEqual(reconcileSteps(original, null), original);
    assert.strictEqual(reconcileSteps(original, [{ keyword: 'And', text: '   ' }]), original);
  });

  test('preserves step id and data table when text is unchanged', () => {
    const withTable = [step('t1', 'Given', 'these users exist', true, [['name'], ['Alice']])];
    const out = reconcileSteps(withTable, [{ keyword: 'Given', text: 'these users exist' }]);
    assert.strictEqual(out[0].id, 't1');
    assert.deepStrictEqual(out[0].dataTable, [['name'], ['Alice']]);
  });

  test('accepts genuinely new steps as ticked', () => {
    const out = reconcileSteps(original, [
      { keyword: 'Given', text: 'a user is logged in' },
      { keyword: 'When', text: 'FROZEN must survive' },
      { keyword: 'Then', text: 'the dashboard is shown' },
      { keyword: 'And', text: 'a welcome banner appears' },
    ]);
    assert.strictEqual(out.length, 4);
    assert.strictEqual(out[3].included, true);
  });

  test('tags steps [REVISE]/[KEEP] for the prompt', () => {
    const text = formatStepsForPrompt(original);
    assert.match(text, /1\. \[REVISE\] Given a user is logged in/);
    assert.match(text, /2\. \[KEEP\] When FROZEN must survive/);
  });
});

// ---------------------------------------------------------------------------
group('quality — duplicate detection', () => {
  const sameSteps = ['a registered customer', 'the customer signs in correctly', 'the dashboard opens'];

  test('flags two scenarios with identical steps', () => {
    const run = {
      requirements: [],
      scenarios: [
        scenario('s1', 'Verify user can log in with valid details', sameSteps.map((t, i) => step('a' + i, 'When', t))),
        scenario('s2', 'Verify a user signs in with correct details', sameSteps.map((t, i) => step('b' + i, 'When', t))),
      ],
    };
    assert.strictEqual(quality.inspect(run).counts.duplicate, 1);
  });

  test('does not flag genuinely different scenarios', () => {
    const run = {
      requirements: [],
      scenarios: [
        scenario('a', 'Verify error when password is wrong', [step('a1', 'When', 'the customer enters the wrong password'), step('a2', 'Then', 'an error message is shown')]),
        scenario('b', 'Verify error when password is empty', [step('b1', 'When', 'the customer leaves the password empty'), step('b2', 'Then', 'a message says the password is required')]),
        scenario('c', 'Verify account locks after five failures', [step('c1', 'When', 'the customer fails five times'), step('c2', 'Then', 'the account becomes locked')]),
      ],
    };
    assert.strictEqual(quality.inspect(run).counts.duplicate, undefined);
  });

  test('ignores unticked scenarios', () => {
    const run = {
      requirements: [],
      scenarios: [
        scenario('s1', 'Verify login', sameSteps.map((t, i) => step('a' + i, 'When', t))),
        scenario('s2', 'Verify login again', sameSteps.map((t, i) => step('b' + i, 'When', t)), { included: false }),
      ],
    };
    assert.strictEqual(quality.inspect(run).counts.duplicate, undefined);
  });
});

// ---------------------------------------------------------------------------
group('quality — coverage and requested types', () => {
  test('flags a requirement no scenario covers', () => {
    const run = {
      requirements: [{ id: 'r1', text: 'Covered' }, { id: 'r2', text: 'Not covered' }],
      scenarios: [scenario('s1', 'Verify a thing', [step('a', 'When', 'something happens')], { coversRequirementIds: ['r1'] })],
    };
    const report = quality.inspect(run);
    assert.strictEqual(report.counts['uncovered-requirement'], 1);
    assert.match(report.issues.find((i) => i.kind === 'uncovered-requirement').message, /Not covered/);
  });

  test('flags a requested type with no scenario', () => {
    const run = {
      selectedTypes: ['happy-path', 'security'],
      requirements: [],
      scenarios: [scenario('s1', 'Verify a thing', [step('a', 'When', 'something happens')])],
    };
    assert.strictEqual(quality.inspect(run).counts['missing-type'], 1);
  });

  test('stays quiet when every requested type is present', () => {
    const run = {
      selectedTypes: ['happy-path'],
      requirements: [],
      scenarios: [scenario('s1', 'Verify a thing', [step('a', 'When', 'something happens')])],
    };
    assert.strictEqual(quality.inspect(run).counts['missing-type'], undefined);
  });
});

// ---------------------------------------------------------------------------
group('quality — plain-English lint', () => {
  const lintOne = (text) => {
    const run = { requirements: [], scenarios: [scenario('s', 'Verify x', [step('a', 'When', text)])] };
    return quality.inspect(run).issues.filter((i) => i.kind === 'language');
  };

  test('flags a click', () => assert.ok(lintOne('the user clicks the Save button').length));
  test('flags a selector', () => assert.ok(lintOne('the user submits button#submit').length));
  test('flags HTTP mechanics', () => assert.ok(lintOne('a POST /api/login returns HTTP 401').length));
  test('flags spec-speak', () => assert.ok(lintOne('the system shall record the attempt').length));
  test('flags a hardcoded URL', () => assert.ok(lintOne('the user navigates to https://example.com/login').length));
  test('flags an overlong step', () =>
    assert.ok(lintOne('the customer completes the payment and the receipt is emailed and the stock is reduced and the audit log is written and the dashboard updates immediately').length));
  test('leaves clean plain English alone', () =>
    assert.strictEqual(lintOne('the customer signs in with a valid password').length, 0));
});

// ---------------------------------------------------------------------------
group('testTypes', () => {
  test('has four defaults on', () => assert.strictEqual(defaultTypeIds().length, 4));

  test('resolveTypes keeps only known ids', () => {
    const out = resolveTypes(['happy-path', 'not-a-real-type', 'security']);
    assert.deepStrictEqual(out.map((t) => t.id), ['happy-path', 'security']);
  });

  test('resolveTypes falls back to defaults on empty or junk input', () => {
    assert.deepStrictEqual(resolveTypes([]).map((t) => t.id), defaultTypeIds());
    assert.deepStrictEqual(resolveTypes(null).map((t) => t.id), defaultTypeIds());
    assert.deepStrictEqual(resolveTypes(['nope']).map((t) => t.id), defaultTypeIds());
  });

  test('every type has a distinct Gherkin tag', () => {
    const tags = publicList().map((t) => t.tag);
    assert.strictEqual(new Set(tags).size, tags.length);
    tags.forEach((t) => assert.match(t, /^@[a-z-]+$/));
  });

  test('guidance is not exposed to the client', () => {
    publicList().forEach((t) => assert.strictEqual(t.guidance, undefined));
  });

  test('tagForType handles an unknown id', () => assert.strictEqual(tagForType('nope'), null));
});

// ---------------------------------------------------------------------------
group('export — Gherkin formatting', () => {
  // The route module builds its own express router, so exercise the pure helpers
  // by re-requiring the file and pulling the text builder out via a fake run.
  const { toFeatureText, dataTableLines } = require('../server/lib/gherkin');

  test('renders a scenario with its type tag', () => {
    const run = {
      featureTitle: 'Login',
      featureDescription: 'Users sign in',
      scenarios: [scenario('s1', 'Verify a customer can sign in', [step('a', 'Given', 'a registered customer'), step('b', 'Then', 'the dashboard opens')])],
    };
    const text = toFeatureText(run);
    assert.match(text, /^Feature: Login/m);
    assert.match(text, /^ {2}@happy-path$/m);
    assert.match(text, /^ {2}Scenario: Verify a customer can sign in$/m);
    assert.match(text, /^ {4}Given a registered customer$/m);
  });

  test('omits unticked scenarios and steps', () => {
    const run = {
      featureTitle: 'Login',
      scenarios: [
        scenario('s1', 'Kept', [step('a', 'Given', 'kept step'), step('b', 'And', 'dropped step', false)]),
        scenario('s2', 'Dropped', [step('c', 'Given', 'nope')], { included: false }),
      ],
    };
    const text = toFeatureText(run);
    assert.ok(text.includes('kept step'));
    assert.ok(!text.includes('dropped step'));
    assert.ok(!text.includes('Scenario: Dropped'));
  });

  test('aligns data table columns', () => {
    const lines = dataTableLines([['name', 'role'], ['Alice', 'admin'], ['Bo', 'viewer']], '      ');
    assert.strictEqual(lines[0], '      | name  | role   |');
    assert.strictEqual(lines[1], '      | Alice | admin  |');
    assert.strictEqual(lines[2], '      | Bo    | viewer |');
  });

  test('escapes pipes and newlines inside a cell', () => {
    const lines = dataTableLines([['a|b'], ['c\nd']], '');
    assert.ok(lines[0].includes('a\\|b'), 'pipe not escaped');
    assert.ok(lines[1].includes('c\\nd'), 'newline not escaped');
  });
});

// ---------------------------------------------------------------------------
group('placeholders — Scenario Outline plumbing', () => {
  const {
    placeholdersInScenario, exampleHeaders, exampleRowCount,
    renamePlaceholder, normalizeExamples, isOutline,
  } = require('../server/lib/placeholders');

  const outline = () => ({
    id: 'o1',
    title: 'Verify each nav link opens its section',
    included: true,
    isOutline: true,
    examples: [['navigation link', 'section'], ['Home', 'Introduction'], ['About', 'About me']],
    steps: [
      step('a', 'Given', 'a visitor is on the homepage'),
      step('b', 'When', 'they select the <navigation link> link'),
      step('c', 'Then', 'the <section> section opens'),
    ],
  });

  test('finds placeholders across steps', () => {
    assert.deepStrictEqual(placeholdersInScenario(outline()).sort(), ['navigation link', 'section']);
  });

  test('finds placeholders inside a data table cell', () => {
    const s = { steps: [step('a', 'Given', 'these rows', true, [['col'], ['<value>']])] };
    assert.deepStrictEqual(placeholdersInScenario(s), ['value']);
  });

  test('reads headers and counts data rows (not the header)', () => {
    assert.deepStrictEqual(exampleHeaders(outline()), ['navigation link', 'section']);
    assert.strictEqual(exampleRowCount(outline()), 2);
  });

  test('isOutline requires both the flag and a real placeholder', () => {
    assert.ok(isOutline(outline()));
    const noPlaceholders = { ...outline(), steps: [step('a', 'Given', 'nothing to substitute')] };
    assert.strictEqual(isOutline(noPlaceholders), false);
    assert.strictEqual(isOutline({ ...outline(), isOutline: false }), false);
  });

  test('renaming a placeholder rewrites every step that uses it', () => {
    const s = outline();
    renamePlaceholder(s, 'navigation link', 'menu item');
    assert.strictEqual(s.steps[1].text, 'they select the <menu item> link');
    assert.strictEqual(s.steps[2].text, 'the <section> section opens', 'unrelated placeholder was touched');
  });

  test('renaming rewrites placeholders inside data tables too', () => {
    const s = { steps: [step('a', 'Given', 'rows', true, [['col'], ['<old>']])] };
    renamePlaceholder(s, 'old', 'new');
    assert.strictEqual(s.steps[0].dataTable[1][0], '<new>');
  });

  test('normalizeExamples pads ragged rows and rejects junk', () => {
    assert.deepStrictEqual(normalizeExamples([['a', 'b'], ['1']]), [['a', 'b'], ['1', '']]);
    assert.strictEqual(normalizeExamples([]), null);
    assert.strictEqual(normalizeExamples(null), null);
  });
});

// ---------------------------------------------------------------------------
group('quality — Scenario Outline validation', () => {
  const kinds = (run) => quality.inspect(run).issues.filter((i) => i.kind === 'outline');

  test('errors on a placeholder with no Examples column (the <password> case)', () => {
    const run = {
      requirements: [],
      scenarios: [{
        id: 's1', title: 'Verify login by role', included: true, isOutline: true,
        examples: [['user'], ['Instructor'], ['Student']],
        steps: [
          step('a', 'When', '<user> types the user name'),
          step('b', 'And', '<password> in the fields'),
        ],
      }],
    };
    const errs = kinds(run).filter((i) => i.severity === 'error');
    assert.strictEqual(errs.length, 1);
    assert.match(errs[0].message, /<password>.*no "password" column/);
  });

  test('errors on placeholders in a non-outline scenario', () => {
    const run = {
      requirements: [],
      scenarios: [{ id: 's1', title: 'Verify x', included: true, isOutline: false, examples: null, steps: [step('a', 'When', 'the <thing> happens')] }],
    };
    assert.ok(kinds(run).some((i) => i.severity === 'error' && /isn't a Scenario Outline/.test(i.message)));
  });

  test('errors on an outline with no Examples rows', () => {
    const run = {
      requirements: [],
      scenarios: [{ id: 's1', title: 'Verify x', included: true, isOutline: true, examples: [['thing']], steps: [step('a', 'When', 'the <thing> happens')] }],
    };
    assert.ok(kinds(run).some((i) => /no Examples rows/.test(i.message)));
  });

  test('flags an unused Examples column', () => {
    const run = {
      requirements: [],
      scenarios: [{ id: 's1', title: 'Verify x', included: true, isOutline: true, examples: [['thing', 'spare'], ['a', 'b'], ['c', 'd']], steps: [step('a', 'When', 'the <thing> happens')] }],
    };
    assert.ok(kinds(run).some((i) => /column "spare" that no step uses/.test(i.message)));
  });

  test('a correct outline produces no outline issues', () => {
    const run = {
      requirements: [],
      scenarios: [{
        id: 's1', title: 'Verify each nav link opens its section', included: true, isOutline: true,
        examples: [['navigation link', 'section'], ['Home', 'Introduction'], ['About', 'About me']],
        steps: [step('a', 'When', 'they select the <navigation link> link'), step('b', 'Then', 'the <section> section opens')],
      }],
    };
    assert.deepStrictEqual(kinds(run), []);
  });
});

// ---------------------------------------------------------------------------
group('export — Scenario Outline rendering', () => {
  const { toFeatureText } = require('../server/lib/gherkin');

  const run = {
    featureTitle: 'Navigation',
    scenarios: [{
      id: 's1', title: 'Verify each nav link opens its section', included: true,
      testType: 'happy-path', isOutline: true,
      examples: [['navigation link', 'section'], ['Home', 'Introduction'], ['About', 'About me']],
      steps: [step('a', 'Given', 'a visitor is on the homepage'), step('b', 'When', 'they select the <navigation link> link'), step('c', 'Then', 'the <section> section opens')],
    }],
  };

  test('emits "Scenario Outline" and an Examples block', () => {
    const text = toFeatureText(run);
    assert.match(text, /^ {2}Scenario Outline: Verify each nav link opens its section$/m);
    assert.match(text, /^ {4}Examples:$/m);
    assert.match(text, /^ {6}\| navigation link \| section {6}\|$/m);
    assert.match(text, /^ {6}\| Home {12}\| Introduction \|$/m);
  });

  test('marks which page each group came from when a run spans pages', () => {
    const multi = {
      featureTitle: 'Catalogue',
      scenarios: [
        { id: 'a', title: 'Verify listing loads', included: true, page: 'https://x.test/list', steps: [step('1', 'Then', 'the list is shown')] },
        { id: 'b', title: 'Verify detail loads', included: true, page: 'https://x.test/item', steps: [step('2', 'Then', 'the item is shown')] },
      ],
    };
    const text = toFeatureText(multi);
    assert.match(text, /^ {2}# Page: https:\/\/x\.test\/list$/m);
    assert.match(text, /^ {2}# Page: https:\/\/x\.test\/item$/m);
  });

  test('omits page comments when every scenario is from one page', () => {
    const single = {
      featureTitle: 'Catalogue',
      scenarios: [
        { id: 'a', title: 'Verify listing loads', included: true, page: 'https://x.test/list', steps: [step('1', 'Then', 'the list is shown')] },
        { id: 'b', title: 'Verify filter works', included: true, page: 'https://x.test/list', steps: [step('2', 'Then', 'the filter applies')] },
      ],
    };
    assert.ok(!toFeatureText(single).includes('# Page:'));
  });

  test('keeps placeholders verbatim in the step text', () => {
    assert.match(toFeatureText(run), /^ {4}When they select the <navigation link> link$/m);
  });

  test('falls back to plain "Scenario" when the outline has no placeholders', () => {
    const plainish = {
      featureTitle: 'F',
      scenarios: [{ ...run.scenarios[0], steps: [step('a', 'Given', 'no placeholders here')] }],
    };
    const text = toFeatureText(plainish);
    assert.match(text, /^ {2}Scenario: /m);
    assert.ok(!text.includes('Examples:'), 'emitted an Examples block for a non-parameterised scenario');
  });

  test('falls back to plain "Scenario" when Examples has only a header row', () => {
    const noRows = {
      featureTitle: 'F',
      scenarios: [{ ...run.scenarios[0], examples: [['navigation link', 'section']] }],
    };
    assert.match(toFeatureText(noRows), /^ {2}Scenario: /m);
  });
});

// ---------------------------------------------------------------------------
group('featureParser — importing a .feature file', () => {
  const { parseFeature, splitTableRow } = require('../server/lib/featureParser');
  const { toFeatureText } = require('../server/lib/gherkin');

  test('splits table rows and unescapes pipes, backslashes and newlines', () => {
    assert.deepStrictEqual(splitTableRow('| a | b |'), ['a', 'b']);
    assert.deepStrictEqual(splitTableRow('| a \\| b | c |'), ['a | b', 'c']);
    assert.deepStrictEqual(splitTableRow('| line\\nbreak |'), ['line\nbreak']);
    assert.deepStrictEqual(splitTableRow('| back\\\\slash |'), ['back\\slash']);
  });

  test('parses feature title, description and a plain scenario', () => {
    const r = parseFeature([
      'Feature: Login',
      '  Users can sign in to the app',
      '',
      '  Scenario: Verify a user can sign in',
      '    Given a registered user',
      '    When they sign in',
      '    Then they reach the dashboard',
    ].join('\n'));

    assert.strictEqual(r.featureTitle, 'Login');
    assert.strictEqual(r.featureDescription, 'Users can sign in to the app');
    assert.strictEqual(r.scenarios.length, 1);
    assert.deepStrictEqual(
      r.scenarios[0].steps.map((s) => `${s.keyword} ${s.text}`),
      ['Given a registered user', 'When they sign in', 'Then they reach the dashboard']
    );
  });

  test('maps a @tag back to its test type', () => {
    const r = parseFeature('Feature: F\n  @security\n  Scenario: S\n    Given x');
    assert.strictEqual(r.scenarios[0].testType, 'security');
  });

  test('parses a Scenario Outline with its Examples table', () => {
    const r = parseFeature([
      'Feature: Nav',
      '  Scenario Outline: Verify each link opens its section',
      '    When they select the <navigation link> link',
      '    Then the <section> section opens',
      '',
      '    Examples:',
      '      | navigation link | section      |',
      '      | Home            | Introduction |',
      '      | About           | About me     |',
    ].join('\n'));

    const s = r.scenarios[0];
    assert.strictEqual(s.isOutline, true);
    assert.deepStrictEqual(s.examples, [
      ['navigation link', 'section'],
      ['Home', 'Introduction'],
      ['About', 'About me'],
    ]);
  });

  test('attaches a data table to the step above it, not to Examples', () => {
    const r = parseFeature([
      'Feature: F',
      '  Scenario: S',
      '    Given the following users exist',
      '      | name  | role   |',
      '      | Alice | admin  |',
      '    When they sign in',
    ].join('\n'));

    const [given, when] = r.scenarios[0].steps;
    assert.deepStrictEqual(given.dataTable, [['name', 'role'], ['Alice', 'admin']]);
    assert.strictEqual(when.dataTable, null);
  });

  test('copies Background steps into every scenario and says so', () => {
    const r = parseFeature([
      'Feature: F',
      '  Background:',
      '    Given the app is open',
      '  Scenario: A',
      '    When x',
      '  Scenario: B',
      '    When y',
    ].join('\n'));

    assert.strictEqual(r.scenarios.length, 2);
    assert.strictEqual(r.scenarios[0].steps[0].text, 'the app is open');
    assert.strictEqual(r.scenarios[1].steps[0].text, 'the app is open');
    assert.ok(r.warnings.some((w) => /Background/.test(w)));
  });

  test('flattens Rule blocks and keeps their scenarios', () => {
    const r = parseFeature([
      'Feature: F',
      '  Rule: A link is single use',
      '    Example: Reusing a link fails',
      '      When they reuse it',
      '      Then it is refused',
    ].join('\n'));

    assert.strictEqual(r.scenarios.length, 1);
    assert.strictEqual(r.scenarios[0].title, 'Reusing a link fails');
    assert.ok(r.warnings.some((w) => /Rule/.test(w)));
  });

  test('ignores comments and blank lines', () => {
    const r = parseFeature('# a comment\nFeature: F\n\n  # another\n  Scenario: S\n    Given x');
    assert.strictEqual(r.scenarios.length, 1);
    assert.strictEqual(r.scenarios[0].steps.length, 1);
  });

  test('treats * as a step bullet', () => {
    const r = parseFeature('Feature: F\n  Scenario: S\n    * something happens');
    assert.strictEqual(r.scenarios[0].steps[0].keyword, 'And');
    assert.strictEqual(r.scenarios[0].steps[0].text, 'something happens');
  });

  test('demotes an outline that has no Examples rows', () => {
    const r = parseFeature('Feature: F\n  Scenario Outline: S\n    When <x> happens');
    assert.strictEqual(r.scenarios[0].isOutline, false);
    assert.ok(r.warnings.some((w) => /no Examples rows/.test(w)));
  });

  test('round-trips a file this app exported', () => {
    const original = {
      featureTitle: 'Checkout',
      featureDescription: 'Paying for an order',
      scenarios: [
        {
          id: 'a', title: 'Verify a card payment succeeds', included: true,
          testType: 'happy-path', isOutline: false, examples: null,
          steps: [step('s1', 'Given', 'a shopper at checkout'), step('s2', 'Then', 'the payment succeeds')],
        },
        {
          id: 'b', title: 'Verify each invalid card is refused', included: true,
          testType: 'validation', isOutline: true,
          examples: [['card number', 'reason'], ['4000 0000', 'declined'], ['1234', 'too short']],
          steps: [step('s3', 'When', 'they pay with <card number>'), step('s4', 'Then', 'it is refused because it is <reason>')],
        },
      ],
    };

    const reparsed = parseFeature(toFeatureText(original));

    assert.strictEqual(reparsed.featureTitle, 'Checkout');
    assert.strictEqual(reparsed.scenarios.length, 2);
    assert.strictEqual(reparsed.scenarios[0].testType, 'happy-path');
    assert.strictEqual(reparsed.scenarios[1].testType, 'validation');
    assert.strictEqual(reparsed.scenarios[1].isOutline, true);
    assert.deepStrictEqual(reparsed.scenarios[1].examples, original.scenarios[1].examples);
    assert.deepStrictEqual(
      reparsed.scenarios[1].steps.map((s) => `${s.keyword} ${s.text}`),
      ['When they pay with <card number>', 'Then it is refused because it is <reason>']
    );
  });

  test('survives an empty or junk file without throwing', () => {
    assert.strictEqual(parseFeature('').scenarios.length, 0);
    assert.strictEqual(parseFeature('just some prose\nwith no keywords').scenarios.length, 0);
    assert.strictEqual(parseFeature(null).scenarios.length, 0);
  });
});

// ---------------------------------------------------------------------------
group('cucumberChecks — Cucumber-specific quality', () => {
  const {
    normalizeStep, checkStructure, checkStepSmells, checkVoice, checkStepReuse,
  } = require('../server/lib/cucumberChecks');

  const scn = (id, title, steps) => ({ id, title, included: true, steps });
  const messages = (issues) => issues.map((i) => i.message).join(' | ');

  test('normalizes literals the way Cucumber Expressions do', () => {
    assert.strictEqual(normalizeStep('the customer enters "a@b.com"'), 'the customer enters {string}');
    assert.strictEqual(normalizeStep('they wait 30 minutes'), 'they wait {int} minutes');
    assert.strictEqual(normalizeStep('the <role> signs in'), 'the {param} signs in');
    // Different literals must collapse to the SAME definition.
    assert.strictEqual(
      normalizeStep('enters "alice@example.com"'),
      normalizeStep('enters "bob@test.com"')
    );
  });

  test('flags a scenario with no Then', () => {
    const issues = checkStructure([scn('a', 'Verify x', [step('1', 'Given', 'a user'), step('2', 'When', 'they act')])]);
    assert.match(messages(issues), /no Then step/);
  });

  test('flags a Then placed before its When', () => {
    const issues = checkStructure([scn('a', 'Verify x', [
      step('1', 'Then', 'an error is shown'), step('2', 'When', 'they act'),
    ])]);
    assert.match(messages(issues), /Then before its When/);
  });

  test('flags two When blocks as two behaviours', () => {
    const issues = checkStructure([scn('a', 'Verify x', [
      step('1', 'When', 'they add an item'), step('2', 'Then', 'the cart updates'),
      step('3', 'When', 'they remove it'), step('4', 'Then', 'the cart is empty'),
    ])]);
    assert.match(messages(issues), /2 separate When blocks/);
  });

  test('flags setup that arrives after the action', () => {
    const issues = checkStructure([scn('a', 'Verify x', [
      step('1', 'When', 'they act'), step('2', 'Given', 'a precondition'), step('3', 'Then', 'it works'),
    ])]);
    assert.match(messages(issues), /Given after the action/);
  });

  test('accepts a well-formed scenario silently', () => {
    const issues = checkStructure([scn('a', 'Verify x', [
      step('1', 'Given', 'the customer has an unpaid order'),
      step('2', 'When', 'they pay for it'),
      step('3', 'Then', 'the order is marked paid'),
    ])]);
    assert.deepStrictEqual(issues, []);
  });

  test('flags "should", vague assertions and testing verbs in a Then', () => {
    const smells = (text) => messages(checkStepSmells([scn('a', 'T', [
      step('1', 'When', 'they act'), step('2', 'Then', text),
    ])]));
    assert.match(smells('the order should be placed'), /"should"/);
    assert.match(smells('the page loads correctly'), /vague/);
    assert.match(smells('verify the total is updated'), /act of testing/);
  });

  test('flags two actions joined by "and" in one step', () => {
    const issues = checkStepSmells([scn('a', 'T', [
      step('1', 'When', 'they enter their details and submit the form'),
    ])]);
    assert.match(messages(issues), /joins two actions/);
  });

  test('leaves clean Cucumber steps alone', () => {
    const issues = checkStepSmells([scn('a', 'T', [
      step('1', 'Given', 'the customer has an unpaid order'),
      step('2', 'When', 'the customer pays with a valid card'),
      step('3', 'Then', 'the order is marked as paid'),
    ])]);
    assert.deepStrictEqual(issues, []);
  });

  test('flags a mixed actor noun across the suite', () => {
    const issues = checkVoice([
      scn('a', 'T', [step('1', 'Given', 'the user is signed in'), step('2', 'Then', 'it opens')]),
      scn('b', 'T', [step('3', 'Given', 'the customer is signed in'), step('4', 'Then', 'it opens')]),
    ]);
    assert.match(messages(issues), /mixes "user", "customer"/);
  });

  test('does not flag genuinely different roles', () => {
    const issues = checkVoice([
      scn('a', 'T', [step('1', 'Given', 'the admin is signed in'), step('2', 'Then', 'it opens')]),
      scn('b', 'T', [step('3', 'Given', 'the instructor is signed in'), step('4', 'Then', 'it opens')]),
    ]);
    assert.deepStrictEqual(issues, []);
  });

  test('flags first person mixed with third person', () => {
    const issues = checkVoice([
      scn('a', 'T', [step('1', 'Given', 'I am signed in'), step('2', 'Then', 'it opens')]),
      scn('b', 'T', [step('3', 'Given', 'the customer is signed in'), step('4', 'Then', 'it opens')]),
    ]);
    assert.match(messages(issues), /first person/);
  });

  test('counts reuse: identical shapes share one step definition', () => {
    const { metrics } = checkStepReuse([
      scn('a', 'T', [step('1', 'When', 'the customer enters "alice@example.com"'), step('2', 'Then', 'it opens')]),
      scn('b', 'T', [step('3', 'When', 'the customer enters "bob@test.com"'), step('4', 'Then', 'it opens')]),
    ]);
    assert.strictEqual(metrics.totalSteps, 4);
    assert.strictEqual(metrics.uniqueSteps, 2, 'quoted literals should collapse to one definition');
    assert.strictEqual(metrics.reuseRatio, 2);
  });

  const reusePair = (t1, t2) => checkStepReuse([
    scn('a', 'T', [step('1', 'Then', t1)]),
    scn('b', 'T', [step('2', 'Then', t2)]),
  ]).metrics.nearDuplicatePairs;

  test('flags near-verbatim step wording that needs unifying', () => {
    assert.strictEqual(
      reusePair(
        'the enrolment is recorded against the student account',
        'the enrolment is recorded against the students account'
      ),
      1
    );
  });

  // Regression: word overlap treats "not" as an ordinary token, so an earlier
  // version scored "is enrolled" and "is not enrolled" as 100% identical.
  test('never flags opposites as duplicates', () => {
    assert.strictEqual(reusePair('the student is enrolled in the course', 'the student is not enrolled in the course'), 0);
    assert.strictEqual(reusePair('the instructor has created a course', 'the instructor has no course'), 0);
    assert.strictEqual(reusePair('the order is placed', 'the order is refused'), 0);
  });

  test('does not flag same-shape steps with different verbs', () => {
    assert.strictEqual(reusePair('the course is not changed', 'the course is not created'), 0);
  });

  test('does not flag a short step that is a subset of a much longer one', () => {
    const { metrics } = checkStepReuse([
      scn('a', 'T', [step('1', 'Then', 'the order is placed')]),
      scn('b', 'T', [step('2', 'Then', 'the order is placed successfully with a confirmation email and a printed receipt')]),
    ]);
    assert.strictEqual(metrics.nearDuplicatePairs, 0);
  });

  test('does not flag genuinely distinct steps', () => {
    const { metrics } = checkStepReuse([
      scn('a', 'T', [step('1', 'Given', 'the customer is signed in')]),
      scn('b', 'T', [step('2', 'Given', 'the customer has items in the cart')]),
      scn('c', 'T', [step('3', 'Then', 'the payment is declined')]),
    ]);
    assert.strictEqual(metrics.nearDuplicatePairs, 0);
  });

  test('ignores unticked scenarios and steps', () => {
    const { metrics } = checkStepReuse([
      { id: 'a', title: 'T', included: false, steps: [step('1', 'Given', 'ignored')] },
      { id: 'b', title: 'T', included: true, steps: [step('2', 'Given', 'counted'), { ...step('3', 'Given', 'skipped'), included: false }] },
    ]);
    assert.strictEqual(metrics.totalSteps, 1);
  });
});

// ---------------------------------------------------------------------------
group('recorder — sensitive-field scrub (server/lib/recorder.js)', () => {
  test('a field explicitly marked sensitive never carries a value through', () => {
    const scrubbed = scrubAction({ type: 'fill', role: 'textbox', name: 'Password', sensitive: true, value: 'whatever' });
    assert.strictEqual(scrubbed.sensitive, true);
    assert.strictEqual(scrubbed.value, undefined);
  });

  test('an ordinary typed value passes through unredacted', () => {
    const scrubbed = scrubAction({ type: 'fill', role: 'textbox', name: 'Email', value: 'alice@example.com' });
    assert.strictEqual(scrubbed.value, 'alice@example.com');
  });

  test('a credit-card-shaped value is redacted even without a sensitive flag', () => {
    const scrubbed = scrubAction({ type: 'fill', role: 'textbox', name: 'Card number', value: '4111 1111 1111 1111' });
    assert.strictEqual(scrubbed.value, '(redacted)');
  });

  test('an SSN-shaped value is redacted', () => {
    const scrubbed = scrubAction({ type: 'fill', role: 'textbox', name: 'SSN', value: '123-45-6789' });
    assert.strictEqual(scrubbed.value, '(redacted)');
  });

  test('a long token-shaped value is redacted', () => {
    const scrubbed = scrubAction({ type: 'fill', role: 'textbox', name: 'API key', value: 'sk_live_abcdefghijklmnopqrstuvwx' });
    assert.strictEqual(scrubbed.value, '(redacted)');
  });

  test('a clicked element whose accessible name looks like a card number is redacted too', () => {
    const scrubbed = scrubAction({ type: 'click', role: 'button', name: '4111 1111 1111 1111' });
    assert.strictEqual(scrubbed.name, '(redacted)');
  });

  test('an ordinary clicked element name passes through', () => {
    const scrubbed = scrubAction({ type: 'click', role: 'button', name: 'Log in' });
    assert.strictEqual(scrubbed.name, 'Log in');
  });

  test('unknown/extra fields on the raw action are dropped, not passed through blindly', () => {
    const scrubbed = scrubAction({ type: 'click', role: 'button', name: 'Log in', __proto__: { polluted: true }, extra: 'nope' });
    assert.strictEqual(scrubbed.extra, undefined);
  });

  test('a navigate action keeps its URL', () => {
    const scrubbed = scrubAction({ type: 'navigate', url: 'https://example.com/dashboard' });
    assert.strictEqual(scrubbed.url, 'https://example.com/dashboard');
  });

  test('an overlong value is truncated', () => {
    const scrubbed = scrubAction({ type: 'fill', role: 'textbox', name: 'Bio', value: 'x'.repeat(1000) });
    assert.ok(scrubbed.value.length <= 500);
  });

  test('an assert-value on a field marked sensitive never carries a value through', () => {
    const scrubbed = scrubAction({ type: 'assert-value', role: 'textbox', name: 'Password', sensitive: true });
    assert.strictEqual(scrubbed.sensitive, true);
    assert.strictEqual(scrubbed.value, undefined);
  });

  test('an assert-text value passes through when not secret-shaped', () => {
    const scrubbed = scrubAction({ type: 'assert-text', role: 'status', name: 'Total', value: '$42.00' });
    assert.strictEqual(scrubbed.value, '$42.00');
  });

  test('an assert-snapshot value is redacted if it happens to contain a card-shaped number', () => {
    const scrubbed = scrubAction({ type: 'assert-snapshot', role: 'region', name: 'Summary', value: '- text: "4111 1111 1111 1111"' });
    assert.strictEqual(scrubbed.value, '(redacted)');
  });
});

// ---------------------------------------------------------------------------
group('detectUrl — bare domains, not just full URLs (server/lib/claudeCli.js)', () => {
  test('a bare domain with no protocol is detected and normalized to https', () => {
    const result = detectUrl('learnwithice.com');
    assert.strictEqual(result.url, 'https://learnwithice.com');
    assert.strictEqual(result.extraContext, '');
  });

  test('a full https URL still works exactly as before', () => {
    const result = detectUrl('https://example.com/login');
    assert.strictEqual(result.url, 'https://example.com/login');
  });

  test('a bare domain alongside prose is still detected, with the prose kept as context', () => {
    const result = detectUrl('please test learnwithice.com thoroughly');
    assert.strictEqual(result.url, 'https://learnwithice.com');
    assert.ok(result.extraContext.includes('please test'));
    assert.ok(result.extraContext.includes('thoroughly'));
  });

  test('a bare www-prefixed domain is detected', () => {
    const result = detectUrl('www.example.com');
    assert.strictEqual(result.url, 'https://www.example.com');
  });

  test('plain text with no domain-like token returns null', () => {
    assert.strictEqual(detectUrl('users can reset their password'), null);
  });

  test('a two-letter abbreviation like "e.g." is not mistaken for a domain', () => {
    assert.strictEqual(detectUrl('e.g. this is a test'), null);
  });

  test('an ordinary filename in requirement text is not mistaken for a domain', () => {
    assert.strictEqual(detectUrl('update the config.json file when the user saves settings'), null);
  });

  test('a dotted field reference in requirement text is not mistaken for a domain', () => {
    assert.strictEqual(detectUrl('validate that order.total matches the sum of line items'), null);
  });

  test('a domain using a less common but real TLD is still detected', () => {
    const result = detectUrl('check out staging.myapp.io before release');
    assert.strictEqual(result.url, 'https://staging.myapp.io');
  });
});

// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(52)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(`  ${f.name}: ${f.message}`));
}
process.exit(failed ? 1 : 0);
