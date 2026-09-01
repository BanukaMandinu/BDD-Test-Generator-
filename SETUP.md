# BDD Test Generator — Setup

Writes BDD test cases (Gherkin) from a link to a page, or from a plain description.
Runs entirely on your own machine.

---

## What you need first

| | |
|---|---|
| **Node.js 18+** | [nodejs.org](https://nodejs.org) — take the LTS installer |
| **Claude Code**, signed in | [claude.com/claude-code](https://claude.com/claude-code). After installing, open a terminal, run `claude`, and sign in once. Then close it. |

You do **not** need an API key. The app uses whatever Claude account you signed into Claude Code with.

---

## Setup (2 minutes)

1. Unzip the folder anywhere.
2. Double-click **`start.bat`**.

That's it. The first run installs dependencies (about a minute), then opens the app at
**http://localhost:4173** in your browser.

A second window opens and stays open — that's the server. **Leave it running.** Close it when you're done.

<details>
<summary>Prefer the terminal?</summary>

```bash
cd TestGenerator
npm install
npm start
```
</details>

---

## Your first test cases

1. In the box, paste **either**:
   - a plain description — *"Users reset their password via an emailed link. The link expires after 1 hour."* → click **Generate test cases** directly.
   - a bare link to a page — `https://your-app.example.com/login` → click **Explore the whole site first** instead (a link on its own always goes through this; Generate stays disabled for it). Add a sentence of description alongside the link and Generate opens back up, using that text as context.
2. Watch the **Live activity** panel — it shows the browser opening the page, reading it, and writing.

A description takes under a minute. Exploring a site is usually 15–25 seconds; generating from the pages you pick is 1–3 minutes per page.

Then in **Test Cases** you can edit any step, tick/untick what to keep, write a review note on a
scenario and press **Update** to have it rewritten, or use **Update all** to apply one note across
everything. **Download ▾** gives you `.feature`, Excel, a traceability matrix, or a share file.

---

## Common things

**Explore a whole site instead of one page**
Click **Explore the whole site first**. It lists the pages it finds, you tick the ones you want, then
generate. Budget roughly 3 minutes per page.

**Pages behind a login**
Two ways in. If you have a **test account**, the fastest is **Options → Test username / password** plus
ticking **"Let it interact with the page"** — the agent signs in with exactly that pair and nothing
else. No test account? Open **Options → Borrow your Chrome session** and follow the three steps —
you copy a snippet, run it in the Chrome tab you're *already* signed into, and paste the result back.
Your password never leaves your browser either way — you never type it into this app, only into the
real site or the dedicated field the agent alone uses.

> Session-borrowing doesn't work on every site: browsers hide `HttpOnly` cookies from scripts. The app
> tells you what it captured. If the site uses those, run `npm run login` instead and sign in through
> the window it opens.

**Give it more to go on**
**Options → Extra instructions** — a free-text box for what the product is or which flow to focus on.
**Options → Upload product info** accepts a `.txt`, `.md`, `.pdf`, or `.docx` spec and drops its text
into that same box, labeled with the filename, so you can see and trim exactly what gets sent.

**Change what kinds of test it writes**
**Options → Kinds of test to write.** Happy path, negative, validation and edge cases are on by
default. Permissions, API, performance, security, accessibility and data integrity are opt-in.

**Someone sent you a `.feature` or `.testrun.json`**
**Options → Import a file someone sent you.** Drop it in — it becomes a new run you can review and
re-export. It won't overwrite anything you already have.

---

## If something goes wrong

| Symptom | Fix |
|---|---|
| `'npm' is not recognized` | Node.js isn't installed, or you need to reopen the terminal after installing it. |
| Warning about the `claude` CLI | Claude Code isn't installed or isn't signed in. Run `claude` once in a terminal and sign in. |
| "A server is already running" | It's already up — the script just opens your browser. To restart, close the server window first. |
| Generation fails immediately | Almost always Claude Code not being signed in. Run `claude` in a terminal to check. |
| Times out on a URL | Pick fewer pages, or paste a description instead. Each page costs a page-load and a read. |
| Blank page at localhost:4173 | Give the server window a few seconds, then refresh. |

Run `npm test` any time to check the app's own logic is intact (78 tests, no network needed).

---

## Before you share this folder onward

**Double-click `package-for-sharing.bat`.**

It builds `TestGenerator-share.zip` next to the folder (~127 KB) with your own data stripped out, so
you can't accidentally ship a live login session. Send that file.

<details>
<summary>What it leaves out, if you'd rather zip it by hand</summary>

```
node_modules/     51 MB, rebuilt by npm install
data/             your runs — and a saved login session, if you have one
.browser-profile/ a saved login session
.playwright-mcp/  scratch files
.env
mcp/playwright-profile.generated.json    (has your Windows username in a path)
```
</details>

> **`data/` and `.browser-profile/` can hold a working session for a site you signed into.**
> Anyone who gets those files gets that session. This is the one thing worth double-checking.

---

## A few honest limits

- Test cases are a **strong first draft**, not a finished suite. Read them before they go into your tracker.
- It won't invent error messages it hasn't seen. If it couldn't observe the exact wording, it asserts the
  behaviour instead (*"an error message is shown"*) — that's deliberate.
- Whatever you paste, and any page you point it at, is processed by Claude. **Don't paste real customer
  data, credentials, or production PII.** Use staging with synthetic data. On a regulated project, check
  with your compliance team first.
