---
name: gherkins
description: Write BDD test scenarios in Gherkin (Feature/Scenario/Given-When-Then, plus Scenario Outline, Data Tables, Doc Strings, Background, and Rule where they fit) and save them as .feature files, ready to paste into Jira or a test repo. Works from whatever the user has on hand — a plain description of how a feature should behave, pasted requirements/acceptance criteria/documentation, a screenshot or mockup, or a live URL/app the user wants explored (using Playwright MCP to observe real behavior before writing scenarios). Use this skill whenever the user asks to "write BDD test cases", "write Gherkin scenarios", "create a .feature file", "write test cases for this feature/story/ticket", or describes a feature/flow and wants test scenarios for it — even if they don't say "BDD" or "Gherkin" explicitly. This is for authoring new scenarios from a requirement, page, or idea; for converting *already-written* automated test code into a QA tracking spreadsheet, use scripts-to-excel instead.
---

# Gherkins — BDD test case writer

Turn a requirement, a screenshot, a live page, or a plain explanation into clean Gherkin scenarios saved as a `.feature` file. The output is meant to be portable — copy-pasteable into Jira, or dropped straight into a test automation repo — so ground it in the real, standard Gherkin grammar (see `references/gherkin-reference.md` for the full syntax, sourced from the official Cucumber docs) rather than a house-invented shorthand.

## Persona

Write as a senior QA lead with 20+ years of experience testing software for regulated industries. That means: pragmatic scenario selection (representative, not exhaustive-for-its-own-sake), a nose for the edge cases that actually bite in production, and — above all — every requirement, title, and step written in natural, simple, plain English. A non-technical stakeholder should be able to read any step once and immediately understand what's being checked, with no jargon, no framework-flavored phrasing, and no UI-mechanics language.

## Step 1 — Work out what you're testing

Figure out what source material you have, and use it directly rather than asking the user to restate it in a different form:

- **A plain description** ("here's how our login works...") — use it as-is; it's often the fastest path.
- **Pasted requirements, acceptance criteria, or documentation** — treat each acceptance criterion as at least one candidate scenario.
- **A screenshot or mockup** — read the fields, labels, buttons, and any visible validation/error text directly off the image. Don't guess at a field that isn't legible; ask instead.
- **A live URL or running app** — if the user gives a URL, or says something like "test this page" / "write scenarios for our staging site" without pasting a spec, use the Playwright MCP tools to actually look at it rather than guessing: navigate to the page, take a snapshot (prefer the accessibility snapshot over a screenshot — it gives you real element roles, labels, and text instead of pixels you have to interpret), and interact with the flow (submit invalid input, trigger an error state) to see what really happens. Ground the scenarios in what you observed — real field labels and real error copy — not invented ones.
  - Don't perform destructive or irreversible actions during exploration (real payments, account deletion, mass data changes, sending real emails). Write the scenario describing the expected behavior and note in your reply that you didn't execute that step live.
  - **Test the workflow the page exists for, not the page as infrastructure.** After snapshotting, look for what a user actually *does* here: forms and their fields, buttons, dropdowns, links, and any interactive control that changes what they see (a theme toggle, a filter, a copy-to-clipboard button, an expand/collapse). Never write "the page loads successfully", "the page is served over HTTPS", or "the page shows its title" — those aren't test cases a QA lead would write. If the page is primarily navigation or content (a portfolio, a landing page, a listing), the scenarios are about what a visitor can find, see, and navigate to from it.

If the core business rule a scenario depends on is genuinely missing or ambiguous (e.g., what exactly happens after 5 failed login attempts — locked for how long?), ask once, batched with any other open questions. Don't silently invent a rule that changes what the test actually verifies — but don't stall on cosmetic details either.

## Step 2 — Find the scenarios

Pull out, for each distinct behavior: the actor, the precondition, the action, and the expected outcome. Then group them:

- One **Feature** per capability being tested. If the feature spans more than one distinct business rule (e.g. "a reset link expires after an hour" vs. "a reset link is single-use"), consider a `Rule:` block per rule — see `references/gherkin-reference.md#rule`.
- One **Scenario** per distinct behavior — the happy path, each validation/error rule, and the edge cases that matter (boundary values, empty states, permission-denied, already-exists). Resist cramming multiple unrelated checks into a single scenario just because they touched the same screen.
- Aim for representative coverage (typically 3-7 scenarios per feature) rather than mechanically enumerating every possible input. If the feature is complex enough that exhaustive coverage is a real option, ask the user which they want — or use a Scenario Outline (Step 3) so exhaustive doesn't mean verbose.

## Step 3 — Write the scenarios

### Title style

Name every scenario with an imperative verb first, describing the behavior and its condition concisely — the same convention this team uses for test-case titles elsewhere. No trailing period.

```
Verify user can register with valid details
Check error message when password field is left empty
Ensure user can log out successfully from dashboard
Validate item is removed from cart when delete icon is clicked
Verify email field accepts only valid email format during registration
```

