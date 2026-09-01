# Gherkin syntax reference

Grounded in the official Cucumber docs: https://cucumber.io/docs/gherkin/reference/

Read this file when a scenario needs a construct beyond plain Given/When/Then — Scenario Outline, a Data Table, a Doc String, Rule, or tags — to get the exact syntax right. SKILL.md covers when to reach for each one; this file covers how to write it.

## Table of contents

1. [Feature](#feature)
2. [Rule](#rule)
3. [Scenario / Example](#scenario--example)
4. [Steps: Given, When, Then, And, But](#steps-given-when-then-and-but)
5. [Step matching rules](#step-matching-rules)
6. [Background](#background)
7. [Scenario Outline + Examples](#scenario-outline--examples)
8. [Data Tables](#data-tables)
9. [Doc Strings](#doc-strings)
10. [Tags](#tags)
11. [Comments](#comments)
12. [Formatting rules](#formatting-rules)
13. [Spoken languages](#spoken-languages)

---

## Feature

The first keyword in every `.feature` file. One per file. A short free-form description can follow on the lines under it; that description ends as soon as a `Background`, `Rule`, `Scenario`, or `Scenario Outline` keyword appears.

```gherkin
Feature: Password reset
  Lets a user regain access to their account by resetting a forgotten password.
```

## Rule

Optional (Gherkin 6+). Groups the scenarios that illustrate one specific business rule, when a Feature spans more than one. Each `Rule` can have its own `Background`.

```gherkin
Rule: A reset link can only be used once

  Example: Reusing a consumed reset link fails
    Given a reset link that has already been used
    When the user opens it again
    Then they see a link-expired message
```

## Scenario / Example

`Scenario` and `Example` are exact synonyms — pick one convention and stay consistent within a file. Each is a concrete, executable illustration of a behavior.

```gherkin
Scenario: Verify user can register with valid details
  Given the registration form is open
  When the user submits valid name, email, and password
  Then the account is created and a welcome message is shown
```

See SKILL.md for the house title convention (imperative verb first).

## Steps: Given, When, Then, And, But

- **Given** — puts the system in a known starting state (context, preconditions). Written in past/perfect tense.
- **When** — the action or event under test. One `When` per scenario is a good default; more than one is a smell that the scenario is testing more than one behavior.
- **Then** — the expected, observable outcome. Assert what a user or external system could actually see — not an internal implementation detail (e.g. "the confirmation email is sent" rather than "a row is inserted in the emails table").
- **And / But** — continue the previous step's type without repeating the keyword. Purely for readability; carries no different meaning than the step it continues.

```gherkin
Given the user has an existing account
And the account is not locked
When they submit valid credentials
Then they are redirected to the dashboard
But no lockout warning is shown
```

An asterisk (`*`) can replace any step keyword for a bullet-style list where prose reads awkwardly (e.g. a shopping list of Givens) — rare in test scenarios, more common in living-documentation-style features.

## Step matching rules

Given/When/Then are not distinguished by the test runner — only the step text after the keyword matters. `Given there is money` and `Then there is money` map to the exact same step definition. This is why keyword choice is purely narrative: use whichever of Given/When/Then/And/But reads most naturally, and don't worry that switching keywords changes behavior.

## Background

Runs before every scenario in the Feature (or Rule) it belongs to. Exists to remove duplicated `Given` steps repeated across scenarios — not to hold setup only one or two scenarios need.

```gherkin
Feature: Blog posting

  Background:
    Given a logged-in user named "Greg"
    And a blog named "Greg's anti-tax rants"

  Scenario: Verify admin can publish to any blog
    When Greg posts to "Greg's anti-tax rants"
    Then the post is published
```

Rules and best practice from the Cucumber docs:
- At most one `Background` per `Feature`/`Rule`, placed before the first `Scenario`.
- Keep it short — around 4 lines or fewer is the guideline. A long Background buries the setup that actually matters for each scenario.
- Use vivid, concrete names ("Greg", "Greg's anti-tax rants") rather than placeholders like "User A" or "Site 1" — it reads better and is easier to keep straight across scenarios.
- If different groups of scenarios in one Feature need different setup, that's a sign to split into multiple `Rule` blocks (each with its own Background) or separate Features, not to cram conditionals into one Background.

## Scenario Outline + Examples

Alias: `Scenario Template`. Use when you would otherwise write several near-identical scenarios that only differ by input values. Placeholders in `<angle brackets>` are substituted from the `Examples:` table, once per data row (the header row itself doesn't run).

```gherkin
Scenario Outline: Validate email field rejects malformed addresses
  Given the registration form is open
  When the user enters "<email>" in the email field
  Then a "<message>" validation error is shown

  Examples:
    | email              | message                    |
    | plainaddress       | Enter a valid email        |
    | missing@domain     | Enter a valid email        |
    | @missingusername.io | Enter a valid email        |
```

- Every Scenario Outline needs at least one `Examples:` table; multiple `Examples:` blocks are allowed (useful for grouping, e.g. one block per category of invalid input, each with its own heading comment).
- Placeholders can appear in step text, and inside Doc Strings/Data Tables attached to a step.
- Don't reach for this when there's no real data variation — a Scenario Outline with a single Examples row is just a Scenario with extra ceremony.

## Data Tables

Attach structured, tabular data to a single step — for seeding several records, or asserting on a list/set of items — without inventing a Scenario Outline that doesn't fit (no repeated scenario execution here; the whole table is one argument to one step).

```gherkin
Given the following users exist:
  | name   | email             | role  |
  | Aslak  | aslak@example.com | admin |
  | Julien | julien@example.com | user |
```

Escaping inside table cells: `\n` for a newline, `\|` for a literal pipe, `\\` for a literal backslash.

Use a Data Table when a step needs a *list* of values (e.g. "the following items are in the cart") instead of chaining several near-duplicate `And` steps.

## Doc Strings

Pass one larger block of text as a step's argument — a document body, an email, a JSON/HTML payload — instead of squeezing it onto one line.

```gherkin
Given a blog post titled "Random" with the following Markdown body:
  """markdown
  # Some Title, Eh?
  Here is the first paragraph...
  """
```

Triple double-quotes or triple backticks both work; indentation inside the block is preserved. The optional word right after the opening `"""` (e.g. `markdown`, `json`) is a content-type hint some tooling uses for syntax highlighting — harmless to include, safe to omit.

## Tags

`@tag_name` above a `Feature`, `Rule`, or `Scenario` — used for filtering test runs (e.g. `@smoke`, `@regression`) or grouping regardless of file layout. Tags on a Feature apply to every scenario inside it.

```gherkin
@regression @checkout
Scenario: Validate item is removed from cart when delete icon is clicked
  ...
```

Per this skill's default (see SKILL.md), don't add tags unless the user asks for a specific set — an unrequested tag is often wrong for someone else's CI filtering setup.

## Comments

A line starting with `#` (leading whitespace is fine) is ignored by the parser. There's no block-comment syntax — every commented line needs its own `#`.

## Formatting rules

- Indent consistently (2 spaces is the common convention; tabs also work) — Gherkin is whitespace-sensitive for readability, not for parsing, but consistent indentation is what makes a `.feature` file skimmable.
- The colon after a keyword (`Feature:`, `Scenario:`, `Background:`, `Examples:`) is required — omit it and that block is silently not recognized as what you intended.

## Spoken languages

A `# language: xx` header (e.g. `# language: fr`) switches all keywords to that language's translation for the rest of the file (70+ languages supported). Default is English. Only relevant if the user's team writes features in a non-English language — don't add this header speculatively.
