#!/usr/bin/env node
// One-time manual sign-in.
//
// Opens a real, visible browser using a profile stored in .browser-profile/ and
// hands it to you. You sign in yourself — Google SSO, Okta, MFA, whatever — then
// press Enter here. The session is saved into that profile, and later generation
// runs reuse it, so the agent starts out already logged in.
//
// The agent NEVER performs the sign-in itself. That matters for two reasons:
// Google blocks automated logins outright, and no credential of yours is ever
// typed by, shown to, or sent to the model.

const path = require('path');
const readline = require('readline');
const { chromium } = require('playwright-core');

const PROFILE_DIR = path.join(__dirname, '..', '.browser-profile');

function parseArgs(argv) {
  const args = argv.slice(2).filter((a) => a !== '--');
  const url = args.find((a) => /^https?:\/\//i.test(a));
  return { url };
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
}

async function launch(url) {
  // Prefer the real Google Chrome install: Google is far more tolerant of it than
  // of the bundled Chromium build, which it often refuses to sign in on.
  const attempts = [
    { channel: 'chrome', label: 'your installed Google Chrome' },
    { channel: 'msedge', label: 'Microsoft Edge' },
    { label: "Playwright's bundled Chromium" },
  ];

  let lastError;
  for (const attempt of attempts) {
    try {
      const context = await chromium.launchPersistentContext(PROFILE_DIR, {
        headless: false,
        viewport: null,
        args: ['--start-maximized'],
        ...(attempt.channel ? { channel: attempt.channel } : {}),
      });
      console.log(`Opened ${attempt.label}.`);
      if (!attempt.channel) {
        console.log('  Note: Google sign-in often fails on bundled Chromium.');
        console.log('  Installing Google Chrome and re-running this gives a much better chance.');
      }
      const page = context.pages()[0] || (await context.newPage());
      if (url) await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
      return context;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

async function main() {
  const { url } = parseArgs(process.argv);

  console.log('');
  console.log('=========================================================');
  console.log('  Sign in once — the app reuses the session after this');
  console.log('=========================================================');
  console.log('');
  console.log(`Profile: ${PROFILE_DIR}`);
  console.log('');
  console.log('Use a DEDICATED TEST ACCOUNT, not your personal or work login.');
  console.log('This folder will hold a live session for whatever you sign into,');
  console.log('so anyone who gets the folder gets that session. It is gitignored,');
  console.log('and you must exclude it when zipping this project for a teammate.');
  console.log('');

  let context;
  try {
    context = await launch(url);
  } catch (err) {
    console.error('');
    console.error('Could not open a browser:', err.message);
    console.error('Install Google Chrome, or run "npx playwright install chromium" first.');
    process.exit(1);
  }

  console.log('');
  console.log('Now, in the browser window:');
  console.log('  1. Sign in (Google SSO, MFA, all of it — you are driving, not the agent).');
  console.log('  2. Navigate to the page you want test cases for, so you can confirm it loads.');
  console.log('  3. Come back here and press Enter.');
  console.log('');

  await prompt('Press Enter once you are signed in... ');

  // Report what we actually captured, so a failed login isn't silently saved.
  try {
    const cookies = await context.cookies();
    const pages = context.pages();
    const currentUrl = pages.length ? pages[pages.length - 1].url() : '(no page open)';
    console.log('');
    console.log(`Saved ${cookies.length} cookie${cookies.length === 1 ? '' : 's'} to the profile.`);
    console.log(`Last page open: ${currentUrl}`);
    if (!cookies.length) {
      console.log('');
      console.log('WARNING: no cookies were captured, so the sign-in probably did not complete.');
      console.log('Run this again and make sure you are fully signed in before pressing Enter.');
    }
  } catch {
    // Non-fatal — the profile is written by the browser regardless.
  }

  await context.close();

  console.log('');
  console.log('Done. In the app, tick "Use my signed-in browser session" before generating.');
  console.log('Re-run this whenever the session expires.');
  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