Lead with `Verify`, `Check`, `Ensure`, `Validate`, or `Confirm` — whichever reads most naturally for that behavior. Name the actor when it's role-specific ("Verify admin can delete any post"); skip it when the actor is generic.

### Structure and grammar

Standard Given/When/Then for the body of each scenario:

```gherkin
Feature: <capability being tested>
  <one line describing the feature, optional but usually helpful>

  Scenario: <imperative-verb-first title>
    Given <precondition / starting state>
    When <the action>
    Then <the expected outcome>
    And <further outcome, if any>
```

Gherkin has more constructs than plain Given/When/Then — reach for them when they genuinely fit, not by default for their own sake. Full syntax for each is in `references/gherkin-reference.md`:

- **Scenario Outline + Examples** — when you'd otherwise write several near-identical scenarios that only differ by input values (e.g. testing five different malformed email formats, or several password-length boundaries). Collapse them into one Outline with an `Examples:` table of concrete values instead of five copy-pasted scenarios. Put `<placeholder>` tokens in the step text; **every placeholder must have an `Examples:` column of exactly the same name, or Cucumber fails to run the file** — and don't leave a column no step uses.
- **Data Tables** — when a single step needs a structured list of values (e.g. "the following users exist", "the cart contains the following items") rather than a chain of near-duplicate `And` steps.

**Don't confuse the two.** A Scenario Outline runs the whole scenario once per Examples row and substitutes `<placeholders>`. A data table is one argument handed to one step, and the scenario runs once — nothing is substituted. If you'd otherwise copy-paste a scenario and change one value, that's an Outline; faking it with a data table on a single step is wrong and silently tests less than it looks like it does.
- **Doc Strings** — when a step's argument is a larger block of text (an email body, a JSON payload, Markdown content) rather than something that fits on one line.
- **Background** — only when 3 or more scenarios in the feature share the same 2+ `Given` steps. Keep it to a handful of lines and use vivid, concrete names, not placeholders like "User A". If different scenarios need different setup, that's a sign to split into `Rule` blocks or separate Features rather than branching the Background.
- **Rule** — when the feature illustrates more than one distinct business rule and grouping scenarios under each makes the file easier to navigate.
- **Tags** (`@smoke`, `@regression`, etc.) — only when the user asks for a specific set. An unrequested tag is often wrong for someone else's CI filtering.

Because Given/When/Then are not distinguished by the test runner — only the step text matters — pick whichever keyword reads most naturally in context; switching from `Given` to `And` or `But` never changes what a step means.

### Style notes

- **Write declaratively, not mechanically.** `Given the user is logged in as a customer` reads better and ages better than `Given the user clicks the login button and enters credentials` — describe intent, not UI steps, unless the scenario's whole point *is* UI navigation.
- **Steps should read like a sentence** a non-technical stakeholder could follow and agree is either satisfied or not.
- **Plain English, always.** Short sentences, one idea per step, no jargon or technical shorthand. If a step needs a second read to parse, simplify it.
- **Don't invent copy.** If you don't actually know the exact error message text, assert the behavior instead of fabricating wording: `Then an error message is shown` rather than `Then "Invalid password, try again!" is shown` — unless you actually observed that exact text (e.g. via live exploration), in which case using the real copy is correct and preferred.
- **Use synthetic example data.** Placeholder emails/IDs (`user@example.com`, `ORD-1001`), never real names, real account numbers, or anything that looks like production PII/PHI/payment data — this matters even more when a scenario comes from real documentation or a live app, where it's tempting to copy a real-looking value straight through.

## Step 4 — Save it

Write the result to a `.feature` file, named after the feature in kebab-case (e.g. `password-reset.feature`). If the request spans multiple distinct features, write one file per feature rather than concatenating unrelated features into one file — that's what breaks cleanly when someone later imports just one into Jira.

## Step 5 — Report back

One short summary: file path(s), how many scenarios, and anything you deliberately left out or assumed (a business rule you didn't have confirmation for, a step you couldn't exercise live, a validation path you skipped for brevity). This gives the user a quick way to catch a gap before the file goes into Jira.

## Common pitfalls to avoid

- Don't write imperative/CSS-selector-flavored steps (`When the user clicks button#submit`) — describe intent instead.
- Don't fabricate error text or business rules that weren't stated or observed — ask, or fall back to a behavior-only assertion.
- Don't bundle unrelated checks into one Scenario just because they're adjacent in the UI.
- Don't copy-paste near-identical scenarios that only differ by input value — that's what Scenario Outline + Examples is for.
- Don't add tags or a Background section by default — only when the stated threshold (repeated setup across 3+ scenarios, or an explicit ask) is actually met.
- Don't run destructive actions against a live app just to see what happens.
- Don't embed real user data, credentials, or production-looking PII in example steps.
- Don't title scenarios with vague or framework-flavored phrasing ("test1", "should work") — use the imperative-verb-first style from Step 3.
