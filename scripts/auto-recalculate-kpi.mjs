// Runs the same KPI recalculation that today only ever happens when a human has
// Lofty_Support_Portal.html or MTD_Attendance_Eligible_Workdays.html open in a browser
// (calculatePeriod() in shared/recalculate.js is only ever imported/called from those two
// pages' inline <script type="module"> code - there is no server-side cron that calls it).
// This script calls the exact same function headlessly, so KPI scores refresh once a day
// without anyone needing to have that internal dashboard open.
//
// Meant to run once per login via a LaunchAgent (see ~/Library/LaunchAgents/), a few seconds
// after zendesk-proxy.js itself starts (also via LaunchAgent - see that plist's dependency on
// this one's target being up). Safe to also run manually any time: `node auto-recalculate-kpi.mjs`.
//
// Steps, in order:
//   1. Wait for the local zendesk-proxy.js server (localhost:3040) to accept connections -
//      it may still be starting up if this fires right after login.
//   2. Refresh the metric-summaries cache (the Zendesk-derived calls/CSAT/ticket data
//      calculatePeriod() reads) - without this, calculatePeriod() would compute against
//      whatever cache happened to already exist, possibly hours or days stale.
//   3. Call calculatePeriod() for today's period - this computes AND saves results for every
//      active roster member in one call (it's not per-employee).
//   4. Trigger an immediate cloud-sync push (POST /api/debug/cloud-sync-now) so the live
//      portal picks up the fresh numbers within seconds, not up to the next scheduled
//      10-minute tick.
//
// This does NOT backfill any past days that were missed before this was set up - it only
// keeps today's (and going forward, every future day's) number current.

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const LOCK_PATH = join(dirname(fileURLToPath(import.meta.url)), '.auto-recalculate.lock');
// A full refresh can run 15-30+ minutes (see below), and this script fires both at login and
// on a periodic timer - without this guard, a slow run could still be going when the next
// trigger fires, starting a second concurrent company-wide Zendesk pull on top of the first.
function acquireLock() {
  if (existsSync(LOCK_PATH)) {
    const pid = Number(readFileSync(LOCK_PATH, 'utf8').trim());
    try {
      process.kill(pid, 0); // throws if that pid isn't actually running (stale lock from a crash)
      return false;
    } catch { /* stale lock - fall through and take it */ }
  }
  writeFileSync(LOCK_PATH, String(process.pid));
  return true;
}
function releaseLock() {
  try { unlinkSync(LOCK_PATH); } catch { /* already gone, fine */ }
}

const BASE_URL = 'http://localhost:3040';
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => realFetch(String(url).startsWith('/') ? `${BASE_URL}${url}` : url, opts);

function todayEasternParts() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  return { year: get('year'), month: get('month'), day: get('day') };
}

async function waitForServer(maxWaitMs = 90000, intervalMs = 2000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      const r = await realFetch(`${BASE_URL}/api/mtd-cache/status?month=2000-01&endDate=2000-01-01`);
      if (r.ok || r.status === 400) return true; // any real HTTP response means the server is up
    } catch { /* not up yet, keep waiting */ }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

