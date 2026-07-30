'use strict';
/*
  One-time (and future onboarding) bulk seed of PTO rep login credentials.

  Login usernames are each rep's CONFIRMED Zendesk email, not roster.json's
  employeeEmail field taken on faith - those can drift (a resigned employee's
  Zendesk account is gone, or the roster was seeded with a guessed
  firstname.lastname@ address that was never their real login). This script
  calls the internal dashboard server's GET /api/pto/rep-directory, which
  looks each active roster employee up in Zendesk and only returns a
  confirmed email when it actually matches. Employees who don't match are
  skipped and flagged for manual review - never guessed.

  Requires zendesk-proxy.js to be running locally and signed in to Zendesk
  (the same Mac session used for the internal dashboard).

  Usage:
    UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... node scripts/seed-pto-credentials.js [--force] [--password=Something123]

  By default, employees who already have a credential record are skipped
  (safe to re-run for newly added reps). Pass --force to regenerate and
  overwrite every matched employee's password - this immediately invalidates
  their current password, so only do this deliberately (e.g. mass rotation).

  By default each rep gets a unique random temporary password. Pass
  --password=Something to give everyone the SAME temporary password instead
  (easier to distribute in one announcement) - note this is a real security
  tradeoff versus unique passwords: anyone who knows the shared value can
  sign in as any rep who hasn't changed it yet. mustChangePassword is still
  forced on first login regardless.

  Output: a `email,name,temporaryPassword` CSV printed to stdout for the
  administrator to distribute out-of-band (Slack/Teams DM, etc) - there is
  no email-sending infrastructure in this project.
*/

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const cloudStore = require('../server/kv-store.js');
const ptoLogic = require('../server/pto-logic.js');
const ptoPassword = require('../server/password.js');

const FORCE = process.argv.includes('--force');
const FIXED_PASSWORD_ARG = process.argv.find(x => x.startsWith('--password='));
const FIXED_PASSWORD = FIXED_PASSWORD_ARG ? FIXED_PASSWORD_ARG.slice('--password='.length) : '';
const PROXY_URL = process.env.ZENDESK_PROXY_URL || 'http://localhost:3040';
const PASSWORD_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'; // excludes 0/O/1/l/I

function randomPassword(length = 10) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += PASSWORD_CHARS[bytes[i] % PASSWORD_CHARS.length];
  return out;
}

function credentialKey(email) { return `mtdkpi:pto-credential:${ptoLogic.cleanEmail(email)}`; }

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const transport = url.startsWith('https:') ? https : http;
    transport.get(url, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`${url} returned HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
        try { resolve(JSON.parse(data)); } catch (error) { reject(new Error(`${url} returned invalid JSON: ${error.message}`)); }
      });
    }).on('error', reject);
  });
}

async function main() {
  if (!cloudStore.isConfigured()) {
    console.error('Missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN. Set these (pointing at the target environment) before running this script.');
    process.exit(1);
  }

  let directory;
  try {
    const result = await fetchJson(`${PROXY_URL}/api/pto/rep-directory`);
    directory = result.directory || [];
  } catch (error) {
    console.error(`Could not reach the internal dashboard server at ${PROXY_URL} (is it running and signed in to Zendesk?): ${error.message}`);
    process.exit(1);
  }

  const matched = directory.filter(x => x.matched);
  const unmatched = directory.filter(x => !x.matched);

  const rows = [['email', 'name', 'temporaryPassword', 'action']];
  for (const entry of matched) {
    const email = ptoLogic.cleanEmail(entry.verifiedZendeskEmail);
    const key = credentialKey(email);
    const existing = await cloudStore.kvGetJson(key, null);
    if (existing && !FORCE) {
      rows.push([email, entry.employeeName, '(already has an account - skipped)', 'skipped']);
      continue;
    }
    const temporaryPassword = FIXED_PASSWORD || randomPassword();
    const now = new Date().toISOString();
    const record = {
      employeeEmail: email,
      employeeName: entry.employeeName,
      passwordHash: ptoPassword.hashPassword(temporaryPassword),
      mustChangePassword: true,
      sessionVersion: (existing?.sessionVersion || 0) + 1,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      lastLoginAt: existing?.lastLoginAt || null,
      tourSeen: false
    };
    await cloudStore.kvSetJson(key, record);
    rows.push([email, entry.employeeName, temporaryPassword, existing ? 'reset' : 'created']);
  }

  console.log(rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n'));

  const created = rows.filter(r => r[3] === 'created').length;
  const reset = rows.filter(r => r[3] === 'reset').length;
  const skipped = rows.filter(r => r[3] === 'skipped').length;
  console.error(`\n${created} created, ${reset} reset, ${skipped} skipped (already had an account).`);

  if (unmatched.length) {
    console.error(`\nNEEDS MANUAL REVIEW - ${unmatched.length} active roster employee(s) whose roster email did not match a real Zendesk agent (no account created):`);
    for (const entry of unmatched) console.error(`  - ${entry.employeeName} <${entry.rosterEmail}>`);
  }
}

main().catch(error => { console.error(error); process.exit(1); });