async function main() {
  const { year, month: mm, day } = todayEasternParts();
  const month = `${year}-${mm}`;
  const endDate = `${year}-${mm}-${day}`;
  console.log(`[auto-recalculate-kpi] ${new Date().toISOString()} starting for ${month} (as of ${endDate})`);

  console.log('[auto-recalculate-kpi] waiting for local server...');
  const up = await waitForServer();
  if (!up) {
    throw new Error('local server never came up after 90s - is zendesk-proxy.js running?');
  }
  console.log('[auto-recalculate-kpi] server is up.');

  console.log('[auto-recalculate-kpi] refreshing metric-summaries cache from Zendesk (full company-wide pull - this can take 15-30+ minutes)...');
  // A blocking fetch() to /api/mtd-cache/refresh times out client-side well before a full
  // company-wide pull finishes (Node's default undici headers timeout is ~5 minutes; a full
  // refresh has been observed taking well over that) even though the server keeps working
  // fine in the background. Use the documented background+poll pattern instead - the same one
  // the internal dashboard's own "refresh in background" option uses - so there's no client-
  // side timeout to hit at all.
  const startRes = await fetch('/api/mtd-cache/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataset: 'all', month, endDate, background: true }),
    signal: AbortSignal.timeout(30000),
  });
  const startBody = await startRes.json().catch(() => ({}));
  if (!startRes.ok || startBody.ok === false) {
    console.error('[auto-recalculate-kpi] could not start metric-summaries refresh:', startBody.error || startRes.status);
    console.error('[auto-recalculate-kpi] proceeding anyway - calculatePeriod() will use whatever cache already exists (may be stale).');
  } else {
    console.log(`[auto-recalculate-kpi] refresh job started (${startBody.message || 'running'}). Polling for completion...`);
    const pollDeadline = Date.now() + 60 * 60 * 1000; // 1 hour hard ceiling
    let lastLoggedDone = -1;
    let consecutivePollFailures = 0;
    while (Date.now() < pollDeadline) {
      await new Promise((r) => setTimeout(r, 10000));
      // A 15s per-request timeout, and a try/catch around the whole poll - without both, a
      // single wedged connection (e.g. the local server restarting mid-poll, which is exactly
      // what happened during testing) leaves this awaiting forever with the process sitting
      // idle at ~0% CPU, looking alive but never progressing and never hitting the 1-hour
      // deadline check because it's stuck on the fetch() call itself, not the loop condition.
      let p;
      try {
        const progRes = await fetch(`/api/mtd-cache/progress?dataset=all&month=${month}&endDate=${endDate}`, {
          signal: AbortSignal.timeout(15000),
        });
        const progBody = await progRes.json().catch(() => ({}));
        p = progBody.progress;
        consecutivePollFailures = 0;
      } catch (error) {
        consecutivePollFailures += 1;
        console.error(`[auto-recalculate-kpi] progress check failed (${error.message}), attempt ${consecutivePollFailures}...`);
        if (consecutivePollFailures >= 6) { // ~1 minute of consecutive failures
          throw new Error('local server stopped responding to progress checks - aborting rather than hanging indefinitely.');
        }
        continue;
      }
      if (!p) continue;
      if (p.done !== lastLoggedDone) {
        console.log(`[auto-recalculate-kpi] refresh progress: ${p.done}/${p.total} (${p.stage || ''}) - ${p.status}`);
        lastLoggedDone = p.done;
      }
      if (p.status === 'Ready') {
        console.log('[auto-recalculate-kpi] metric-summaries refreshed successfully.');
        break;
      }
      if (p.status === 'Failed') {
        console.error('[auto-recalculate-kpi] metric-summaries refresh failed:', p.error || '(no error message)');
        console.error('[auto-recalculate-kpi] proceeding anyway - calculatePeriod() will use whatever cache already exists (may be stale/partial).');
        break;
      }
    }
  }

  console.log('[auto-recalculate-kpi] computing KPI scores...');
  const { calculatePeriod } = await import('../shared/recalculate.js');
  let outcome;
  try {
    outcome = await calculatePeriod(month, endDate);
  } catch (error) {
    throw new Error(`calculatePeriod() threw: ${error.message}`);
  }
  console.log(`[auto-recalculate-kpi] computed ${outcome.results.length} employee KPI rows (metric summary status: ${outcome.metricSummaryStatus}).`);

  console.log('[auto-recalculate-kpi] pushing to the live portal now...');
  const syncRes = await fetch('/api/debug/cloud-sync-now', { method: 'POST', signal: AbortSignal.timeout(60000) });
  const syncBody = await syncRes.json().catch(() => ({}));
  if (!syncRes.ok || syncBody.ok === false) {
    console.error('[auto-recalculate-kpi] immediate cloud-sync push failed - the scheduled tick (every 10 min) will still pick this up.', syncBody.error || syncRes.status);
  } else {
    console.log(`[auto-recalculate-kpi] synced to the live portal at ${syncBody.syncedAt}.`);
  }

  console.log('[auto-recalculate-kpi] done.');
}

if (!acquireLock()) {
  console.log('[auto-recalculate-kpi] a previous run is still in progress (lock held) - skipping this trigger.');
  process.exit(0);
}
main()
  .catch((error) => {
    console.error('[auto-recalculate-kpi] unexpected failure:', error);
    process.exitCode = 1;
  })
  .finally(releaseLock);
