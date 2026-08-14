'use strict';
/*
  Standalone public PTO server for reps.

  Deliberately separate from zendesk-proxy.js: this process only ever exposes
  PTO request filing/status plus the minimal read-only roster/schedule data
  needed to calculate conflicts and staffing forecasts. It never touches
  Zendesk credentials, the roster/schedule/attendance WRITE endpoints, KPI
  results, or any of the internal monitoring dashboards.

  Team leaders may review and pre-approve requests for their direct reports.
  Charlotte Sanchez may submit a final-approval decision, which is queued for
  the local admin server to apply together with schedule/attendance integration.
  Declines, partial approvals, cancellations, and threshold settings remain on
  the local admin dashboard (zendesk-proxy.js).

  Auth: each rep has their own account (email + password), verified server-side.
  There is no shared link secret anymore - the login form is the gate, and
  every identity-sensitive write is scoped to the signed-in session, never to
  whatever the client claims in the request body.

  Data lives in Upstash (shared with zendesk-proxy.js's background sync loop),
  not on this server's local disk - safe to run on a host with no persistent
  storage (e.g. Render's free tier).

  Required env vars:
    UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN  - shared cloud data store
    PTO_ADMIN_KEY                                      - admin-only credential reset endpoint
  Optional:
    PORT (default 3050)
    STATUS_WALL_KEY - shared secret for the read-only /status-wall board (a link, not a
      per-person login, meant for a floor TV/monitor). Set it to any random string and
      share the link as https://<host>/status-wall?key=<that value>; the key is stored in
      an HttpOnly cookie after the first visit so it doesn't have to stay in the URL bar.
*/

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cloudStore = require('./server/kv-store.js');
const ptoLogic = require('./server/pto-logic.js');
const ptoPassword = require('./server/password.js');
const emailService = require('./server/email-service.js');

const PORT = Number(process.env.PORT || 3050);
const ADMIN_KEY = process.env.PTO_ADMIN_KEY || '';
// Optional: powers the "Rephrase" button on Alignment/Announcement composers and the Alignment
// contradiction review. Set GROQ_API_KEY in this service's environment (Render dashboard, not
// a committed file) - left blank, those features just show "not configured yet."
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';
function callGroq(prompt, { maxTokens = 1024, json = false } = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: GROQ_MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }], ...(json ? { response_format: { type: 'json_object' } } : {}) });
    const req = https.request({
      hostname: 'api.groq.com',
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Length': Buffer.byteLength(body) },
      timeout: 25000
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { return reject(new Error('Groq returned an unreadable response.')); }
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(parsed.error?.message || `Groq returned HTTP ${res.statusCode}.`));
        const text = parsed.choices?.[0]?.message?.content;
        if (!text) return reject(new Error('Groq returned no suggestion - try again with shorter text.'));
        resolve(text.trim());
      });
    });
    req.on('timeout', () => req.destroy(new Error('Groq request timed out.')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
// Internal company AI assistant ("PapagoAI Copilot", service name tsr-bot) - the same one
// already used company-wide to review Zendesk tickets for sentiment/risk. This server never
// calls tsr-bot itself: tsr-bot.d.chime.me returned a bare "500 Internal Server Error" (openresty)
// to every request made from Render, while the exact same request succeeds from a machine on
// Lofty's own network - it's evidently not reachable from outside the company network. So the
// actual auth (send-code/verify) and chat/messages calls happen client-side, in the browser of
// whoever is connecting or triaging (their browser is on a network that can reach it). This
// server's only job is to persist the resulting token in Upstash so it's shared across every
// BQA reviewer's browser, and to cache AI triage results. See the /api/admin/copilot/* and
// /api/qa/dsat-review/save-analysis routes near /api/qa/dsat-review.
const COPILOT_AUTH_KEY = 'mtdkpi:copilot-auth';
async function loadCopilotAuth() { return cloudStore.kvGetJson(COPILOT_AUTH_KEY, null); }
async function saveCopilotAuth(auth) { return cloudStore.kvSetJson(COPILOT_AUTH_KEY, auth); }
async function clearCopilotAuth() { return cloudStore.kvSetJson(COPILOT_AUTH_KEY, null); }
const DSAT_AI_CACHE_KEY = 'mtdkpi:dsat-ai-cache';

// Bump this whenever pto-public.html gets a user-facing feature worth flagging - returning
// reps whose credential.lastSeenVersion is behind this get a "what's new" popup on next
// sign-in (see /api/my/whats-new-seen) instead of the full first-time welcome tour.
const PORTAL_VERSION = '1.30.4';
const STATUS_WALL_KEY = process.env.STATUS_WALL_KEY || '';
const STATUS_WALL_COOKIE_NAME = 'status_wall_key';
const ROSTER_CONTACT_FIELDS = ['contactNumber','contactEmail','emergencyContactName','emergencyContactRelationship','emergencyContactNumber','currentResidence','birthday'];
// Broader than ROSTER_CONTACT_FIELDS - what a team lead can edit on a direct report's full
// profile via /api/my/team-roster. Deliberately excludes employeeEmail (their login
// identity), teamLeadName/teamLeadEmail (re-org), employmentStatus/active/separationDate
// (HR-sensitive, stays admin-only on MTD_Roster_Management.html) - only day-to-day profile
// fields a lead would reasonably self-serve, plus employeeId which is admin/lead-set only
// (never in ROSTER_CONTACT_FIELDS, so a rep can never set their own).
const TEAM_EDITABLE_PROFILE_FIELDS = ['employeeName','employeeId','jobTitle','primaryChannel','kpiType','hireDate','scheduleGroup','seniorTsrAssignment','notes',...ROSTER_CONTACT_FIELDS];
// Mirrors shared/kpi-config.js's ATTENDANCE_CODES - duplicated here (like ROSTER_CONTACT_FIELDS
// above) since this file is CommonJS and that config lives in an ES module.
const ATTENDANCE_CODES = ['ONSITE','WFH','LATE','RD','PTO','PARTIAL_PTO','SL','EL','SL-HD','EL-HD','NCNS','A','BL','SUSPENDED'];
// Used only by the Daily EOD Report's Onsite/WFH/Present/Out breakdown (see /api/my/site-metrics
// below) - RD/PTO/PARTIAL_PTO are known ahead of time, the rest are same-day or exceptional.
const PLANNED_OUT_CODES = new Set(['RD', 'PTO', 'PARTIAL_PTO']);
const UNPLANNED_OUT_CODES = new Set(['SL', 'SL-HD', 'EL', 'EL-HD', 'NCNS', 'A', 'BL', 'SUSPENDED']);
// Mirrors shared/scoring.js's performanceStatus() tiering (best to worst), duplicated here
// for the same CommonJS/ES-module reason as ATTENDANCE_CODES above.
const PERFORMANCE_TIER = { Exceptional: 4, Exceeds: 3, Meets: 2, Watch: 1, Intervention: 0 };
// Mirrors shared/scoring.js's scoreCsat/performanceStatus (also duplicated in zendesk-proxy.js
// as scoreCsatBand/its own inline tiering) - needed here too now that a DSAT dispute can be
// decided from this deployed portal, not just the local admin tool.
function scoreCsatBandForDsat(v, weight = 40) {
  if (v == null || !Number.isFinite(+v)) return { points: null };
  v = +v;
  const band = (score, multiplier, points) => ({ score, multiplier, points });
  return v >= 95 ? band(5, 1, weight) : v >= 90 ? band(4, .9, weight * .9) : v >= 85 ? band(3, .8, weight * .8) : v >= 80 ? band(2, .7, weight * .7) : band(1, .6, weight * .6);
}
function performanceStatusForDsat(value) {
  if (value == null) return 'Not Rated';
  return value >= 95 ? 'Exceptional' : value >= 90 ? 'Exceeds' : value >= 85 ? 'Meets' : value >= 80 ? 'Watch' : 'Intervention';
}
// Computes the "after approved dispute" KPI preview for one KPI-results row, given how many
// of that employee's disputes are currently APPROVED for that same period. Deliberately a pure
// function of the row + a count, not of any single dispute record, so /api/my/kpi can call it
// fresh on every read (see below) instead of trusting a value cached at decide-time, which
// would go stale the moment a second dispute for the same employee/period gets approved.
function buildDsatKpiAdjustment(row, notValidDsatCount) {
  if (!notValidDsatCount) return null;
  const csat = row.csat || {}, good = csat.good || 0, bad = csat.bad || 0;
  const adjustedBad = Math.max(0, bad - notValidDsatCount), adjustedValid = good + adjustedBad;
  const adjustedRate = adjustedValid ? good / adjustedValid * 100 : null;
  const adjustedScore = adjustedRate == null ? { points: null } : scoreCsatBandForDsat(adjustedRate);
  const delta = (csat.points != null && adjustedScore.points != null) ? adjustedScore.points - csat.points : null;
  const adjustment = {
    notValidDsatCount, adjustedCsatGood: good, adjustedCsatBad: adjustedBad, adjustedCsatRate: adjustedRate, adjustedCsatPoints: adjustedScore.points,
    baseKpiBefore: row.baseKpi, finalKpiBefore: row.finalKpi, performanceStatusBefore: row.performanceStatus,
    adjustedBaseKpi: (row.baseKpi != null && delta != null) ? row.baseKpi + delta : row.baseKpi,
    adjustedFinalKpi: (row.finalKpi != null && delta != null) ? row.finalKpi + delta : row.finalKpi
  };
  adjustment.adjustedPerformanceStatus = performanceStatusForDsat(adjustment.adjustedFinalKpi);
  return adjustment;
}
const ATTENDANCE_UPDATES_KEY = 'mtdkpi:attendance-updates';
const ATTENDANCE_ATTACHMENTS_KEY = 'mtdkpi:attendance-attachments';
const ATTACHMENT_LEAVE_CODES = ['SL', 'EL', 'SL-HD', 'EL-HD'];
const MAX_ATTACHMENT_BASE64_LENGTH = 4 * 1024 * 1024; // ~3MB original file, base64-encoded
const PROFILE_PHOTO_KEY_PREFIX = 'mtdkpi:profile-photo:';
// The client resizes/compresses to a small square JPEG before ever uploading, so a generous
// cap here is just a backstop against something slipping past that, not the primary control.
const MAX_PROFILE_PHOTO_BASE64_LENGTH = 700 * 1024;
const MAX_REWARD_IMAGE_BASE64_LENGTH = 700 * 1024;
const SESSION_COOKIE_NAME = 'pto_session';
const SESSION_TTL_SECONDS = 14 * 24 * 60 * 60; // 14 days
const MTD_ROOT = __dirname;
const SNAPSHOT_MAX_AGE_MS = Number(process.env.PTO_SNAPSHOT_CACHE_MS || 15000);
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS = 10 * 60 * 1000; // 10 minutes
const FINAL_PTO_APPROVER_EMAIL = 'charlotte@lofty.com';

ptoLogic.PTO_ACTIVE_STATUSES.add('PRE_APPROVED');
ptoLogic.PTO_ACTIVE_STATUSES.add('FINAL_APPROVAL_QUEUED');
ptoLogic.PTO_ACTIVE_STATUSES.add('FINAL_APPROVAL_APPLYING');

if (!cloudStore.isConfigured()) {
  console.error('Missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN. The public PTO server has nowhere to store data - refusing to start.');
  process.exit(1);
}

const STATIC_SHARED = new Set(['ui-utils.js', 'date-utils.js', 'kpi-config.js', 'roster-service.js', 'pto-service.js', 'auth-service.js', 'my-data-service.js', 'chat-service.js', 'announcement-service.js', 'phone-utils.js', 'csat-dispute-service.js', 'schedule-request-service.js', 'coaching-service.js', 'disciplinary-service.js', 'activity-config.js', 'loading-status.js', 'loading-status.css', 'kpi.css', 'site-metrics-service.js', 'qa-dsat-service.js', 'alignment-service.js', 'rich-text.js', 'training-service.js', 'rewards-service.js', 'mbr-report.js']);
const STATIC_SHARED_BINARY = new Set(['img/lofty-logo.png', 'img/icon-192.png', 'img/icon-512.png', 'img/icon-512-maskable.png', 'img/apple-touch-icon.png', 'img/csat-banner.png', 'vendor/pptxgen.bundle.js', 'vendor/jspdf.umd.min.js']);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8', extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': type, ...extraHeaders });
  res.end(text);
}

function sendBinary(res, status, buffer, type) {
  res.writeHead(status, { 'Content-Type': type });
  res.end(buffer);
}

function contentTypeFor(file) {
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.png')) return 'image/png';
  if (file.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'text/plain; charset=utf-8';
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 2_000_000) req.destroy(); });
    req.on('end', () => { if (!data) return resolve({}); try { resolve(JSON.parse(data)); } catch (error) { reject(Object.assign(new Error('Invalid JSON body.'), { statusCode: 400 })); } });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    if (key) out[key] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function sessionCookieHeader(token, isSecureReq) {
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${isSecureReq ? '; Secure' : ''}`;
}

function clearSessionCookieHeader(isSecureReq) {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isSecureReq ? '; Secure' : ''}`;
}

function statusWallKeyMatches(parsed, cookies) {
  if (!STATUS_WALL_KEY) return false;
  const supplied = parsed.searchParams.get('key') || cookies[STATUS_WALL_COOKIE_NAME] || '';
  return timingSafeEqualStr(supplied, STATUS_WALL_KEY);
}
function statusWallCookieHeader(isSecureReq) {
  return `${STATUS_WALL_COOKIE_NAME}=${STATUS_WALL_KEY}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${365 * 24 * 60 * 60}${isSecureReq ? '; Secure' : ''}`;
}

// --- Status Wall: a read-only, floor-display view combining the rep's clock/status with
// short-lived Zendesk presence and assigned-work signals published by the local server.
const STATUS_WALL_BREAK_MAX_MINUTES = 15;
const STATUS_WALL_LUNCH_MAX_MINUTES = 60;
const STATUS_WALL_QUEUE_IDS = new Set(['CALL', 'CHAT', 'EMAIL', 'EMAIL_CHAT', 'LEAD_IMPORT', 'SENIOR_TSR']);
const STATUS_WALL_ACTIVITY_NAMES = {
  CALL: 'Call', CHAT: 'Chat', EMAIL: 'Email', EMAIL_CHAT: 'Email / Chat', LEAD_IMPORT: 'Lead Import', SENIOR_TSR: 'Senior TSR',
  SHORT_BREAK: 'Break', LUNCH: 'Lunch',
  COACHING: 'Coaching', TRAINING: 'Training', TEAM_HUDDLE: 'Team Huddle', ONE_ON_ONE: '1:1 Session', QA_REVIEW: 'QA Review',
  MEETING: 'Meeting', CALIBRATION: 'Calibration', SIDE_BY_SIDE: 'Side-by-Side', PROJECT_WORK: 'Project Work', ADMIN: 'Admin',
  DOCUMENTATION: 'Documentation', CASE_REVIEW: 'Case Review', OTHER_OFFLINE: 'Other Offline Task', OFFLINE: 'Offline'
};
function easternDateParts(date) {
  const out = {};
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(date).forEach(p => { if (p.type !== 'literal') out[p.type] = p.value; });
  return out;
}
function addMonthsToDate(dateStr, months) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + months, d)).toISOString().slice(0, 10);
}
function daysBetweenDates(fromDate, toDate) {
  return Math.round((new Date(toDate + 'T00:00:00Z').getTime() - new Date(fromDate + 'T00:00:00Z').getTime()) / 86400000);
}
// Next occurrence of a rep's month/day from today (year-agnostic - the stored birthday's
// year is irrelevant, only month/day repeats annually).
function nextBirthdayInfo(birthday, todayDate) {
  if (!ptoLogic.validDate(birthday)) return null;
  const [, bm, bd] = birthday.split('-');
  const thisYear = todayDate.slice(0, 4);
  let next = `${thisYear}-${bm}-${bd}`;
  if (next < todayDate) next = `${Number(thisYear) + 1}-${bm}-${bd}`;
  return { nextDate: next, daysUntil: daysBetweenDates(todayDate, next), isToday: next === todayDate };
}
// Next work-anniversary occurrence from Hire Date - same year-agnostic month/day logic as
// nextBirthdayInfo, plus the year count that anniversary actually completes.
function nextAnniversaryInfo(hireDate, todayDate) {
  if (!ptoLogic.validDate(hireDate) || hireDate > todayDate) return null;
  const [hy, hm, hd] = hireDate.split('-');
  const thisYear = todayDate.slice(0, 4);
  let next = `${thisYear}-${hm}-${hd}`;
  if (next < todayDate) next = `${Number(thisYear) + 1}-${hm}-${hd}`;
  const yearsCompleted = Number(next.slice(0, 4)) - Number(hy);
  if (yearsCompleted < 1) return null; // hasn't reached a first anniversary yet
  return { nextDate: next, daysUntil: daysBetweenDates(todayDate, next), isToday: next === todayDate, years: yearsCompleted };
}
// A rep is "on probation" for their first 5 full months of tenure - one monthly eval per
// month, ending at the month-5 mark (regularization decision). dueDate is the boundary of
// the CURRENT eval month (always today or in the future, by construction of monthsEmployed),
// so daysUntilDue tells a team lead how much runway is left to complete that month's eval.
function probationEvalInfo(hireDate, todayDate) {
  if (!ptoLogic.validDate(hireDate) || hireDate > todayDate) return null;
  let monthsEmployed = 0;
  while (monthsEmployed < 6 && addMonthsToDate(hireDate, monthsEmployed + 1) <= todayDate) monthsEmployed++;
  if (monthsEmployed >= 5) return null;
  const evalMonth = monthsEmployed + 1;
  const dueDate = addMonthsToDate(hireDate, evalMonth);
  return { evalMonth, dueDate, daysUntilDue: daysBetweenDates(todayDate, dueDate) };
}
// Finds the UTC instant that corresponds to a given Eastern wall-clock date+time, correcting once
// for the DST offset (same technique as zendesk-proxy.js's easternEpoch) - used to give the client
// a stable "since" timestamp for the Late Login case (how long past their scheduled shift start).
// A rep must Time In before their status can change - clockedInAt is set on Time In, cleared
// (with the status too) on Time Out, so "clocked in" always means "clocked in TODAY", not stale
// from a prior day.
function repStatusClockedInToday(entry) {
  if (!entry?.clockedInAt) return false;
  const now = easternDateParts(new Date());
  const then = easternDateParts(new Date(entry.clockedInAt));
  return `${now.year}-${now.month}-${now.day}` === `${then.year}-${then.month}-${then.day}`;
}
function easternEpochMs(dateStr, minutesSinceMidnight) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const hours = Math.floor(minutesSinceMidnight / 60), mins = minutesSinceMidnight % 60;
  const guess = Date.UTC(y, m - 1, d, hours, mins);
  const parts = easternDateParts(new Date(guess));
  const represented = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return guess - (represented - guess);
}
async function computeStatusWall() {
  const roster = (await loadRosterSnapshot()).records.filter(x => x.active && ['Voice Jr TSR', 'Non-Voice Jr TSR', 'Senior TSR', 'Database Agent'].includes(x.kpiType));
  const schedules = await loadScheduleSnapshot();
  const repStatusData = await loadRepStatus();
  const statusSignals = await loadStatusSignalsSnapshot();
  const signalsFresh = Date.now() - new Date(statusSignals.generatedAt || 0).getTime() <= 2 * 60 * 1000;
  const channelSignalsAvailable = signalsFresh && Boolean(statusSignals.sources?.calls || statusSignals.sources?.availability);
  const ticketSignalsAvailable = signalsFresh && Boolean(statusSignals.sources?.zendeskTickets || statusSignals.sources?.jiraTickets);
  const signalsAvailable = channelSignalsAvailable || ticketSignalsAvailable;
  const workActivityMaxMinutes = Math.max(1, Number(statusSignals.workActivityMaxMinutes || 5));
  const statuses = repStatusData.statuses || {};
  const nowParts = easternDateParts(new Date());
  const todayDate = `${nowParts.year}-${nowParts.month}-${nowParts.day}`;
  const nowMinutes = Number(nowParts.hour) * 60 + Number(nowParts.minute);
  const rows = [];
  for (const emp of roster) {
    const email = ptoLogic.cleanEmail(emp.employeeEmail);
    const resolved = ptoLogic.scheduleForDate(schedules, email, todayDate);
    const t = resolved.template;
    const entry = statuses[email] || null;
    const clockedInTodayFlag = repStatusClockedInToday(entry);
    const activityId = entry?.activityId || '';
    const updatedAtMs = entry?.updatedAt ? new Date(entry.updatedAt).getTime() : null;
    const hasActivityToday = clockedInTodayFlag && Boolean(activityId) && updatedAtMs != null;
    const signal = signalsAvailable ? statusSignals.byEmail?.[email] || null : null;
    const liveOnCall = Boolean(signal?.onCall);
    const liveOnChat = Boolean(signal?.onChat);
    const liveOnline = Boolean(signal?.online || liveOnCall || liveOnChat);
    const zendeskActivityMs = signal?.zendeskActivityAt ? new Date(signal.zendeskActivityAt).getTime() : 0;
    const jiraActivityMs = signal?.jiraActivityAt ? new Date(signal.jiraActivityAt).getTime() : 0;
    const activityCutoffMs = Date.now() - workActivityMaxMinutes * 60 * 1000;
    const recentZendeskWork = zendeskActivityMs >= activityCutoffMs;
    const recentJiraWork = jiraActivityMs >= activityCutoffMs;
    const latestWorkMs = Math.max(recentZendeskWork ? zendeskActivityMs : 0, recentJiraWork ? jiraActivityMs : 0);
    const manualNonQueue = hasActivityToday && !STATUS_WALL_QUEUE_IDS.has(activityId);
    const manualStatusIsNewer = manualNonQueue && updatedAtMs > latestWorkMs;
    const selfReportedQueue = hasActivityToday && STATUS_WALL_QUEUE_IDS.has(activityId);
    const scheduledToday = !resolved.missingSchedule && Boolean(t) && !t.off;

    let shiftStart = 0, shiftEnd = 0, onShiftNow = false;
    if (scheduledToday) {
      shiftStart = ptoLogic.minutesOf(t.shiftStartEastern);
      const shiftEndRaw = ptoLogic.minutesOf(t.shiftEndEastern);
      shiftEnd = shiftEndRaw + (t.overnight && shiftEndRaw <= shiftStart ? 1440 : 0);
      let effectiveNow = nowMinutes;
      if (t.overnight && effectiveNow < shiftStart) effectiveNow += 1440;
      onShiftNow = effectiveNow >= shiftStart && effectiveNow < shiftEnd;
    }
    const wentOnlineAnyway = !scheduledToday && (selfReportedQueue || liveOnline || recentZendeskWork || recentJiraWork);
    if (!scheduledToday && !wentOnlineAnyway) continue; // not supposed to be on shift and didn't go online - leave off the wall

    let statusLabel, statusCode = 'OTHER', statusDetail = '', sinceIso = null, capMinutes = null, lateFlag = false;
    if (liveOnCall) {
      statusLabel = 'On Call';
      statusCode = 'ON_CALL';
      statusDetail = signal.callTicketId ? `#${signal.callTicketId}` : '';
      sinceIso = signal.callStartedAt || signal.availabilityUpdatedAt || entry?.updatedAt || entry?.clockedInAt || null;
    } else if (liveOnChat) {
      statusLabel = 'On Chat/Email';
      statusCode = 'ON_CHAT';
      statusDetail = signal.chatTicketId ? `#${signal.chatTicketId}` : '';
      sinceIso = signal.chatStartedAt || signal.availabilityUpdatedAt || entry?.updatedAt || entry?.clockedInAt || null;
    } else if (!manualStatusIsNewer && recentZendeskWork && zendeskActivityMs >= jiraActivityMs) {
      statusLabel = 'Zendesk Ticket';
      statusCode = 'ZENDESK_TICKET';
      statusDetail = signal.zendeskTicketId ? `#${signal.zendeskTicketId}` : 'Recent activity';
      sinceIso = signal.zendeskActivityAt;
    } else if (!manualStatusIsNewer && recentJiraWork) {
      statusLabel = 'Jira Ticket';
      statusCode = 'JIRA_TICKET';
      statusDetail = signal.jiraIssueKey || 'Recent activity';
      sinceIso = signal.jiraActivityAt;
    } else if (manualNonQueue) {
      const name = STATUS_WALL_ACTIVITY_NAMES[activityId] || activityId;
      statusLabel = name;
      sinceIso = new Date(updatedAtMs).toISOString();
      if (activityId === 'SHORT_BREAK') capMinutes = STATUS_WALL_BREAK_MAX_MINUTES;
      else if (activityId === 'LUNCH') capMinutes = STATUS_WALL_LUNCH_MAX_MINUTES;
    } else if (liveOnline || selfReportedQueue) {
      statusLabel = 'Avail';
      statusCode = 'AVAIL';
      sinceIso = signal?.availabilityUpdatedAt || entry?.updatedAt || entry?.clockedInAt || null;
    } else if (clockedInTodayFlag) {
      statusLabel = 'Clocked In';
      sinceIso = entry.clockedInAt;
    } else if (onShiftNow) {
      statusLabel = 'Not Reported'; lateFlag = true;
      const shiftStartMs = easternEpochMs(todayDate, shiftStart);
      sinceIso = new Date(updatedAtMs != null && updatedAtMs > shiftStartMs ? updatedAtMs : shiftStartMs).toISOString();
    } else {
      statusLabel = nowMinutes < shiftStart ? 'Not Started' : 'Off Shift';
    }
    rows.push({
      employeeEmail: email,
      employeeName: emp.employeeName,
      teamLeadName: emp.teamLeadName,
      kpiType: emp.kpiType,
      statusLabel,
      statusCode,
      statusDetail,
      sinceIso,
      capMinutes,
      lateFlag,
      online: ['AVAIL', 'ON_CALL', 'ON_CHAT'].includes(statusCode)
    });
  }
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    signalsGeneratedAt: statusSignals.generatedAt || null,
    signalsFresh,
    signalsAvailable,
    channelSignalsAvailable,
    ticketSignalsAvailable,
    workActivityMaxMinutes,
    signalWarnings: statusSignals.warnings || [],
    breakMaxMinutes: STATUS_WALL_BREAK_MAX_MINUTES,
    lunchMaxMinutes: STATUS_WALL_LUNCH_MAX_MINUTES,
    rows
  };
}

// --- Cloud data access (with a short-lived cache on the read-only snapshots) ---
const DISPUTE_CC_EMAIL = process.env.DISPUTE_CC_EMAIL || 'charlotte@lofty.com';
const DISPUTES_KEY = 'mtdkpi:csat-disputes';
// Must match the same literal in zendesk-proxy.js's syncCsatRefreshRequestsFromCloud() - the
// two processes only share state through this key, there's no shared module between them.
const CSAT_REFRESH_REQUESTS_KEY = 'mtdkpi:csat-refresh-requests';
// New-hire creation and endorse/reject decisions both need to land in roster.json on the
// local admin machine - same request-queue-and-poll pattern as CSAT_REFRESH_REQUESTS_KEY
// above, consumed by syncNewHireRequestsFromCloud() in zendesk-proxy.js. Training scores are
// simpler - Mae's own tool, no admin-side dependency, so that key is owned entirely here.
const NEW_HIRE_REQUESTS_KEY = 'mtdkpi:new-hire-requests';
const TRAINING_SCORES_KEY = 'mtdkpi:training-scores';
const TRAINING_SCORE_CATEGORIES = ['Attendance', 'Module Completion', 'Assessment', 'Mock Call', 'Other'];
const PRODUCTION_KPI_TYPES = ['Voice Jr TSR', 'Non-Voice Jr TSR', 'Senior TSR', 'Database Agent'];
const PTO_KEY = 'mtdkpi:pto-requests';
const AUDIT_KEY = 'mtdkpi:pto-audit';
const SETTINGS_KEY = 'mtdkpi:pto-settings';
const SCHEDULE_REQUESTS_KEY = 'mtdkpi:schedule-requests';
const SCHEDULE_REQUEST_AUDIT_KEY = 'mtdkpi:schedule-request-audit';
const REP_STATUS_KEY = 'mtdkpi:rep-status';
const VALID_STATUS_ACTIVITY_IDS = new Set(['CALL', 'CHAT', 'EMAIL', 'EMAIL_CHAT', 'LEAD_IMPORT', 'SENIOR_TSR', 'SHORT_BREAK', 'LUNCH', 'COACHING', 'TRAINING', 'TEAM_HUDDLE', 'ONE_ON_ONE', 'QA_REVIEW', 'MEETING', 'CALIBRATION', 'SIDE_BY_SIDE', 'PROJECT_WORK', 'ADMIN', 'DOCUMENTATION', 'CASE_REVIEW', 'OTHER_OFFLINE', 'OFFLINE']);
const CREDENTIAL_KEY_PREFIX = 'mtdkpi:pto-credential:';
const SESSION_KEY_PREFIX = 'mtdkpi:pto-session:';
const snapshotCache = new Map();

async function getSnapshot(name, key, fallback) {
  const cached = snapshotCache.get(key);
  if (cached && Date.now() - cached.at < SNAPSHOT_MAX_AGE_MS) return cached.value;
  const value = await cloudStore.kvGetJson(key, fallback);
  snapshotCache.set(key, { value, at: Date.now() });
  return value;
}

async function loadRosterSnapshot() { return getSnapshot('roster', 'mtdkpi:snapshot:roster', { records: [] }); }

// Ported from shared/activity-config.js's defaultAssignmentFor (that file is an ES module and
// can't be require()'d here) - used only as a last-resort fallback when a schedule record has no
// defaultAssignment stored (older schedules created before that field existed).
function serverDefaultAssignmentFor(employee) {
  const kpi = String(employee?.kpiType || '').toLowerCase();
  const channel = String(employee?.primaryChannel || '').toLowerCase();
  const status = String(employee?.employmentStatus || '').toLowerCase();
  if (employee?.active === false || kpi.includes('excluded') || status.includes('inactive')) return '';
  if (kpi.includes('trainee') || status.includes('trainee')) return 'TRAINING';
  if (kpi.includes('non-voice')) {
    if (channel.includes('lead import')) return 'LEAD_IMPORT';
    if ((channel.includes('email') && channel.includes('chat')) || channel.includes('email / chat')) return 'EMAIL_CHAT';
    if (channel.includes('chat')) return 'CHAT';
    if (channel.includes('phone') || channel.includes('voice')) return 'EMAIL';
    if (channel.includes('email')) return 'EMAIL';
    return 'EMAIL';
  }
  if (kpi.includes('voice jr')) return 'CALL';
  if (kpi.includes('senior')) return 'SENIOR_TSR';
  if (kpi.includes('database')) return 'LEAD_IMPORT';
  return 'CALL';
}
async function loadScheduleSnapshot() { return getSnapshot('schedules', 'mtdkpi:snapshot:schedules', { schedules: [], overrides: [] }); }
async function loadAttendanceSnapshot() { return getSnapshot('attendance', 'mtdkpi:snapshot:attendance', { periods: {}, autoEntries: {} }); }
async function loadKpiResultsSnapshot() { return getSnapshot('kpi-results', 'mtdkpi:snapshot:kpi-results', { periods: {} }); }
async function loadSiteMetricsSnapshot() { return getSnapshot('site-metrics', 'mtdkpi:snapshot:site-metrics', { periods: {} }); }
async function loadSpotlightSnapshot() { return getSnapshot('spotlight', 'mtdkpi:snapshot:spotlight', { date: '', shoutouts: [], saves: [], callLeaders: [], celebrations: { birthdays: [], anniversaries: [] }, weather: null, shiftEndThanks: [], dailyThanks: null, generatedAt: '' }); }
// Adds each highlighted employee's uploaded profile photo (if any) to their Spotlight Wall
// item - resolved by email for shoutouts/saves/callLeaders, and by name via the roster for
// birthdays/anniversaries (computeCelebrations() only carries a name, not an email). An
// employee who hasn't uploaded a photo simply gets no photoBase64 field - the wall leaves
// that slide without an avatar rather than showing any kind of placeholder.
async function attachProfilePhotos(spotlight) {
  const roster = await loadRosterSnapshot();
  const emailByName = new Map((roster.records || []).map(x => [String(x.employeeName || '').trim(), ptoLogic.cleanEmail(x.employeeEmail || '')]));
  const emails = new Set();
  for (const item of [...(spotlight.shoutouts || []), ...(spotlight.saves || []), ...(spotlight.callLeaders || []), ...(spotlight.shiftEndThanks || [])]) {
    const email = ptoLogic.cleanEmail(item.employeeEmail || '');
    if (email) emails.add(email);
  }
  for (const item of [...(spotlight.celebrations?.birthdays || []), ...(spotlight.celebrations?.anniversaries || [])]) {
    const email = emailByName.get(String(item.employeeName || '').trim());
    if (email) emails.add(email);
  }
  const photoByEmail = new Map();
  await Promise.all([...emails].map(async email => {
    const photo = await getSnapshot(`profile-photo:${email}`, PROFILE_PHOTO_KEY_PREFIX + email, null);
    if (photo?.contentBase64) photoByEmail.set(email, photo.contentBase64);
  }));
  const withPhoto = (item, email) => { const photo = email && photoByEmail.get(email); return photo ? { ...item, photoBase64: photo } : item; };
  return {
    ...spotlight,
    shoutouts: (spotlight.shoutouts || []).map(x => withPhoto(x, ptoLogic.cleanEmail(x.employeeEmail || ''))),
    saves: (spotlight.saves || []).map(x => withPhoto(x, ptoLogic.cleanEmail(x.employeeEmail || ''))),
    callLeaders: (spotlight.callLeaders || []).map(x => withPhoto(x, ptoLogic.cleanEmail(x.employeeEmail || ''))),
    shiftEndThanks: (spotlight.shiftEndThanks || []).map(x => withPhoto(x, ptoLogic.cleanEmail(x.employeeEmail || ''))),
    celebrations: {
      birthdays: (spotlight.celebrations?.birthdays || []).map(x => withPhoto(x, emailByName.get(String(x.employeeName || '').trim()))),
      anniversaries: (spotlight.celebrations?.anniversaries || []).map(x => withPhoto(x, emailByName.get(String(x.employeeName || '').trim())))
    }
  };
}
async function loadAnnouncementsSnapshot() { return getSnapshot('announcements', 'mtdkpi:snapshot:announcements', { announcements: [] }); }
async function loadStatusSignalsSnapshot() { return getSnapshot('status-signals', 'mtdkpi:snapshot:status-signals', { generatedAt: '', byEmail: {}, warnings: [] }); }
async function loadSeniorJiraActivitySnapshot() { return getSnapshot('senior-jira-activity', 'mtdkpi:snapshot:senior-jira-activity', { generatedAt: '', periods: {} }); }

async function loadPto() { return cloudStore.kvGetJson(PTO_KEY, { version: 1, sequenceByYear: {}, requests: [], overlays: [] }); }
async function savePto(data) { data.lastUpdated = new Date().toISOString(); await cloudStore.kvSetJson(PTO_KEY, data); return data; }
async function loadAudit() { return cloudStore.kvGetJson(AUDIT_KEY, { version: 1, events: [] }); }
async function saveAudit(data) { data.lastUpdated = new Date().toISOString(); await cloudStore.kvSetJson(AUDIT_KEY, data); return data; }
async function loadSettings() { return cloudStore.kvGetJson(SETTINGS_KEY, {}); }

async function appendAudit(requestId, action, { user = 'Rep', notes = '', previousValue = null, newValue = null } = {}) {
  const data = await loadAudit();
  data.events.push({ auditId: `PTO-AUDIT-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, requestId, action, user: String(user || 'Rep'), timestamp: new Date().toISOString(), previousValue, newValue, notes: String(notes || ''), sourcePage: 'Public PTO link' });
  await saveAudit(data);
}

async function ptoReviewAccess(identity, employeeName = '') {
  const roster = await loadRosterSnapshot();
  const records = roster.records || [];
  const cleanIdentity = ptoLogic.cleanEmail(identity);
  const self = records.find(x => ptoLogic.cleanEmail(x.employeeEmail) === cleanIdentity);
  const leaderName = String(self?.employeeName || employeeName || '').trim().toLowerCase();
  const memberEmails = new Set(records.filter(x =>
    ptoLogic.cleanEmail(x.employeeEmail) !== cleanIdentity &&
    (ptoLogic.cleanEmail(x.teamLeadEmail) === cleanIdentity ||
      (leaderName && String(x.teamLeadName || '').trim().toLowerCase() === leaderName))
  ).map(x => ptoLogic.cleanEmail(x.employeeEmail)));
  return {
    memberEmails,
    isTeamLeader: memberEmails.size > 0,
    canFinalApprove: cleanIdentity === FINAL_PTO_APPROVER_EMAIL
  };
}

function canReviewPtoRequest(access, request) {
  return access.canFinalApprove || access.memberEmails.has(ptoLogic.cleanEmail(request.employeeEmail));
}

// Team leads (real direct reports), BQA, and SOM get the full-detail Leadership PTO Calendar;
// everyone else gets the minimal, name-and-status-only Team PTO Calendar. Honors an admin's
// "View As" preview (BQA/SOM previews see it; a REP preview explicitly hides it even for a real
// team lead like Mac, matching how the REP preview suppresses every other team-lead surface).
async function isPtoLeaderViewer(identity, session) {
  const viewAs = effectiveViewAsRole(identity, session);
  const role = viewAs || portalRoleFor(identity);
  if (role === 'BQA' || role === 'SOM') return true;
  if (viewAs === 'REP') return false;
  const access = await ptoReviewAccess(identity, session.employeeName);
  return access.isTeamLeader || access.canFinalApprove;
}

// Who the Leadership PTO Calendar is ABOUT (whose requests appear), as opposed to
// isPtoLeaderViewer above (who is ALLOWED to open it): anyone at least one other active
// employee reports to (a real team lead, matched by email or by name the same way
// ptoReviewAccess does), plus the fixed BQA/SOM identities.
async function leadershipRequesterEmails() {
  const roster = await loadRosterSnapshot();
  const records = roster.records || [];
  const nameToEmail = new Map(records.map(x => [String(x.employeeName || '').trim().toLowerCase(), ptoLogic.cleanEmail(x.employeeEmail)]));
  const leaders = new Set();
  for (const x of records) {
    const leadEmail = ptoLogic.cleanEmail(x.teamLeadEmail);
    if (leadEmail) leaders.add(leadEmail);
    const leadName = String(x.teamLeadName || '').trim().toLowerCase();
    if (leadName && nameToEmail.has(leadName)) leaders.add(nameToEmail.get(leadName));
  }
  for (const x of records) {
    const email = ptoLogic.cleanEmail(x.employeeEmail);
    const role = portalRoleFor(email);
    if (role === 'BQA' || role === 'SOM') leaders.add(email);
  }
  return leaders;
}


// --- Schedule Requests (Shift Change + Offline Task) - mirrors the PTO storage helpers above ---
async function loadScheduleRequests() { return cloudStore.kvGetJson(SCHEDULE_REQUESTS_KEY, { version: 1, sequenceByYear: {}, requests: [] }); }
async function saveScheduleRequests(data) { data.lastUpdated = new Date().toISOString(); await cloudStore.kvSetJson(SCHEDULE_REQUESTS_KEY, data); return data; }
async function loadScheduleRequestAudit() { return cloudStore.kvGetJson(SCHEDULE_REQUEST_AUDIT_KEY, { version: 1, events: [] }); }
async function saveScheduleRequestAudit(data) { data.lastUpdated = new Date().toISOString(); await cloudStore.kvSetJson(SCHEDULE_REQUEST_AUDIT_KEY, data); return data; }
async function appendScheduleRequestAudit(requestId, action, { user = 'Rep', notes = '', previousValue = null, newValue = null } = {}) {
  const data = await loadScheduleRequestAudit();
  data.events.push({ auditId: `SCHEDREQ-AUDIT-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, requestId, action, user: String(user || 'Rep'), timestamp: new Date().toISOString(), previousValue, newValue, notes: String(notes || ''), sourcePage: 'Public PTO link' });
  await saveScheduleRequestAudit(data);
}

// --- Coaching (team lead creates/sends, rep views/signs) - mirrors the PTO storage
// helpers above; fully cloud-native, no snapshot/queue indirection, since both sides of
// this feature live on this server.
const COACHING_KEY = 'mtdkpi:coaching-records';
const COACHING_AUDIT_KEY = 'mtdkpi:coaching-audit';
const COACHING_CATEGORIES = ['Performance / KPI', 'Attendance & Punctuality', 'Schedule Adherence', 'Quality / CSAT', 'Behavior & Conduct', 'Productivity', 'Policy / Compliance', 'Other'];
async function loadCoaching() { return cloudStore.kvGetJson(COACHING_KEY, { version: 1, sequenceByYear: {}, records: [] }); }
async function saveCoaching(data) { data.lastUpdated = new Date().toISOString(); await cloudStore.kvSetJson(COACHING_KEY, data); return data; }
async function loadCoachingAudit() { return cloudStore.kvGetJson(COACHING_AUDIT_KEY, { version: 1, events: [] }); }
async function saveCoachingAudit(data) { data.lastUpdated = new Date().toISOString(); await cloudStore.kvSetJson(COACHING_AUDIT_KEY, data); return data; }
async function appendCoachingAudit(coachingId, action, { user = 'Team Lead', notes = '', previousValue = null, newValue = null } = {}) {
  const data = await loadCoachingAudit();
  data.events.push({ auditId: `COACH-AUDIT-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, coachingId, action, user: String(user || 'Team Lead'), timestamp: new Date().toISOString(), previousValue, newValue, notes: String(notes || ''), sourcePage: 'Public PTO link' });
  await saveCoachingAudit(data);
}
const ALIGNMENT_KEY = 'mtdkpi:alignment-records';
const ALIGNMENT_AUDIT_KEY = 'mtdkpi:alignment-audit';
const ALIGNMENT_CATEGORIES = ['SOP', 'Process Update', 'Feature Update', 'Attendance & Punctuality Policy', 'Schedule & Shift Policy', 'WFH/Onsite Policy', 'Compliance & Data Privacy', 'QA Scorecard Update', 'Client Policy / Script Update', 'KPI & Compensation Policy', 'Code of Conduct / HR Policy', 'Leave & PTO Policy', 'Business Continuity / Emergency Procedure', 'Security & Systems Access', 'Tool / System Migration'];
// Shown alongside each category in the picker so a team lead can tell them apart at a glance -
// purely descriptive, not stored on the record (only the plain category string is).
const ALIGNMENT_CATEGORY_HINTS = {
  'SOP': 'Standard operating procedure for a task or workflow',
  'Process Update': 'A change to how an existing process works',
  'Feature Update': 'A new or changed feature in a tool/system reps use',
  'Attendance & Punctuality Policy': 'Tardiness thresholds, NCNS consequences, absence rules',
  'Schedule & Shift Policy': 'Shift bidding, RD swaps, overtime rules',
  'WFH/Onsite Policy': 'Who is eligible for WFH vs required onsite',
  'Compliance & Data Privacy': 'Data Privacy Act, call-recording disclosure, regulatory requirements',
  'QA Scorecard Update': 'Changes to how calls/tickets are scored for quality',
  'Client Policy / Script Update': 'A specific client/campaign changed their script or policy',
  'KPI & Compensation Policy': 'Changes to KPI scoring or bonus/incentive structure',
  'Code of Conduct / HR Policy': 'Anti-harassment, dress code, social media, workplace conduct',
  'Leave & PTO Policy': 'Blackout dates, accrual rules, leave request changes',
  'Business Continuity / Emergency Procedure': 'Typhoon suspension, evacuation plan, disaster protocol',
  'Security & Systems Access': 'Password policy, clean-desk, tool/system access rules',
  'Tool / System Migration': 'Switching to a new CRM, dialer, or other work tool'
};
const ALIGNMENT_CATEGORY_OPTIONS = ALIGNMENT_CATEGORIES.map(value => ({ value, hint: ALIGNMENT_CATEGORY_HINTS[value] || '' }));
async function loadAlignment() { return cloudStore.kvGetJson(ALIGNMENT_KEY, { version: 1, sequenceByYear: {}, records: [] }); }
async function saveAlignment(data) { data.lastUpdated = new Date().toISOString(); await cloudStore.kvSetJson(ALIGNMENT_KEY, data); return data; }
async function loadAlignmentAudit() { return cloudStore.kvGetJson(ALIGNMENT_AUDIT_KEY, { version: 1, events: [] }); }
async function saveAlignmentAudit(data) { data.lastUpdated = new Date().toISOString(); await cloudStore.kvSetJson(ALIGNMENT_AUDIT_KEY, data); return data; }
async function appendAlignmentAudit(alignmentId, action, { user = 'Team Lead', notes = '', previousValue = null, newValue = null } = {}) {
  const data = await loadAlignmentAudit();
  data.events.push({ auditId: `ALIGN-AUDIT-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, alignmentId, action, user: String(user || 'Team Lead'), timestamp: new Date().toISOString(), previousValue, newValue, notes: String(notes || ''), sourcePage: 'Public PTO link' });
  await saveAlignmentAudit(data);
}
// Snapshot of the employee's standing at the moment a coaching record is created - frozen
// at creation time (never recomputed later), so the record stays an honest account of what
// was true when the conversation happened, same principle as a PTO request's approvedDates.
// Human-readable label per KPI metric key, scoped by kpiType since the same key means
// different things across engines (e.g. Senior TSR's "bonus" is call-volume based, not
// email/chat like Voice's). Falls back to a title-cased key for any kpiType/key this
// map doesn't know about, so an unrecognized metric still renders instead of vanishing.
const KPI_METRIC_LABELS = {
  'Voice Jr TSR': { csat: 'CSAT', calls: 'Calls per Day', lcr: 'Long Call Rate', bonus: 'Email/Chat Bonus' },
  'Voice Sr TSR': { csat: 'CSAT', calls: 'Calls per Day', lcr: 'Long Call Rate', bonus: 'Email/Chat Bonus' },
  'Non-Voice Jr TSR': { csat: 'CSAT', tickets: 'Tickets Solved', frt: 'First Response Time', bonus: 'Call Bonus' },
  'Non-Voice Sr TSR': { csat: 'CSAT', tickets: 'Tickets Solved', frt: 'First Response Time', bonus: 'Call Bonus' },
  'Senior TSR': { csat: 'CSAT (informational)', lcr: 'Long Call Rate (informational)', team: 'Team Average Base KPI', tickets: 'Tickets Updated', bonus: 'Call Volume Bonus' }
};
const KPI_METRIC_KEYS = ['csat', 'calls', 'lcr', 'bonus', 'tickets', 'frt', 'team'];
function metricValueText(m) {
  if (Number.isFinite(m.rate)) return `${Math.round(m.rate * 10) / 10}%`;
  if (Number.isFinite(m.average)) return `${Math.round(m.average * 10) / 10}%`;
  if (Number.isFinite(m.averageMinutes)) return `${Math.round(m.averageMinutes)} min avg`;
  if (Number.isFinite(m.dailyAverage)) return `${Math.round(m.dailyAverage * 10) / 10}/day`;
  if (Number.isFinite(m.solved)) return `${m.solved} solved`;
  if (Number.isFinite(m.unique)) return `${m.unique} updated`;
  if (Number.isFinite(m.accepted)) return `${m.accepted} calls`;
  return m.formula || '—';
}
function summarizeKpiMetrics(kpiRow) {
  if (!kpiRow) return [];
  const labels = KPI_METRIC_LABELS[kpiRow.kpiType] || {};
  return KPI_METRIC_KEYS.filter(k => kpiRow[k] && typeof kpiRow[k] === 'object').map(k => {
    const m = kpiRow[k];
    return {
      key: k,
      label: labels[k] || (k.charAt(0).toUpperCase() + k.slice(1)),
      value: metricValueText(m),
      formula: m.formula || '',
      points: Number.isFinite(m.points) ? m.points : (Number.isFinite(m.bonus) ? m.bonus : null),
      status: m.status || ''
    };
  });
}
async function buildCoachingStandingSnapshot(email) {
  const [kpiResults, attendance] = await Promise.all([loadKpiResultsSnapshot(), loadAttendanceSnapshot()]);
  const periods = kpiResults.periods || {};
  const latestPeriod = Object.keys(periods).sort((a, b) => b.localeCompare(a)).find(period => (periods[period] || []).some(x => ptoLogic.cleanEmail(x.employeeEmail) === email)) || '';
  const kpiRow = latestPeriod ? (periods[latestPeriod] || []).find(x => ptoLogic.cleanEmail(x.employeeEmail) === email) : null;
  const today = todayEasternDate();
  const last30 = ptoLogic.dateRange(shiftDate(today, -30), today);
  const counts = {};
  const lateOccurrences = [];
  const slOccurrences = [];
  for (const date of last30) {
    const code = ptoLogic.attendanceCodeOnDate(attendance, email, date);
    if (!code || code === 'ONSITE' || code === 'WFH' || code === 'RD') continue;
    counts[code] = (counts[code] || 0) + 1;
    if (code === 'LATE') {
      lateOccurrences.push({ date, minutesLate: ptoLogic.attendanceMinutesLateOnDate(attendance, email, date), reason: ptoLogic.attendanceReasonOnDate(attendance, email, date) || '' });
    } else if (code === 'SL' || code === 'SL-HD') {
      slOccurrences.push({ date, code, reason: ptoLogic.attendanceReasonOnDate(attendance, email, date) || '' });
    }
  }
  return {
    kpiPeriod: latestPeriod || null,
    kpiType: kpiRow?.kpiType || null,
    finalKpi: kpiRow?.finalKpi ?? null,
    baseKpi: kpiRow?.baseKpi ?? null,
    performanceStatus: kpiRow?.performanceStatus || 'Not Rated',
    metrics: summarizeKpiMetrics(kpiRow),
    last30DayAttendanceCounts: counts,
    last30DayLateOccurrences: lateOccurrences,
    last30DaySlOccurrences: slOccurrences,
    snapshotTakenAt: new Date().toISOString()
  };
}
function todayEasternDate() { const p = easternDateParts(new Date()); return `${p.year}-${p.month}-${p.day}`; }
// A "month|endDate" period key can end up dated in the future if a local admin's auto-refresh
// job was left pointed at a fixed calendar date (e.g. month-end) instead of tracking "today" -
// Zendesk just returns whatever's happened by request time under that mislabeled future key.
// Naively picking "latest" by string-sorting keys then makes that phantom key win over the
// real current period, silently serving stale/partial data under the wrong label as the
// default view (confirmed live for both Site KPI's Daily EOD Report and KPI results). Periods
// are filtered to real (non-future) ones wherever "the current period" is selected, including
// the selectable list itself - a period for a date that hasn't happened has nothing legitimate
// to show.
function currentPeriodKeys(periodKeys, today = todayEasternDate()) {
  return periodKeys.filter(key => (key.split('|')[1] || key) <= today);
}
function shiftDate(dateStr, deltaDays) { const [y, m, d] = dateStr.split('-').map(Number); const dt = new Date(Date.UTC(y, m - 1, d)); dt.setUTCDate(dt.getUTCDate() + deltaDays); return dt.toISOString().slice(0, 10); }
function shiftMonths(dateStr, deltaMonths) { const [y, m, d] = dateStr.split('-').map(Number); const dt = new Date(Date.UTC(y, m - 1 + deltaMonths, d)); return dt.toISOString().slice(0, 10); }

// --- Disciplinary Records (team lead files an Incident Report, HR decides the sanction,
// rep acknowledges) - mirrors the Coaching storage helpers above (direct shared KV, no
// snapshot/queue indirection). Distinct from Coaching per the handbook's own distinction:
// "coaching...is not deemed as a sanction." Based on Moatable's Code of Conduct and
// Discipline (progressive sanction ladder + prescriptive/cleansing period).
const DISCIPLINARY_KEY = 'mtdkpi:violations';
const DISCIPLINARY_AUDIT_KEY = 'mtdkpi:violation-audit';
const DISCIPLINARY_CATEGORIES = [
  'Attendance, Punctuality & Working Hours',
  'Office Attire',
  'Company Property, Information & Premises',
  'Accurate Reporting of Information',
  'Conflict of Interest',
  'General Behavior',
  "Manager's Accountability",
  'Client-Facing / Transactional Conduct',
  'Zero Tolerance'
];
const DISCIPLINE_TIERS = ['Misdemeanor', 'MinorOffense', 'MajorOffense', 'GraveOffense', 'Terminable'];
const DISCIPLINE_TIER_LABELS = { Misdemeanor: 'Misdemeanor', MinorOffense: 'Minor Offense', MajorOffense: 'Major Offense', GraveOffense: 'Grave Offense', Terminable: 'Terminable Offense' };
// Progressive ladder by instance count at that tier - matches the handbook's table
// exactly. A 6th+ instance of a tier whose ladder tops out sooner (e.g. Grave Offense's
// 2-rung ladder) stays at the ladder's last rung (Termination), it does not go out of
// bounds.
const DISCIPLINE_LADDER = {
  Misdemeanor: ['Coaching', 'Verbal Warning', 'Written Warning', 'Final Warning', 'Termination'],
  MinorOffense: ['Verbal Warning', 'Written Warning', 'Final Warning', 'Termination'],
  MajorOffense: ['Written Warning', 'Final Warning', 'Termination'],
  GraveOffense: ['Final Warning', 'Termination'],
  Terminable: ['Termination']
};
// Prescriptive/cleansing period in months per tier - null means it never cleanses
// (Terminable offenses carry no prescription period per the handbook).
const DISCIPLINE_CLEANSING_MONTHS = { Misdemeanor: 6, MinorOffense: 9, MajorOffense: 12, GraveOffense: 12, Terminable: null };
// Two-stage decision authority for disciplinary cases, distinct from PTO's single final
// approver: Charlotte (Senior Ops Manager) does the preliminary review after a team lead
// files, then Janet (HR) gives the actual final decision before it's shared with the
// employee.
const PRE_DISCIPLINARY_APPROVER_EMAIL = 'charlotte@lofty.com';
const FINAL_DISCIPLINARY_APPROVER_EMAIL = 'janet.memoracion@moatable.com';
// Reviews every bad CSAT ticket company-wide (not just her own team) for validity, and is the
// final approver on rep-filed CSAT disputes - a QA function distinct from the disciplinary
// HR/SOM chain above, so it gets its own role rather than overloading either of those.
const DSAT_REVIEWER_EMAIL = 'sunshine.simon@lofty.com';
// Training Manager: onboards new hires, tracks their training performance, and decides
// whether to endorse each one into a real production role/team - see the /api/training/*
// routes below. A trainee's teamLeadEmail is set to her during training, which is what
// naturally gives her Coaching/Disciplinary/Alignment/Team Attendance access to them too -
// those all already gate on "is this person's teamLeadEmail me," no new logic needed there.
const TRAINING_MANAGER_EMAILS = new Set(['priscilla@lofty.com']);
// Drives which tabs pto-public.html shows a signed-in user - most accounts are a normal
// rep/team-lead ('REP', the default), but a couple of identities hold a narrower,
// oversight-only role instead of day-to-day queue work, so their portal view is curated
// down to just what that role actually uses.
function portalRoleFor(email) {
  const clean = ptoLogic.cleanEmail(email);
  if (clean === FINAL_DISCIPLINARY_APPROVER_EMAIL) return 'HR';
  if (clean === PRE_DISCIPLINARY_APPROVER_EMAIL) return 'SOM';
  if (clean === DSAT_REVIEWER_EMAIL) return 'BQA';
  if (TRAINING_MANAGER_EMAILS.has(clean)) return 'TRAINING';
  return 'REP';
}
// The platform's own creator/admin can't otherwise see the QA/SOM/HR/TRAINING tabs - those
// are each tied to one specific person's email, and Mac isn't any of them (he already gets
// real Team Lead access on his own account since other active employees genuinely report to
// him - no preview needed there). "View As" is READ-ONLY: it only widens what a GET request
// returns, stored per-session via /api/my/view-as. Every write/decide endpoint below keeps
// checking portalRoleFor()/disciplinaryReviewAccess() against the REAL identity with no
// override, so an action taken while previewing can never get misattributed to the person
// being previewed.
const ADMIN_EMAILS = new Set(['mac@lofty.com']);
// Separate from ADMIN_EMAILS on purpose: Charlotte (SOM, department head) gets the View As
// preview to check what other roles see, but not the admin-only Copilot connection controls or
// credential-reset endpoint below - those stay Mac-only.
const VIEW_AS_ALLOWED_EMAILS = new Set([...ADMIN_EMAILS, 'charlotte@lofty.com']);
const VIEW_AS_ROLES = new Set(['BQA', 'SOM', 'HR', 'TRAINING', 'SENIOR TSR', 'REP']);
function canUseViewAs(identity) {
  return VIEW_AS_ALLOWED_EMAILS.has(ptoLogic.cleanEmail(identity));
}
function effectiveViewAsRole(identity, session) {
  return canUseViewAs(identity) ? String(session?.viewAsRole || '') : '';
}
// SOM oversees the whole roster as the department head, not just her own direct reports like a
// normal team lead - mirrors how she's already the FINAL_PTO_APPROVER_EMAIL and already sees
// every PTO request company-wide regardless of team. Widens Team Attendance/Team Roster/Team
// KPI the same way for her (and an admin previewing as SOM), everywhere those would otherwise
// scope to "people who report to me."
function isCompanyWideOverseer(identity, session) {
  return (effectiveViewAsRole(identity, session) || portalRoleFor(identity)) === 'SOM';
}
// HR and SOM always qualify; anyone else needs at least one active direct report (i.e. is
// actually a team lead) to post/manage announcements or Alignment items from this portal.
async function canManageAnnouncements(identity, employeeName) {
  const role = portalRoleFor(identity);
  if (role === 'HR' || role === 'SOM') return true;
  const roster = await loadRosterSnapshot();
  const signedInEmployee = (roster.records || []).find(x => ptoLogic.cleanEmail(x.employeeEmail) === identity) || null;
  const leaderName = String(signedInEmployee?.employeeName || employeeName || '').trim();
  return (roster.records || []).some(x => x.active !== false && ptoLogic.cleanEmail(x.employeeEmail) !== identity && (ptoLogic.cleanEmail(x.teamLeadEmail) === identity || String(x.teamLeadName || '').trim() === leaderName));
}

// Reward catalog management is a leadership call (what something costs, what's on offer), not
// something every team lead should be able to change unilaterally - same trio as who can
// decide a disciplinary case, minus the "or has direct reports" branch canManageAnnouncements
// has, since publishing a company-wide reward isn't the same bar as posting to your own team.
function canManageRewards(identity) {
  const role = portalRoleFor(identity);
  return role === 'HR' || role === 'SOM' || ADMIN_EMAILS.has(identity);
}
const REWARD_CATALOG_KEY = 'mtdkpi:reward-catalog';
const REWARD_REDEMPTIONS_KEY = 'mtdkpi:reward-redemptions';
// Points are earned from four things this app already tracks - never entered by hand, so
// there's nothing for a team lead to remember to log and no separate ledger that could drift
// from the data it's supposed to reflect (see computeAllPoints below for how "earned" is
// derived fresh every time; only "spent" - an actual redemption event - is a real ledger).
// Zeroed out - final point values per category haven't been decided yet. The categories and
// the computation below are otherwise complete; once real numbers are picked, just fill these
// back in and points start flowing without touching anything else.
const POINTS_PER_GOOD_CSAT = 0;
const POINTS_PER_GOOD_CSAT_WITH_COMMENT = 0;
const POINTS_BY_PERFORMANCE_TIER = { Exceptional: 0, Exceeds: 0, Meets: 0, Watch: 0, Intervention: 0, 'Not Rated': 0 };
const POINTS_PER_CLEAN_ATTENDANCE_MONTH = 0;
const MIN_WORKDAYS_FOR_CLEAN_MONTH_BONUS = 10;
const POINTS_PER_FIRST_TRY_QUIZ_PASS = 0;
const ATTENDANCE_INFRACTION_CODES = new Set(['LATE', 'NCNS', 'A', 'SUSPENDED']);
// Computes every employee's points, broken down by month and rolled up all-time, in one pass
// over the KPI/attendance/Alignment snapshots this app already maintains. Recomputed fresh on
// every call (the dataset is small - a few dozen employees, a handful of months) rather than
// cached, so it can never silently drift from the source data as that data gets corrected.
async function computeAllPoints() {
  const [kpiResultsData, attendanceData, alignmentData, roster] = await Promise.all([
    loadKpiResultsSnapshot(), loadAttendanceSnapshot(), loadAlignment(), loadRosterSnapshot()
  ]);
  const nameByEmail = {};
  for (const r of roster.records || []) nameByEmail[ptoLogic.cleanEmail(r.employeeEmail)] = r.employeeName;
  const byEmployee = {};
  const months = new Set();
  function ensure(email) {
    const clean = ptoLogic.cleanEmail(email);
    byEmployee[clean] ??= { employeeName: nameByEmail[clean] || clean, byMonth: {}, allTime: { total: 0, csat: 0, kpi: 0, attendance: 0, quiz: 0 } };
    return byEmployee[clean];
  }
  function add(email, month, amount, category) {
    if (!amount) return;
    months.add(month);
    const emp = ensure(email);
    emp.byMonth[month] ??= { total: 0, csat: 0, kpi: 0, attendance: 0, quiz: 0 };
    emp.byMonth[month].total += amount;
    emp.byMonth[month][category] += amount;
    emp.allTime.total += amount;
    emp.allTime[category] += amount;
  }

  // 1 & 2: CSAT good ratings and KPI performance tier, from the latest snapshot of each month.
  const kpiMonthKeys = {};
  for (const key of Object.keys(kpiResultsData.periods || {})) {
    const month = key.split('|')[0];
    if (!kpiMonthKeys[month] || key > kpiMonthKeys[month]) kpiMonthKeys[month] = key;
  }
  for (const [month, latestKey] of Object.entries(kpiMonthKeys)) {
    for (const row of kpiResultsData.periods[latestKey] || []) {
      const email = ptoLogic.cleanEmail(row.employeeEmail);
      for (const t of row.csat?.goodTickets || []) {
        add(email, month, (t.comment && t.comment.trim()) ? POINTS_PER_GOOD_CSAT_WITH_COMMENT : POINTS_PER_GOOD_CSAT, 'csat');
      }
      add(email, month, POINTS_BY_PERFORMANCE_TIER[row.performanceStatus] || 0, 'kpi');
    }
  }

  // 3: a clean attendance month - no Late/NCNS/Absent/Suspended among that employee's recorded
  // days that month, and enough recorded workdays to mean something (so a month with only 2
  // recorded days doesn't cheaply qualify as "clean").
  const attendanceMonthKeys = {};
  for (const key of Object.keys(attendanceData.periods || {})) {
    const month = key.split('|')[0];
    if (!attendanceMonthKeys[month] || key > attendanceMonthKeys[month]) attendanceMonthKeys[month] = key;
  }
  for (const [month, latestKey] of Object.entries(attendanceMonthKeys)) {
    const period = attendanceData.periods[latestKey] || {};
    for (const [rawEmail, byDate] of Object.entries(period)) {
      const email = ptoLogic.cleanEmail(rawEmail);
      const codes = Object.values(byDate || {}).map(v => (v && typeof v === 'object') ? v.status : v);
      const recordedWorkdays = codes.filter(c => c && c !== 'RD').length;
      const hasInfraction = codes.some(c => ATTENDANCE_INFRACTION_CODES.has(c));
      if (!hasInfraction && recordedWorkdays >= MIN_WORKDAYS_FOR_CLEAN_MONTH_BONUS) {
        add(email, month, POINTS_PER_CLEAN_ATTENDANCE_MONTH, 'attendance');
      }
    }
  }

  // 4: signing an Alignment item on the first try (zero wrong quiz attempts), credited to the
  // month they actually signed it in, not the month the item was published.
  for (const record of alignmentData.records || []) {
    if (!(record.quiz || []).length) continue;
    for (const [rawEmail, ack] of Object.entries(record.acknowledgments || {})) {
      if (ack && ack.quizAttempts === 0 && ack.signedAt) {
        add(rawEmail, String(ack.signedAt).slice(0, 7), POINTS_PER_FIRST_TRY_QUIZ_PASS, 'quiz');
      }
    }
  }

  return { byEmployee, months: [...months].sort() };
}

async function loadDisciplinary() { return cloudStore.kvGetJson(DISCIPLINARY_KEY, { version: 1, sequenceByYear: {}, records: [] }); }
async function saveDisciplinary(data) { data.lastUpdated = new Date().toISOString(); await cloudStore.kvSetJson(DISCIPLINARY_KEY, data); return data; }
async function loadDisciplinaryAudit() { return cloudStore.kvGetJson(DISCIPLINARY_AUDIT_KEY, { version: 1, events: [] }); }
async function saveDisciplinaryAudit(data) { data.lastUpdated = new Date().toISOString(); await cloudStore.kvSetJson(DISCIPLINARY_AUDIT_KEY, data); return data; }
async function loadTrainingScores() { return cloudStore.kvGetJson(TRAINING_SCORES_KEY, { version: 1, records: [] }); }
async function saveTrainingScores(data) { data.lastUpdated = new Date().toISOString(); await cloudStore.kvSetJson(TRAINING_SCORES_KEY, data); return data; }
// Who a trainee can be endorsed to: any active employee that some OTHER active employee's
// teamLeadEmail actually points to (self-references excluded) - the same "has direct reports"
// relationship used elsewhere (canManageAnnouncements, presenceEligibleRoster in
// zendesk-proxy.js) to identify a real team lead.
function eligibleTrainingDestinations(roster) {
  const active = (roster.records || []).filter(x => x.active !== false);
  const teamLeadEmails = new Set(active.filter(x => ptoLogic.cleanEmail(x.teamLeadEmail) && ptoLogic.cleanEmail(x.teamLeadEmail) !== ptoLogic.cleanEmail(x.employeeEmail)).map(x => ptoLogic.cleanEmail(x.teamLeadEmail)));
  return active.filter(x => teamLeadEmails.has(ptoLogic.cleanEmail(x.employeeEmail))).map(x => ({ employeeName: x.employeeName, employeeEmail: ptoLogic.cleanEmail(x.employeeEmail) }));
}
// Only one Training Manager exists today, so "the training identity" for View-As preview and
// for scoping training-scores reads is unambiguous - revisit this if a second one is added.
function trainingManagerIdentity() { return [...TRAINING_MANAGER_EMAILS][0] || ''; }
// Shared by team-coaching/team-disciplinary/team-attendance: a normal team lead's "my team" is
// anyone whose teamLeadEmail/teamLeadName points to them, any kpiType - but the Training
// Manager's access is intentionally narrower, restricted to actual trainees (kpiType
// 'Trainee') only, never a coworker who happens to name-match her for some unrelated reason.
// allowViewAs=false on write paths - an admin previewing as TRAINING must never get write
// access to Mae's trainees, only a real TRAINING identity's own real trainees do.
function scopedTeamMembers(roster, identity, session, employeeName, allowViewAs = true) {
  const viewingAsTraining = allowViewAs && effectiveViewAsRole(identity, session) === 'TRAINING';
  const isRealTraining = portalRoleFor(identity) === 'TRAINING';
  if (viewingAsTraining || isRealTraining) {
    const scopeIdentity = viewingAsTraining ? trainingManagerIdentity() : identity;
    return (roster.records || []).filter(x => x.active !== false && x.kpiType === 'Trainee' && ptoLogic.cleanEmail(x.teamLeadEmail) === scopeIdentity);
  }
  if (allowViewAs && isCompanyWideOverseer(identity, session)) {
    return (roster.records || []).filter(x => x.active !== false && ptoLogic.cleanEmail(x.employeeEmail) !== identity);
  }
  const signedInEmployee = (roster.records || []).find(x => ptoLogic.cleanEmail(x.employeeEmail) === identity) || null;
  const leaderName = String(signedInEmployee?.employeeName || employeeName || '').trim();
  return (roster.records || []).filter(x => x.active !== false && ptoLogic.cleanEmail(x.employeeEmail) !== identity && (ptoLogic.cleanEmail(x.teamLeadEmail) === identity || (leaderName && String(x.teamLeadName || '').trim() === leaderName)));
}
async function appendDisciplinaryAudit(violationId, action, { user = 'Team Lead', notes = '', previousValue = null, newValue = null } = {}) {
  const data = await loadDisciplinaryAudit();
  data.events.push({ auditId: `VIOL-AUDIT-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, violationId, action, user: String(user || 'Team Lead'), timestamp: new Date().toISOString(), previousValue, newValue, notes: String(notes || ''), sourcePage: 'Public PTO link' });
  await saveDisciplinaryAudit(data);
}
// viewAsRole only ever widens canPreDecide/canDecide for a caller reading the list (see the
// callers below - it's passed only on GET paths, never on a predecide/decide/acknowledge POST)
// so an admin previewing SOM/HR sees the same records that role would see, without those
// flags ever enabling an actual write - the POST endpoints below re-derive access from the
// real identity alone, with no viewAsRole argument at all.
async function disciplinaryReviewAccess(identity, employeeName = '', viewAsRole = '') {
  const roster = await loadRosterSnapshot();
  const records = roster.records || [];
  const cleanIdentity = ptoLogic.cleanEmail(identity);
  // Same Trainee-only restriction as scopedTeamMembers() - can't reuse it directly here since
  // this function only receives an already-resolved viewAsRole string, not the session object.
  const viewingAsTraining = viewAsRole === 'TRAINING';
  const isRealTraining = portalRoleFor(identity) === 'TRAINING';
  let memberEmails;
  if (viewingAsTraining || isRealTraining) {
    const scopeIdentity = viewingAsTraining ? trainingManagerIdentity() : cleanIdentity;
    memberEmails = new Set(records.filter(x => x.active !== false && x.kpiType === 'Trainee' && ptoLogic.cleanEmail(x.teamLeadEmail) === scopeIdentity).map(x => ptoLogic.cleanEmail(x.employeeEmail)));
  } else {
    const self = records.find(x => ptoLogic.cleanEmail(x.employeeEmail) === cleanIdentity);
    const leaderName = String(self?.employeeName || employeeName || '').trim().toLowerCase();
    memberEmails = new Set(records.filter(x =>
      ptoLogic.cleanEmail(x.employeeEmail) !== cleanIdentity &&
      (ptoLogic.cleanEmail(x.teamLeadEmail) === cleanIdentity ||
        (leaderName && String(x.teamLeadName || '').trim().toLowerCase() === leaderName))
    ).map(x => ptoLogic.cleanEmail(x.employeeEmail)));
  }
  return {
    memberEmails, isTeamLeader: memberEmails.size > 0,
    canPreDecide: cleanIdentity === PRE_DISCIPLINARY_APPROVER_EMAIL || viewAsRole === 'SOM',
    canDecide: cleanIdentity === FINAL_DISCIPLINARY_APPROVER_EMAIL || viewAsRole === 'HR',
    isHrOnly: cleanIdentity === FINAL_DISCIPLINARY_APPROVER_EMAIL || viewAsRole === 'HR'
  };
}
// Counts this employee's still-active (non-cleansed) prior violations at this exact tier
// - counting ANY infraction at that tier, not just repeats of the same specific rule, per
// the handbook's literal per-tier ladder and its "series of light offenses" habitualness
// clause. A record with no cleansingExpiryDate yet (not yet decided by HR) still counts -
// an undecided case is still an active case, not a cleansed one.
function disciplinaryInstanceAndSanction(tier, employeeEmail, infractionDate, existingRecords) {
  const email = ptoLogic.cleanEmail(employeeEmail);
  const activeCount = (existingRecords || []).filter(r =>
    ptoLogic.cleanEmail(r.employeeEmail) === email &&
    r.status !== 'WITHDRAWN' &&
    (r.finalTier || r.preTier || r.tier) === tier &&
    (!r.cleansingExpiryDate || r.cleansingExpiryDate > infractionDate)
  ).length;
  const instanceNumber = activeCount + 1;
  const ladder = DISCIPLINE_LADDER[tier] || [];
  const suggestedSanction = ladder[Math.min(instanceNumber, ladder.length) - 1] || ladder[ladder.length - 1] || 'Termination';
  return { instanceNumber, suggestedSanction };
}
function disciplinaryCleansingExpiry(sanctionDate, tier) {
  const months = DISCIPLINE_CLEANSING_MONTHS[tier];
  if (months == null) return null;
  return shiftMonths(sanctionDate, months);
}

// --- Rep self-reported status (Online/Break/Lunch/Offline Task) - a live "what am I doing right
// now" flag reps set themselves, separate from the schedule. Admins compare it against the
// resolved schedule and the live Zendesk signal on the Schedule Adherence dashboard.
async function loadRepStatus() { return cloudStore.kvGetJson(REP_STATUS_KEY, { version: 1, statuses: {} }); }
async function saveRepStatus(data) { data.lastUpdated = new Date().toISOString(); await cloudStore.kvSetJson(REP_STATUS_KEY, data); return data;
}
const PLANNED_OFFLINE_ACTIVITY_IDS = ['COACHING','TRAINING','TEAM_HUDDLE','ONE_ON_ONE','QA_REVIEW','MEETING','CALIBRATION','SIDE_BY_SIDE','PROJECT_WORK','ADMIN','DOCUMENTATION','CASE_REVIEW','OTHER_OFFLINE'];
function validScheduleTimeSlot(value) { return /^([01]\d|2[0-3]):[03]0$/.test(String(value || '')); }
function validExactTime(value) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || '')); }
function minutesOfSlot(value) { const [h, m] = String(value).split(':').map(Number); return h * 60 + m; }
function normalizeScheduleRequestBody(body, roster, current = null) {
  const email = ptoLogic.cleanEmail(body.employeeEmail);
  const employee = (roster || []).find(x => ptoLogic.cleanEmail(x.employeeEmail) === email);
  if (!employee) throw Object.assign(new Error('Employee must exist in the roster.'), { statusCode: 400 });
  const date = String(body.date ?? current?.date ?? '');
  if (!ptoLogic.validDate(date)) throw Object.assign(new Error('A valid request date is required.'), { statusCode: 400 });
  const requestType = String(body.requestType ?? current?.requestType ?? '');
  if (!['SHIFT_CHANGE', 'OFFLINE_TASK'].includes(requestType)) throw Object.assign(new Error('Request type must be SHIFT_CHANGE or OFFLINE_TASK.'), { statusCode: 400 });
  const reason = String(body.reason ?? current?.reason ?? '').trim();
  if (!reason) throw Object.assign(new Error('Reason is required.'), { statusCode: 400 });
  const now = new Date().toISOString();
  const out = { ...current, ...body, employeeEmail: email, employeeName: employee.employeeName, teamLeadName: employee.teamLeadName, teamLeadEmail: employee.teamLeadEmail || '', kpiType: employee.kpiType, date, requestType, reason, createdBy: String(body.createdBy ?? current?.createdBy ?? email), updatedAt: now };
  if (requestType === 'SHIFT_CHANGE') {
    out.requestedOff = body.requestedOff === true || body.requestedOff === 'true';
    if (!out.requestedOff) {
      out.requestedShiftStartEastern = String(body.requestedShiftStartEastern ?? current?.requestedShiftStartEastern ?? '');
      out.requestedShiftEndEastern = String(body.requestedShiftEndEastern ?? current?.requestedShiftEndEastern ?? '');
      if (!validScheduleTimeSlot(out.requestedShiftStartEastern) || !validScheduleTimeSlot(out.requestedShiftEndEastern)) throw Object.assign(new Error('A valid requested shift start and end time (30-minute increments) are required.'), { statusCode: 400 });
    } else { out.requestedShiftStartEastern = null; out.requestedShiftEndEastern = null; }
    out.activityId = null; out.startTime = null; out.endTime = null;
  } else {
    const activityId = String(body.activityId ?? current?.activityId ?? '').toUpperCase();
    if (!PLANNED_OFFLINE_ACTIVITY_IDS.includes(activityId)) throw Object.assign(new Error('A valid offline-task activity is required.'), { statusCode: 400 });
    const startTime = String(body.startTime ?? current?.startTime ?? ''), endTime = String(body.endTime ?? current?.endTime ?? '');
    if (!validExactTime(startTime) || !validExactTime(endTime) || minutesOfSlot(endTime) <= minutesOfSlot(startTime)) throw Object.assign(new Error('A valid start and end time (end after start) are required.'), { statusCode: 400 });
    out.activityId = activityId; out.startTime = startTime; out.endTime = endTime;
    out.requestedOff = null; out.requestedShiftStartEastern = null; out.requestedShiftEndEastern = null;
  }
  return out;
}
const SCHEDULE_REQUEST_ACTIVE_STATUSES = new Set(['SUBMITTED', 'PENDING', 'APPROVED']);
function scheduleRequestConflicts(candidate, requests, excludeId = '') { return (requests || []).filter(x => x.requestId !== excludeId && ptoLogic.cleanEmail(x.employeeEmail) === ptoLogic.cleanEmail(candidate.employeeEmail) && SCHEDULE_REQUEST_ACTIVE_STATUSES.has(x.status) && x.date === candidate.date); }

// --- Rep accounts (credentials + sessions) ---
function credentialKey(email) { return CREDENTIAL_KEY_PREFIX + ptoLogic.cleanEmail(email); }
function sessionKey(token) { return SESSION_KEY_PREFIX + token; }

async function loadCredential(email) { return cloudStore.kvGetJson(credentialKey(email), null); }
async function saveCredential(record) { await cloudStore.kvSetJson(credentialKey(record.employeeEmail), record); }

async function createSession(employeeEmail, employeeName, sessionVersion = 0) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const record = { employeeEmail, employeeName, sessionVersion, issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + SESSION_TTL_SECONDS * 1000).toISOString() };
  await cloudStore.kvSetJson(sessionKey(token), record, { exSeconds: SESSION_TTL_SECONDS });
  return token;
}

async function loadSession(token) {
  if (!token) return null;
  const record = await cloudStore.kvGetJson(sessionKey(token), null);
  if (!record) return null;
  if (new Date(record.expiresAt).getTime() <= Date.now()) return null;
  return record;
}

async function destroySession(token) {
  if (token) { try { await cloudStore.kvDel(sessionKey(token)); } catch { /* best-effort */ } }
}

// In-memory login rate limiting (per process - acceptable for a single-instance Render deploy).
const loginAttempts = new Map();
const chatLastPostAt = new Map();
const CHAT_POST_COOLDOWN_MS = 1200;
const CHAT_MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;
function pruneExpiredChatMessages(messages) {
  const cutoff = Date.now() - CHAT_MESSAGE_TTL_MS;
  return (messages || []).filter(m => !m.sentAt || new Date(m.sentAt).getTime() >= cutoff);
}
function assertNotLockedOut(email) {
  const entry = loginAttempts.get(email);
  if (entry && entry.lockedUntil && entry.lockedUntil > Date.now()) {
    const waitMin = Math.ceil((entry.lockedUntil - Date.now()) / 60000);
    throw Object.assign(new Error(`Too many failed attempts. Try again in ${waitMin} minute(s).`), { statusCode: 429 });
  }
}
function recordLoginFailure(email) {
  const entry = loginAttempts.get(email) || { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= MAX_LOGIN_ATTEMPTS) { entry.lockedUntil = Date.now() + LOGIN_LOCKOUT_MS; entry.count = 0; }
  loginAttempts.set(email, entry);
}
function clearLoginFailures(email) { loginAttempts.delete(email); }

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
    const parsed = new URL(req.url, `http://localhost:${PORT}`);
    const cookies = parseCookies(req);
    const isSecureReq = req.headers['x-forwarded-proto'] === 'https' || Boolean(req.socket.encrypted);

    // --- Always-reachable: page shell + static assets (the login form lives on this page) ---
    // The main HTML shell and its ES-module scripts have no ETag/Last-Modified, so without an
    // explicit no-cache a browser can serve a stale copy on a plain reload (or bfcache restore)
    // after a deploy - a rep or leadership-role account can then run old logic indefinitely
    // without any visible sign anything is wrong. Images/binary assets below are unaffected by
    // deploys in the same way, so they keep normal caching for performance.
    const NO_CACHE = { 'Cache-Control': 'no-cache' };
    if (parsed.pathname === '/' || parsed.pathname === '/pto') {
      const filePath = path.join(MTD_ROOT, 'pto-public.html');
      return sendText(res, 200, fs.readFileSync(filePath, 'utf8'), 'text/html; charset=utf-8', NO_CACHE);
    }

    if (parsed.pathname === '/manifest.json') {
      return sendText(res, 200, fs.readFileSync(path.join(MTD_ROOT, 'manifest.json'), 'utf8'), 'application/json; charset=utf-8', NO_CACHE);
    }

    if (parsed.pathname === '/sw.js') {
      return sendText(res, 200, fs.readFileSync(path.join(MTD_ROOT, 'sw.js'), 'utf8'), 'text/javascript; charset=utf-8', NO_CACHE);
    }

    const sharedBinaryMatch = parsed.pathname.match(/^\/shared\/([a-zA-Z0-9._/-]+)$/);
    if (sharedBinaryMatch && STATIC_SHARED_BINARY.has(sharedBinaryMatch[1])) {
      const filePath = path.join(MTD_ROOT, 'shared', sharedBinaryMatch[1]);
      return sendBinary(res, 200, fs.readFileSync(filePath), contentTypeFor(sharedBinaryMatch[1]));
    }

    const sharedMatch = parsed.pathname.match(/^\/shared\/([a-zA-Z0-9._-]+)$/);
    if (sharedMatch && STATIC_SHARED.has(sharedMatch[1])) {
      const filePath = path.join(MTD_ROOT, 'shared', sharedMatch[1]);
      return sendText(res, 200, fs.readFileSync(filePath, 'utf8'), contentTypeFor(sharedMatch[1]), NO_CACHE);
    }

    if (parsed.pathname === '/api/health') {
      return json(res, 200, { ok: true, success: true, server: 'online', timestamp: new Date().toISOString() });
    }

    // --- Auth endpoints ---
    if (parsed.pathname === '/api/auth/login' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const email = ptoLogic.cleanEmail(body.email);
      if (!email || !body.password) return json(res, 400, { ok: false, error: 'Email and password are required.' });
      try { assertNotLockedOut(email); } catch (err) { return json(res, err.statusCode || 429, { ok: false, error: err.message }); }
      const credential = await loadCredential(email);
      if (!credential || !ptoPassword.verifyPassword(body.password, credential.passwordHash)) {
        recordLoginFailure(email);
        return json(res, 401, { ok: false, error: 'Invalid email or password.' });
      }
      clearLoginFailures(email);
      const token = await createSession(credential.employeeEmail, credential.employeeName, credential.sessionVersion || 0);
      credential.lastLoginAt = new Date().toISOString();
      await saveCredential(credential);
      res.setHeader('Set-Cookie', sessionCookieHeader(token, isSecureReq));
      return json(res, 200, { ok: true, employeeEmail: credential.employeeEmail, employeeName: credential.employeeName, mustChangePassword: Boolean(credential.mustChangePassword), tourSeen: Boolean(credential.tourSeen), lastSeenVersion: credential.lastSeenVersion || '', portalVersion: PORTAL_VERSION, portalRole: portalRoleFor(credential.employeeEmail), isAdmin: ADMIN_EMAILS.has(ptoLogic.cleanEmail(credential.employeeEmail)), canUseViewAs: canUseViewAs(credential.employeeEmail), viewAsRole: '' });
    }

    // Admin-only: reset (or first-create) a rep's password. Not session-gated - gated by a
    // separate admin secret, since the rep whose password is being reset can't be logged in yet.
    if (parsed.pathname === '/api/admin/credentials/reset' && req.method === 'POST') {
      const suppliedAdminKey = req.headers['x-admin-key'] || '';
      if (!ADMIN_KEY || !suppliedAdminKey || !timingSafeEqualStr(suppliedAdminKey, ADMIN_KEY)) {
        return json(res, 403, { ok: false, error: 'A valid admin key is required.' });
      }
      const body = await readJsonBody(req);
      const email = ptoLogic.cleanEmail(body.employeeEmail);
      if (!email || !body.temporaryPassword) return json(res, 400, { ok: false, error: 'employeeEmail and temporaryPassword are required.' });
      const roster = await loadRosterSnapshot();
      const employee = (roster.records || []).find(x => ptoLogic.cleanEmail(x.employeeEmail) === email);
      if (!employee) return json(res, 400, { ok: false, error: 'Employee not found in the roster.' });
      const now = new Date().toISOString();
      const existing = await loadCredential(email);
      const record = {
        employeeEmail: email,
        employeeName: employee.employeeName,
        passwordHash: ptoPassword.hashPassword(body.temporaryPassword),
        mustChangePassword: body.mustChangePassword !== false,
        sessionVersion: (existing?.sessionVersion || 0) + 1,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
        lastLoginAt: existing?.lastLoginAt || null,
        tourSeen: Boolean(existing?.tourSeen)
      };
      await saveCredential(record);
      return json(res, 200, { ok: true, employeeEmail: email });
    }

    // Admin-only: send a one-off test email to confirm SendGrid sending/sender-verification works,
    // without creating any dispute record. Gated by the same admin secret as credential resets.
    if (parsed.pathname === '/api/admin/test-email' && req.method === 'POST') {
      const suppliedAdminKey = req.headers['x-admin-key'] || '';
      if (!ADMIN_KEY || !suppliedAdminKey || !timingSafeEqualStr(suppliedAdminKey, ADMIN_KEY)) {
        return json(res, 403, { ok: false, error: 'A valid admin key is required.' });
      }
      const body = await readJsonBody(req);
      const to = String(body.to || '').trim();
      if (!to) return json(res, 400, { ok: false, error: 'to is required.' });
      try {
        await emailService.send({
          to,
          subject: 'Lofty Support Portal - Test Email',
          html: `<p>This is a test email from the Lofty Support Portal to confirm SendGrid delivery is working.</p><p>Sent at ${escapeHtml(new Date().toISOString())}.</p>`
        });
        return json(res, 200, { ok: true, sent: true });
      } catch (error) {
        return json(res, 502, { ok: false, error: error.message });
      }
    }

    // --- Status Wall: key-gated (not session-gated) - a shareable floor-display link ---
    if (parsed.pathname === '/status-wall') {
      if (!statusWallKeyMatches(parsed, cookies)) return sendText(res, 401, 'Not authorized. Use the link provided to you.', 'text/plain; charset=utf-8');
      if (parsed.searchParams.get('key')) res.setHeader('Set-Cookie', statusWallCookieHeader(isSecureReq));
      return sendText(res, 200, fs.readFileSync(path.join(MTD_ROOT, 'status-wall.html'), 'utf8'), 'text/html; charset=utf-8');
    }

    if (parsed.pathname === '/api/status-wall' && req.method === 'GET') {
      if (!statusWallKeyMatches(parsed, cookies)) return json(res, 401, { ok: false, error: 'Not authorized.' });
      const data = await computeStatusWall();
      return json(res, 200, data);
    }

    // --- Spotlight Wall: key-gated (not session-gated), same shared link as Status Wall ---
    if (parsed.pathname === '/spotlight-wall') {
      if (!statusWallKeyMatches(parsed, cookies)) return sendText(res, 401, 'Not authorized. Use the link provided to you.', 'text/plain; charset=utf-8');
      if (parsed.searchParams.get('key')) res.setHeader('Set-Cookie', statusWallCookieHeader(isSecureReq));
      return sendText(res, 200, fs.readFileSync(path.join(MTD_ROOT, 'spotlight-wall.html'), 'utf8'), 'text/html; charset=utf-8');
    }

    if (parsed.pathname === '/api/spotlight-wall' && req.method === 'GET') {
      if (!statusWallKeyMatches(parsed, cookies)) return json(res, 401, { ok: false, error: 'Not authorized.' });
      const spotlight = await attachProfilePhotos(await loadSpotlightSnapshot());
      return json(res, 200, { ok: true, spotlight });
    }

    // --- Everything below requires a signed-in session ---
    const sessionToken = cookies[SESSION_COOKIE_NAME];
    const session = await loadSession(sessionToken);

    if (parsed.pathname === '/api/auth/logout' && req.method === 'POST') {
      await destroySession(sessionToken);
      res.setHeader('Set-Cookie', clearSessionCookieHeader(isSecureReq));
      return json(res, 200, { ok: true });
    }

    if (!session && parsed.pathname === '/api/auth/session' && req.method === 'GET') {
      return json(res, 200, { ok: true, authenticated: false });
    }

    if (!session) {
      return json(res, 401, { ok: false, error: 'Please sign in to continue.' });
    }

    const identity = ptoLogic.cleanEmail(session.employeeEmail);
    const credential = await loadCredential(identity);

    if (credential && (session.sessionVersion || 0) !== (credential.sessionVersion || 0)) {
      await destroySession(sessionToken);
      res.setHeader('Set-Cookie', clearSessionCookieHeader(isSecureReq));
      if (parsed.pathname === '/api/auth/session' && req.method === 'GET') return json(res, 200, { ok: true, authenticated: false });
      return json(res, 401, { ok: false, error: 'Your session has expired. Please sign in again.' });
    }

    const mustChangePassword = Boolean(credential?.mustChangePassword);

    if (parsed.pathname === '/api/auth/session' && req.method === 'GET') {
      const viewAsRole = effectiveViewAsRole(identity, session);
      return json(res, 200, { ok: true, authenticated: true, employeeEmail: session.employeeEmail, employeeName: session.employeeName, mustChangePassword, tourSeen: Boolean(credential?.tourSeen), lastSeenVersion: credential?.lastSeenVersion || '', portalVersion: PORTAL_VERSION, portalRole: viewAsRole || portalRoleFor(session.employeeEmail), isAdmin: ADMIN_EMAILS.has(identity), canUseViewAs: canUseViewAs(identity), viewAsRole });
    }

    // Admin-only, read-only: lets the platform's creator preview the QA/SOM/HR tabs (each tied
    // to one specific person's email otherwise) without signing in as that person. Stored on
    // the session itself so it persists across page loads until explicitly cleared - every
    // write/decide endpoint still checks the real identity, never this preference.
    if (parsed.pathname === '/api/my/view-as' && req.method === 'POST') {
      if (!canUseViewAs(identity)) return json(res, 403, { ok: false, error: 'Not authorized.' });
      const body = await readJsonBody(req);
      const role = String(body.role || '').toUpperCase();
      if (role && !VIEW_AS_ROLES.has(role)) return json(res, 400, { ok: false, error: 'Unknown preview role.' });
      const remainingSeconds = Math.max(60, Math.round((new Date(session.expiresAt).getTime() - Date.now()) / 1000));
      await cloudStore.kvSetJson(sessionKey(sessionToken), { ...session, viewAsRole: role }, { exSeconds: remainingSeconds });
      return json(res, 200, { ok: true, viewAsRole: role, portalRole: role || portalRoleFor(identity) });
    }

    if (parsed.pathname === '/api/my/tour-complete' && req.method === 'POST') {
      if (credential) { credential.tourSeen = true; credential.lastSeenVersion = PORTAL_VERSION; await saveCredential(credential); }
      return json(res, 200, { ok: true });
    }

    if (parsed.pathname === '/api/my/whats-new-seen' && req.method === 'POST') {
      if (credential) { credential.lastSeenVersion = PORTAL_VERSION; await saveCredential(credential); }
      return json(res, 200, { ok: true });
    }

    if (parsed.pathname === '/api/auth/change-password' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!credential || !ptoPassword.verifyPassword(body.currentPassword, credential.passwordHash)) {
        return json(res, 401, { ok: false, error: 'Current password is incorrect.' });
      }
      if (!body.newPassword || String(body.newPassword).length < 8) {
        return json(res, 400, { ok: false, error: 'New password must be at least 8 characters.' });
      }
      credential.passwordHash = ptoPassword.hashPassword(body.newPassword);
      credential.mustChangePassword = false;
      credential.sessionVersion = (credential.sessionVersion || 0) + 1;
      credential.updatedAt = new Date().toISOString();
      await saveCredential(credential);
      await destroySession(sessionToken);
      const newToken = await createSession(credential.employeeEmail, credential.employeeName, credential.sessionVersion);
      res.setHeader('Set-Cookie', sessionCookieHeader(newToken, isSecureReq));
      return json(res, 200, { ok: true });
    }

    // Only the caller's own roster record - the old employee-picker dropdown that needed
    // everyone's name is gone, so nothing on this page should see anyone else's record.
    if (parsed.pathname === '/api/roster' && req.method === 'GET') {
      const roster = await loadRosterSnapshot();
      const employee = (roster.records || []).find(x => ptoLogic.cleanEmail(x.employeeEmail) === identity) || null;
      return json(res, 200, { ok: true, employee, lastUpdated: roster.lastUpdated || '' });
    }

    if (parsed.pathname === '/api/my/contact' && req.method === 'PUT') {
      const body = await readJsonBody(req);
      const update = {};
      for (const field of ROSTER_CONTACT_FIELDS) update[field] = String(body[field] || '').trim();
      if (update.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(update.contactEmail)) return json(res, 400, { ok: false, error: 'Contact email is invalid.' });
      if (update.birthday && !ptoLogic.validDate(update.birthday)) return json(res, 400, { ok: false, error: 'Birthday must be a valid date.' });
      const roster = await loadRosterSnapshot();
      const index = (roster.records || []).findIndex(x => ptoLogic.cleanEmail(x.employeeEmail) === identity);
      if (index < 0) return json(res, 400, { ok: false, error: 'Employee not found in the roster.' });
      roster.records[index] = { ...roster.records[index], ...update };
      await cloudStore.kvSetJson('mtdkpi:snapshot:roster', roster);
      snapshotCache.set('mtdkpi:snapshot:roster', { value: roster, at: Date.now() });
      const pending = await cloudStore.kvGetJson('mtdkpi:roster-contact-updates', {});
      // Merge onto any not-yet-synced pending entry rather than replacing it outright - a
      // team lead editing this same employee's full profile via /api/my/team-roster within
      // the same ~30s sync window would otherwise have their update silently discarded (or
      // vice versa) by whichever write lands last.
      pending[identity] = { ...(pending[identity] || {}), employeeEmail: identity, ...update, updatedAt: new Date().toISOString() };
      await cloudStore.kvSetJson('mtdkpi:roster-contact-updates', pending);
      return json(res, 200, { ok: true, employee: roster.records[index] });
    }

    // Small enough (client-side resized to a square JPEG before upload) to live directly in
    // the cloud store keyed per employee - no local-disk sync needed like the attendance
    // attachments, since this is just a live display value, not an HR record.
    if (parsed.pathname === '/api/my/profile-photo' && req.method === 'GET') {
      const photo = await cloudStore.kvGetJson(PROFILE_PHOTO_KEY_PREFIX + identity, null);
      return json(res, 200, { ok: true, photoBase64: photo?.contentBase64 || '' });
    }

    if (parsed.pathname === '/api/my/profile-photo' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const contentBase64 = String(body.contentBase64 || '');
      if (!/^data:image\/(jpeg|png|webp);base64,/.test(contentBase64)) return json(res, 400, { ok: false, error: 'A valid image is required.' });
      if (contentBase64.length > MAX_PROFILE_PHOTO_BASE64_LENGTH) return json(res, 400, { ok: false, error: 'Photo is too large.' });
      await cloudStore.kvSetJson(PROFILE_PHOTO_KEY_PREFIX + identity, { contentBase64, updatedAt: new Date().toISOString() });
      return json(res, 200, { ok: true, photoBase64: contentBase64 });
    }

    if (parsed.pathname === '/api/my/profile-photo' && req.method === 'DELETE') {
      await cloudStore.kvSetJson(PROFILE_PHOTO_KEY_PREFIX + identity, null);
      return json(res, 200, { ok: true });
    }

    if (parsed.pathname === '/api/my/team-roster' && req.method === 'GET') {
      const roster = await loadRosterSnapshot();
      const assignedMembers = scopedTeamMembers(roster, identity, session, session.employeeName);
      return json(res, 200, { ok: true, isTeamLeader: assignedMembers.length > 0, members: assignedMembers });
    }

    if (parsed.pathname === '/api/my/team-roster' && req.method === 'PUT') {
      const body = await readJsonBody(req);
      const targetEmail = ptoLogic.cleanEmail(body.employeeEmail || '');
      if (!targetEmail) return json(res, 400, { ok: false, error: 'employeeEmail is required.' });
      const roster = await loadRosterSnapshot();
      const memberEmails = new Set(scopedTeamMembers(roster, identity, session, session.employeeName, false).map(x => ptoLogic.cleanEmail(x.employeeEmail)));
      if (!memberEmails.has(targetEmail)) return json(res, 403, { ok: false, error: 'That employee is not on your team.' });
      const index = (roster.records || []).findIndex(x => ptoLogic.cleanEmail(x.employeeEmail) === targetEmail);
      if (index < 0) return json(res, 400, { ok: false, error: 'Employee not found in the roster.' });
      const update = {};
      for (const field of TEAM_EDITABLE_PROFILE_FIELDS) update[field] = String(body[field] || '').trim();
      if (!update.employeeName) return json(res, 400, { ok: false, error: 'Employee name is required.' });
      if (update.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(update.contactEmail)) return json(res, 400, { ok: false, error: 'Contact email is invalid.' });
      if (update.birthday && !ptoLogic.validDate(update.birthday)) return json(res, 400, { ok: false, error: 'Birthday must be a valid date.' });
      if (update.hireDate && !ptoLogic.validDate(update.hireDate)) return json(res, 400, { ok: false, error: 'Hire date must be a valid date.' });
      roster.records[index] = { ...roster.records[index], ...update };
      await cloudStore.kvSetJson('mtdkpi:snapshot:roster', roster);
      snapshotCache.set('mtdkpi:snapshot:roster', { value: roster, at: Date.now() });
      const pending = await cloudStore.kvGetJson('mtdkpi:roster-contact-updates', {});
      pending[targetEmail] = { ...(pending[targetEmail] || {}), employeeEmail: targetEmail, ...update, updatedAt: new Date().toISOString() };
      await cloudStore.kvSetJson('mtdkpi:roster-contact-updates', pending);
      return json(res, 200, { ok: true, employee: roster.records[index] });
    }

    if (parsed.pathname === '/api/chat/messages' && req.method === 'GET') {
      const messages = await cloudStore.kvGetJson('mtdkpi:chat:messages', []);
      return json(res, 200, { ok: true, messages: pruneExpiredChatMessages(messages) });
    }

    if (parsed.pathname === '/api/chat/messages' && req.method === 'POST') {
      const lastPostAt = chatLastPostAt.get(identity) || 0;
      if (Date.now() - lastPostAt < CHAT_POST_COOLDOWN_MS) return json(res, 429, { ok: false, error: 'You are sending messages too quickly. Please slow down.' });
      const body = await readJsonBody(req);
      const text = String(body.text || '').trim().slice(0, 2000);
      if (!text) return json(res, 400, { ok: false, error: 'Message text is required.' });
      chatLastPostAt.set(identity, Date.now());
      const messages = pruneExpiredChatMessages(await cloudStore.kvGetJson('mtdkpi:chat:messages', []));
      const message = { id: crypto.randomBytes(8).toString('hex'), senderEmail: identity, senderName: session.employeeName, text, sentAt: new Date().toISOString() };
      messages.push(message);
      while (messages.length > 200) messages.shift();
      await cloudStore.kvSetJson('mtdkpi:chat:messages', messages);
      const presence = await cloudStore.kvGetJson('mtdkpi:chat:presence', {});
      presence[identity] = { name: session.employeeName, lastSeenAt: new Date().toISOString() };
      await cloudStore.kvSetJson('mtdkpi:chat:presence', presence);
      return json(res, 200, { ok: true, message });
    }

    const chatMessageMatch = parsed.pathname.match(/^\/api\/chat\/messages\/([^/]+)$/);
    if (chatMessageMatch && req.method === 'DELETE') {
      const messageId = decodeURIComponent(chatMessageMatch[1]);
      const messages = await cloudStore.kvGetJson('mtdkpi:chat:messages', []);
      const index = messages.findIndex(x => x.id === messageId);
      if (index < 0) return json(res, 404, { ok: false, error: 'Message not found.' });
      if (messages[index].senderEmail !== identity) return json(res, 403, { ok: false, error: 'You can only delete your own messages.' });
      messages.splice(index, 1);
      await cloudStore.kvSetJson('mtdkpi:chat:messages', messages);
      return json(res, 200, { ok: true, deleted: messageId });
    }

    if (parsed.pathname === '/api/chat/presence' && req.method === 'POST') {
      const presence = await cloudStore.kvGetJson('mtdkpi:chat:presence', {});
      presence[identity] = { name: session.employeeName, lastSeenAt: new Date().toISOString() };
      await cloudStore.kvSetJson('mtdkpi:chat:presence', presence);
      return json(res, 200, { ok: true });
    }

    if (parsed.pathname === '/api/chat/presence' && req.method === 'GET') {
      const presence = await cloudStore.kvGetJson('mtdkpi:chat:presence', {});
      const cutoff = Date.now() - 60000;
      const online = Object.entries(presence)
        .filter(([, v]) => new Date(v.lastSeenAt).getTime() >= cutoff)
        .map(([email, v]) => ({ email, name: v.name }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return json(res, 200, { ok: true, online });
    }

    if (parsed.pathname === '/api/my/csat-disputes' && req.method === 'GET') {
      const disputes = await cloudStore.kvGetJson(DISPUTES_KEY, []);
      const mine = disputes.filter(x => x.employeeEmail === identity);
      return json(res, 200, { ok: true, disputes: mine });
    }

    if (parsed.pathname === '/api/my/csat-disputes' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const ticketId = String(body.ticketId || '').trim();
      const period = String(body.period || '').trim();
      const reason = String(body.reason || '').trim();
      if (!ticketId || !period || !reason) return json(res, 400, { ok: false, error: 'ticketId, period, and reason are required.' });

      const kpiResults = await loadKpiResultsSnapshot();
      const rows = (kpiResults.periods || {})[period] || [];
      const row = rows.find(x => ptoLogic.cleanEmail(x.employeeEmail) === identity);
      if (!row) return json(res, 404, { ok: false, error: 'KPI result not found for that period.' });
      const ticket = (row.csat?.badTickets || []).find(t => String(t.ticketId) === ticketId);
      if (!ticket) return json(res, 404, { ok: false, error: 'That ticket was not found among your bad-rated CSAT tickets for this period.' });

      const disputes = await cloudStore.kvGetJson(DISPUTES_KEY, []);
      const existing = disputes.find(x => x.employeeEmail === identity && String(x.ticketId) === ticketId && ['PENDING', 'APPROVED'].includes(x.status));
      if (existing) return json(res, 409, { ok: false, error: `This ticket already has a dispute (${existing.status}).` });

      const roster = await loadRosterSnapshot();
      const employee = (roster.records || []).find(x => ptoLogic.cleanEmail(x.employeeEmail) === identity);
      const teamLeadEmail = employee?.teamLeadEmail ? ptoLogic.cleanEmail(employee.teamLeadEmail) : '';

      const now = new Date().toISOString();
      const dispute = {
        id: `DISPUTE-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
        employeeEmail: identity,
        employeeName: session.employeeName,
        ticketId,
        ticketSubject: ticket.subject || '',
        surveyDate: ticket.surveyDate || '',
        comment: ticket.comment || '',
        period,
        reason,
        status: 'PENDING',
        createdAt: now,
        decidedAt: null,
        decidedBy: '',
        decisionNotes: ''
      };
      disputes.push(dispute);
      await cloudStore.kvSetJson(DISPUTES_KEY, disputes);

      const recipients = [teamLeadEmail].filter(Boolean);
      let emailSent = false, emailError = '';
      try {
        await emailService.send({
          to: recipients.length ? recipients : [DISPUTE_CC_EMAIL],
          cc: recipients.length ? [DISPUTE_CC_EMAIL] : [],
          subject: `CSAT Dispute Filed - ${session.employeeName} - Ticket #${ticketId}`,
          html: `<p><b>${escapeHtml(session.employeeName)}</b> (${escapeHtml(identity)}) has filed a dispute for a bad CSAT rating.</p>` +
            `<p><b>Ticket:</b> #${escapeHtml(ticketId)} - ${escapeHtml(ticket.subject || '(no subject)')}<br>` +
            `<b>Period:</b> ${escapeHtml(period)}<br>` +
            `<b>Survey Date:</b> ${escapeHtml(ticket.surveyDate ? new Date(ticket.surveyDate).toLocaleDateString() : 'Unknown')}</p>` +
            (ticket.comment ? `<p><b>Customer comment:</b> "${escapeHtml(ticket.comment)}"</p>` : '') +
            `<p><b>Rep's reason for dispute:</b><br>${escapeHtml(reason)}</p>` +
            `<p>Please review and approve or reject this dispute on the internal admin dashboard.</p>`
        });
        emailSent = true;
      } catch (error) {
        emailError = error.message;
      }
      return json(res, 201, { ok: true, dispute, emailSent, emailError: emailError || undefined });
    }

    // QA DSAT review: company-wide, not scoped to any one team - Sunshine reviews every bad
    // CSAT ticket (disputed or not) and is the final approver on rep-filed disputes too. Source
    // is site-metrics' badTicketsDetail (every bad-rated ticket site-wide, resolved against the
    // FULL active roster), not kpi-results.json's per-employee badTickets - that field is scoped
    // to Voice/Non-Voice/Senior TSR for KPI-scoring purposes and would silently hide bad CSAT
    // tickets assigned to a Database Agent, a team lead, or anyone else active.
    if (parsed.pathname === '/api/qa/dsat-review' && req.method === 'GET') {
      if (portalRoleFor(identity) !== 'BQA' && effectiveViewAsRole(identity, session) !== 'BQA') return json(res, 403, { ok: false, error: 'Not authorized.' });
      const siteMetricsData = await loadSiteMetricsSnapshot();
      const availablePeriods = currentPeriodKeys(Object.keys(siteMetricsData.periods || {})).sort((a, b) => b.localeCompare(a));
      const requestedPeriod = String(parsed.searchParams.get('period') || '');
      const period = (requestedPeriod && siteMetricsData.periods[requestedPeriod]) ? requestedPeriod : (availablePeriods[0] || '');
      const badTicketsDetail = (period && siteMetricsData.periods[period]?.csat?.badTicketsDetail) || [];
      const disputes = await cloudStore.kvGetJson(DISPUTES_KEY, []);
      const aiCache = await cloudStore.kvGetJson(DSAT_AI_CACHE_KEY, {});
      const tickets = badTicketsDetail.map(t => {
        const employeeEmail = ptoLogic.cleanEmail(t.employeeEmail || '');
        const dispute = disputes.find(x => String(x.ticketId) === String(t.ticketId) && ptoLogic.cleanEmail(x.employeeEmail) === employeeEmail);
        const commentHash = crypto.createHash('sha1').update(`${t.subject || ''}|${t.comment || ''}`).digest('hex');
        const cachedAnalysis = aiCache[t.ticketId]?.commentHash === commentHash ? aiCache[t.ticketId] : null;
        return {
          employeeEmail, employeeName: t.employeeName || 'Unassigned',
          ticketId: t.ticketId, subject: t.subject || '', surveyDate: t.surveyDate || '', comment: t.comment || '',
          period, aiAnalysis: cachedAnalysis,
          dispute: dispute ? { id: dispute.id, status: dispute.status, reason: dispute.reason, decidedBy: dispute.decidedBy, decisionNotes: dispute.decisionNotes, decidedAt: dispute.decidedAt, filedByQa: Boolean(dispute.filedByQa) } : null
        };
      });
      tickets.sort((a, b) => (b.surveyDate || '').localeCompare(a.surveyDate || ''));
      return json(res, 200, { ok: true, period, availablePeriods, tickets });
    }

    // This server has no Zendesk credentials of its own and can't pull fresh CSAT data
    // directly - it can only queue a request in Upstash for the local admin process
    // (zendesk-proxy.js) to pick up on its next ~30s sync tick and act on. Non-destructive
    // (just asks for a data pull, decides nothing), so it's allowed the same way the GET
    // above is - real QA identity or an admin currently previewing as QA.
    if (parsed.pathname === '/api/qa/dsat-review/refresh' && req.method === 'POST') {
      if (portalRoleFor(identity) !== 'BQA' && effectiveViewAsRole(identity, session) !== 'BQA') return json(res, 403, { ok: false, error: 'Not authorized.' });
      const body = await readJsonBody(req);
      const period = String(body.period || '').trim();
      const [month, endDate] = period.includes('|') ? period.split('|') : ['', ''];
      const resolvedMonth = /^\d{4}-\d{2}$/.test(month) ? month : todayEasternDate().slice(0, 7);
      const resolvedEndDate = ptoLogic.validDate(endDate) ? endDate : todayEasternDate();
      const queue = await cloudStore.kvGetJson(CSAT_REFRESH_REQUESTS_KEY, []);
      queue.push({ month: resolvedMonth, endDate: resolvedEndDate, requestedBy: identity, requestedAt: new Date().toISOString() });
      await cloudStore.kvSetJson(CSAT_REFRESH_REQUESTS_KEY, queue);
      return json(res, 200, { ok: true, requested: { month: resolvedMonth, endDate: resolvedEndDate } });
    }

    if (parsed.pathname === '/api/qa/dsat-review/decide' && req.method === 'POST') {
      if (portalRoleFor(identity) !== 'BQA') return json(res, 403, { ok: false, error: 'Not authorized.' });
      const body = await readJsonBody(req);
      const decision = String(body.decision || '').toUpperCase();
      if (!['APPROVED', 'REJECTED'].includes(decision)) return json(res, 400, { ok: false, error: 'A valid decision (APPROVED or REJECTED) is required.' });
      const notes = String(body.notes || '').trim();
      const disputes = await cloudStore.kvGetJson(DISPUTES_KEY, []);
      let index = body.disputeId ? disputes.findIndex(x => x.id === String(body.disputeId)) : -1;
      const now = new Date().toISOString();
      if (index < 0) {
        // No dispute exists yet for this ticket - she's flagging it herself. There's no
        // "pending" step in that case: filed and decided in the same action.
        const ticketId = String(body.ticketId || '').trim();
        const period = String(body.period || '').trim();
        if (!ticketId || !period) return json(res, 400, { ok: false, error: 'ticketId and period are required.' });
        const siteMetricsData = await loadSiteMetricsSnapshot();
        const badTicketsDetail = (siteMetricsData.periods || {})[period]?.csat?.badTicketsDetail || [];
        const ticket = badTicketsDetail.find(t => String(t.ticketId) === ticketId);
        if (!ticket) return json(res, 404, { ok: false, error: 'That ticket was not found among the bad-rated CSAT tickets for this period.' });
        const employeeEmail = ptoLogic.cleanEmail(body.employeeEmail || ticket.employeeEmail || '');
        disputes.push({
          id: `DISPUTE-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
          employeeEmail, employeeName: ticket.employeeName || employeeEmail || 'Unassigned',
          ticketId, ticketSubject: ticket.subject || '', surveyDate: ticket.surveyDate || '', comment: ticket.comment || '',
          period, reason: 'Flagged during QA DSAT review', status: 'PENDING', createdAt: now, decidedAt: null, decidedBy: '', decisionNotes: '', filedByQa: true
        });
        index = disputes.length - 1;
      }
      const dispute = disputes[index];
      if (dispute.status !== 'PENDING') return json(res, 409, { ok: false, error: `This dispute has already been ${dispute.status.toLowerCase()}.` });
      disputes[index] = { ...dispute, status: decision, decidedAt: now, decidedBy: session.employeeName, decisionNotes: notes };
      let kpiAdjustment = null;
      if (decision === 'APPROVED') {
        const notValidDsatCount = disputes.filter(x => x.status === 'APPROVED' && ptoLogic.cleanEmail(x.employeeEmail) === ptoLogic.cleanEmail(dispute.employeeEmail) && x.period === dispute.period).length;
        const kpiResultsData = await loadKpiResultsSnapshot();
        const rows = (kpiResultsData.periods || {})[dispute.period] || [];
        const row = rows.find(x => ptoLogic.cleanEmail(x.employeeEmail) === ptoLogic.cleanEmail(dispute.employeeEmail));
        if (row) {
          kpiAdjustment = buildDsatKpiAdjustment(row, notValidDsatCount);
          if (kpiAdjustment) kpiAdjustment.lastAdjustedAt = now;
        }
        // This is stored on the dispute record purely as an audit snapshot of what the
        // adjustment looked like at the moment of this decision - it is NOT what the rep's own
        // KPI tab displays. /api/my/kpi recomputes the adjustment fresh on every read (via
        // buildDsatKpiAdjustment, counting all currently-APPROVED disputes for that
        // employee/period) precisely so it never depends on which route decided a dispute, or
        // on kpi-results.json - a file this process must never write to directly, since
        // zendesk-proxy.js owns it and overwrites it wholesale on every cloud sync tick.
        disputes[index].kpiAdjustment = kpiAdjustment;
      }
      await cloudStore.kvSetJson(DISPUTES_KEY, disputes);
      return json(res, 200, { ok: true, dispute: disputes[index], kpiAdjustment });
    }

    // Copilot connection status - readable by BQA (so DSAT Review can explain why AI triage
    // isn't showing up), by anyone who could use Rephrase or Alignment quiz generation (those
    // now try Copilot before falling back to Groq - see rephraseText/generateQuizWithFallback
    // client-side), and by the admin who manages the connection. The token itself is included
    // for all of them: each one's own browser needs it to call tsr-bot directly (see the
    // file-level comment above loadCopilotAuth for why this can't happen server-side).
    if (parsed.pathname === '/api/admin/copilot/status' && req.method === 'GET') {
      const canUseCopilot = ADMIN_EMAILS.has(identity) || portalRoleFor(identity) === 'BQA' || effectiveViewAsRole(identity, session) === 'BQA'
        || ['SOM', 'HR', 'TRAINING'].includes(portalRoleFor(identity)) || (await hasDirectReports(identity, session.employeeName, effectiveViewAsRole(identity, session)));
      if (!canUseCopilot) return json(res, 403, { ok: false, error: 'Not authorized.' });
      const auth = await loadCopilotAuth();
      if (!auth) return json(res, 200, { ok: true, connected: false, isAdmin: ADMIN_EMAILS.has(identity) });
      return json(res, 200, { ok: true, connected: true, email: auth.email, connectedAt: auth.connectedAt, token: auth.token, isAdmin: ADMIN_EMAILS.has(identity) });
    }
    // The admin's own browser completes tsr-bot's send-code/verify-code flow directly (client-
    // side - see pto-public.html's copilotSendCodeBtn/copilotVerifyBtn handlers) and only hands
    // the resulting token here to persist it, shared from then on with every BQA reviewer.
    if (parsed.pathname === '/api/admin/copilot/save-connection' && req.method === 'POST') {
      if (!ADMIN_EMAILS.has(identity)) return json(res, 403, { ok: false, error: 'Not authorized.' });
      const body = await readJsonBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      const token = String(body.token || '').trim();
      if (!token) return json(res, 400, { ok: false, error: 'A Copilot token is required.' });
      await saveCopilotAuth({ token, email, connectedAt: new Date().toISOString(), connectedBy: identity });
      return json(res, 200, { ok: true });
    }
    if (parsed.pathname === '/api/admin/copilot/disconnect' && req.method === 'POST') {
      if (!ADMIN_EMAILS.has(identity)) return json(res, 403, { ok: false, error: 'Not authorized.' });
      await clearCopilotAuth();
      return json(res, 200, { ok: true });
    }

    // Caches an AI triage result the client already obtained by calling tsr-bot's /chat/messages
    // directly (browser-side, same reason as above) - this route's job is just to verify the
    // ticket is real for this period and persist the result, shared across every reviewer so
    // re-opening the queue doesn't cost another Copilot call for a ticket someone already
    // triaged. Hash is computed here, not trusted from the client, so a stale/mismatched result
    // can't poison the cache.
    if (parsed.pathname === '/api/qa/dsat-review/save-analysis' && req.method === 'POST') {
      if (portalRoleFor(identity) !== 'BQA' && effectiveViewAsRole(identity, session) !== 'BQA') return json(res, 403, { ok: false, error: 'Not authorized.' });
      const body = await readJsonBody(req);
      const ticketId = String(body.ticketId || '').trim();
      const period = String(body.period || '').trim();
      const analysis = body.analysis || {};
      if (!ticketId || !period) return json(res, 400, { ok: false, error: 'ticketId and period are required.' });
      const siteMetricsData = await loadSiteMetricsSnapshot();
      const badTicketsDetail = (siteMetricsData.periods || {})[period]?.csat?.badTicketsDetail || [];
      const ticket = badTicketsDetail.find(t => String(t.ticketId) === ticketId);
      if (!ticket) return json(res, 404, { ok: false, error: 'That ticket was not found among the bad-rated CSAT tickets for this period.' });
      const commentHash = crypto.createHash('sha1').update(`${ticket.subject || ''}|${ticket.comment || ''}`).digest('hex');
      const cache = await cloudStore.kvGetJson(DSAT_AI_CACHE_KEY, {});
      const saved = { sentiment: String(analysis.sentiment || 'Unknown').slice(0, 40), risk: String(analysis.risk || 'Unknown').slice(0, 40), summary: String(analysis.summary || '').slice(0, 400), commentHash, analyzedAt: new Date().toISOString() };
      cache[ticketId] = saved;
      await cloudStore.kvSetJson(DSAT_AI_CACHE_KEY, cache);
      return json(res, 200, { ok: true, analysis: saved });
    }

    // Only BQA's own on-behalf sessions for this employee - not the employee's full coaching
    // history from their real team lead, which BQA has no visibility into or authority over.
    // This lets progression tracking recognize "how many times has BQA had to step in for this
    // person's DSAT issues" as its own thread, without mixing it with the team lead's separate
    // coaching track.
    if (parsed.pathname === '/api/qa/coaching-history' && req.method === 'GET') {
      if (portalRoleFor(identity) !== 'BQA') return json(res, 403, { ok: false, error: 'Not authorized.' });
      const employeeEmail = ptoLogic.cleanEmail(parsed.searchParams.get('employeeEmail') || '');
      if (!employeeEmail) return json(res, 400, { ok: false, error: 'employeeEmail is required.' });
      const data = await loadCoaching();
      const records = (data.records || []).filter(x => ptoLogic.cleanEmail(x.employeeEmail) === employeeEmail && x.createdBy === identity).sort((a, b) => b.coachingDate.localeCompare(a.coachingDate));
      return json(res, 200, { ok: true, records });
    }

    // Admin-posted announcements (MTD_Announcements.html) live in a one-way snapshot key -
    // zendesk-proxy.js overwrites mtdkpi:snapshot:announcements wholesale from its local file
    // every sync tick, so anything written there from this server would vanish within ~30s.
    // Portal-posted ones (Team Leads/HR/SOM, added below) go in their own additive key instead
    // and get merged in here at read time - no risk of either side clobbering the other.
    const PUBLIC_ANNOUNCEMENTS_KEY = 'mtdkpi:public-announcements';
    if (parsed.pathname === '/api/my/announcements' && req.method === 'GET') {
      const [snapshot, publicAnnouncements, canManage] = await Promise.all([
        loadAnnouncementsSnapshot(),
        cloudStore.kvGetJson(PUBLIC_ANNOUNCEMENTS_KEY, []),
        canManageAnnouncements(identity, session.employeeName)
      ]);
      const announcements = [...(snapshot.announcements || []), ...publicAnnouncements]
        .filter(x => x.active !== false)
        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
      return json(res, 200, { ok: true, announcements, canManage });
    }

    if (parsed.pathname === '/api/my/announcements' && req.method === 'POST') {
      if (!(await canManageAnnouncements(identity, session.employeeName))) return json(res, 403, { ok: false, error: 'Not authorized to post announcements.' });
      const body = await readJsonBody(req);
      const title = String(body.title || '').trim();
      const contentHtml = String(body.body || '').trim();
      const imageBase64 = String(body.imageBase64 || '');
      if (!title || !contentHtml) return json(res, 400, { ok: false, error: 'Title and body are required.' });
      if (imageBase64 && !/^data:image\/(jpeg|png|webp);base64,/.test(imageBase64)) return json(res, 400, { ok: false, error: 'A valid image is required.' });
      if (imageBase64.length > MAX_REWARD_IMAGE_BASE64_LENGTH) return json(res, 400, { ok: false, error: 'Photo is too large.' });
      const now = new Date().toISOString();
      const announcement = { id: `PUB-ANN-${Date.now()}`, title, body: contentHtml, imageBase64, priority: body.priority === 'URGENT' ? 'URGENT' : 'NORMAL', active: true, postedBy: session.employeeName || identity, createdAt: now, updatedAt: now };
      const list = await cloudStore.kvGetJson(PUBLIC_ANNOUNCEMENTS_KEY, []);
      list.push(announcement);
      await cloudStore.kvSetJson(PUBLIC_ANNOUNCEMENTS_KEY, list);
      return json(res, 201, { ok: true, announcement });
    }

    const publicAnnouncementMatch = parsed.pathname.match(/^\/api\/my\/announcements\/([^/]+)$/);
    if (publicAnnouncementMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
      if (!(await canManageAnnouncements(identity, session.employeeName))) return json(res, 403, { ok: false, error: 'Not authorized to manage announcements.' });
      const id = decodeURIComponent(publicAnnouncementMatch[1]);
      if (!id.startsWith('PUB-ANN-')) return json(res, 403, { ok: false, error: 'This announcement was posted from the admin dashboard and can only be managed there.' });
      const list = await cloudStore.kvGetJson(PUBLIC_ANNOUNCEMENTS_KEY, []);
      const index = list.findIndex(x => x.id === id);
      if (index < 0) return json(res, 404, { ok: false, error: 'Announcement not found.' });
      if (req.method === 'DELETE') {
        list.splice(index, 1);
        await cloudStore.kvSetJson(PUBLIC_ANNOUNCEMENTS_KEY, list);
        return json(res, 200, { ok: true, deleted: id });
      }
      const body = await readJsonBody(req);
      const current = list[index];
      const title = String(body.title ?? current.title).trim();
      const contentHtml = String(body.body ?? current.body).trim();
      const imageBase64 = body.imageBase64 === undefined ? current.imageBase64 || '' : String(body.imageBase64 || '');
      if (!title || !contentHtml) return json(res, 400, { ok: false, error: 'Title and body are required.' });
      if (imageBase64 && !/^data:image\/(jpeg|png|webp);base64,/.test(imageBase64)) return json(res, 400, { ok: false, error: 'A valid image is required.' });
      if (imageBase64.length > MAX_REWARD_IMAGE_BASE64_LENGTH) return json(res, 400, { ok: false, error: 'Photo is too large.' });
      list[index] = { ...current, title, body: contentHtml, imageBase64, priority: body.priority === 'URGENT' ? 'URGENT' : 'NORMAL', active: body.active !== undefined ? Boolean(body.active) : current.active, updatedAt: new Date().toISOString() };
      await cloudStore.kvSetJson(PUBLIC_ANNOUNCEMENTS_KEY, list);
      return json(res, 200, { ok: true, announcement: list[index] });
    }

    if (parsed.pathname === '/api/my/draft-assist' && req.method === 'POST') {
      if (!(await canManageAnnouncements(identity, session.employeeName))) return json(res, 403, { ok: false, error: 'Not authorized to use this.' });
      if (!GROQ_API_KEY) return json(res, 503, { ok: false, error: 'AI assist is not configured yet - ask an admin to set GROQ_API_KEY.' });
      const body = await readJsonBody(req);
      const text = String(body.text || '').trim();
      const instructions = String(body.instructions || '').trim();
      if (!text) return json(res, 400, { ok: false, error: 'Type or paste some text first.' });
      // Wrap the content in explicit tags rather than just appending it after the instructions -
      // small fast models (Groq's llama-3.1-8b-instant) can otherwise get confused about where
      // the instructions end and the actual content begins, especially on short input, and
      // respond by asking for "the text" instead of just rephrasing what's already there.
      const instruction = instructions
        ? `Rephrase the text below according to these instructions: "${instructions}".`
        : `Rephrase the text below to fix grammar, spelling, and clarity, and improve the wording where it's awkward. Preserve its meaning, tone, and approximate length - this is not a rewrite.`;
      const prompt = `${instruction} The text to rephrase is everything between the <text> tags, even if it looks short, incomplete, or like a placeholder - always rephrase exactly what's there. Return ONLY the rephrased text with no <text> tags, no preamble, no markdown formatting, and no quotation marks around it.\n\n<text>\n${text}\n</text>`;
      try {
        const suggestion = await callGroq(prompt);
        return json(res, 200, { ok: true, suggestion });
      } catch (error) {
        return json(res, 502, { ok: false, error: `AI assist failed: ${error.message}` });
      }
    }

    if (parsed.pathname === '/api/my/generate-quiz' && req.method === 'POST') {
      if (!(await hasDirectReports(identity, session.employeeName))) return json(res, 403, { ok: false, error: 'Only a team lead can generate a quiz.' });
      if (!GROQ_API_KEY) return json(res, 503, { ok: false, error: 'AI assist is not configured yet - ask an admin to set GROQ_API_KEY.' });
      const body = await readJsonBody(req);
      const text = String(body.text || '').trim();
      if (!text) return json(res, 400, { ok: false, error: 'Add some content before generating a quiz.' });
      const prompt = `Generate exactly 3 multiple-choice quiz questions that test whether someone actually understood the policy/SOP text below - not trivia, comprehension. Each question needs exactly 4 answer options with exactly one correct. Base every question strictly on what the text says - never invent details it doesn't contain. Respond with ONLY this exact JSON shape, no markdown, no preamble: {"questions":[{"text":"...","options":[{"text":"...","correct":true},{"text":"...","correct":false},{"text":"...","correct":false},{"text":"...","correct":false}]}]}\n\n<text>\n${text}\n</text>`;
      try {
        const raw = await callGroq(prompt, { maxTokens: 1500, json: true });
        let parsedJson;
        try { parsedJson = JSON.parse(raw); } catch { return json(res, 502, { ok: false, error: 'AI returned an unreadable quiz - try again.' }); }
        const questions = sanitizeQuizQuestions(parsedJson.questions);
        if (!questions.length) return json(res, 502, { ok: false, error: 'AI did not return any usable questions - try again or add questions manually.' });
        return json(res, 200, { ok: true, questions });
      } catch (error) {
        return json(res, 502, { ok: false, error: `Quiz generation failed: ${error.message}` });
      }
    }

    if (parsed.pathname === '/api/my/mbr-review-insight' && req.method === 'POST') {
      if (!(await hasDirectReports(identity, session.employeeName))) return json(res, 403, { ok: false, error: 'Only a team lead can generate an MBR.' });
      const body = await readJsonBody(req);
      const draft = String(body.draft || '').trim();
      const format = body.format === 'json' ? 'json' : 'text';
      if (!draft) return json(res, 400, { ok: false, error: 'draft is required.' });
      // Second-pass fact-check, not a rewrite: Copilot (tsr-bot) already drafted this line in the
      // browser from a lean prompt; here it gets checked against the FULL underlying dataset by a
      // second model before it goes in the deck. Always resolves ok:true with the original draft
      // as a fallback - a stat line in an MBR should never fail to render just because Groq isn't
      // configured or is briefly down.
      if (!GROQ_API_KEY) return json(res, 200, { ok: true, reviewed: draft, reviewedBy: 'none' });
      const context = JSON.stringify(body.context ?? {}).slice(0, 16000);
      const instruction = format === 'json'
        ? 'You are fact-checking a drafted JSON object for a Monthly Business Review slide against the supporting data below. Verify every number, name, and claim in the draft matches the data. If something is wrong, unsupported, or omits something important the data shows, correct it. Keep the exact same JSON shape as the draft. Return ONLY the corrected JSON object, no markdown, no preamble.'
        : 'You are fact-checking a drafted sentence (max 2 sentences) for a Monthly Business Review slide against the supporting data below. Verify every number and name in the draft matches the data exactly. If it is fully accurate, return it as-is, optionally tightened for clarity. If anything is wrong or unsupported, rewrite it using ONLY the given data. Return ONLY the corrected sentence, no markdown, no preamble, no quotes.';
      const prompt = `${instruction}\n\nSUPPORTING DATA:\n${context}\n\nDRAFT:\n${draft}`;
      try {
        const reviewed = await callGroq(prompt, { maxTokens: format === 'json' ? 700 : 200, json: format === 'json' });
        return json(res, 200, { ok: true, reviewed, reviewedBy: 'groq' });
      } catch (error) {
        return json(res, 200, { ok: true, reviewed: draft, reviewedBy: 'none', error: error.message });
      }
    }

    if (parsed.pathname === '/api/my/kpi' && req.method === 'GET') {
      const [kpiResults, roster] = await Promise.all([loadKpiResultsSnapshot(), loadRosterSnapshot()]);
      const periods = kpiResults.periods || {};
      const signedInEmployee = (roster.records || []).find(x => ptoLogic.cleanEmail(x.employeeEmail) === identity) || null;
      const dsatDisputes = await cloudStore.kvGetJson(DISPUTES_KEY, []);
      const currentPeriodSet = new Set(currentPeriodKeys(Object.keys(periods)));
      const results = Object.entries(periods)
        .filter(([period]) => currentPeriodSet.has(period))
        .flatMap(([period, rows]) => (rows || []).filter(x => ptoLogic.cleanEmail(x.employeeEmail) === identity).map(x => ({ period, ...x })))
        .sort((a, b) => b.period.localeCompare(a.period))
        // Merged in fresh on every read, not trusted from any stored field on the row itself -
        // see buildDsatKpiAdjustment for why this can't be a value written at decide-time.
        .map(row => ({ ...row, disputeAdjustment: buildDsatKpiAdjustment(row, dsatDisputes.filter(d => d.status === 'APPROVED' && ptoLogic.cleanEmail(d.employeeEmail) === identity && d.period === row.period).length) }));
      const leaderName=String(signedInEmployee?.employeeName||session.employeeName||'').trim();
      const assignedMembers=scopedTeamMembers(roster,identity,session,session.employeeName);
      const memberEmails=new Set(assignedMembers.map(x=>ptoLogic.cleanEmail(x.employeeEmail)));
      const availablePeriods=[...currentPeriodSet].sort((a,b)=>b.localeCompare(a));
      const requestedPeriod=String(parsed.searchParams.get('period')||'');
      const latestTeamPeriod=(requestedPeriod&&periods[requestedPeriod]?requestedPeriod:availablePeriods.find(period=>(periods[period]||[]).some(x=>memberEmails.has(ptoLogic.cleanEmail(x.employeeEmail)))))||'';
      const periodResultsByEmail=new Map((latestTeamPeriod?(periods[latestTeamPeriod]||[]):[]).map(x=>[ptoLogic.cleanEmail(x.employeeEmail),x]));
      const teamResults=assignedMembers.map(member=>{
        const saved=periodResultsByEmail.get(ptoLogic.cleanEmail(member.employeeEmail));
        return saved
          ? {period:latestTeamPeriod,...saved}
          : {
              period:latestTeamPeriod,
              employeeEmail:ptoLogic.cleanEmail(member.employeeEmail),
              employeeName:member.employeeName||member.employeeEmail,
              teamLeadName:member.teamLeadName||leaderName,
              kpiType:member.kpiType||'',
              primaryChannel:member.primaryChannel||'',
              eligibleWorkdays:null,
              baseKpi:null,
              finalKpi:null,
              performanceStatus:'Not Rated',
              dataStatus:'No KPI result'
            };
      });
      const validTeamResults=teamResults.filter(x=>x.finalKpi!=null&&Number.isFinite(+x.finalKpi));
      let teamAverage=validTeamResults.length?validTeamResults.reduce((sum,x)=>sum+Number(x.finalKpi),0)/validTeamResults.length:null;
      let teamLeadName=assignedMembers.length?leaderName:(results[0]?.teamLeadName||''),teamSize=teamResults.length;
      if(!assignedMembers.length&&results.length){
        const latestPeriod=results[0].period,periodRows=periods[latestPeriod]||[],teammates=teamLeadName?periodRows.filter(x=>x.teamLeadName===teamLeadName&&x.finalKpi!=null&&Number.isFinite(+x.finalKpi)):[];
        teamSize=teammates.length;
        if(teamSize)teamAverage=teammates.reduce((sum,x)=>sum+Number(x.finalKpi),0)/teamSize;
      }
      return json(res,200,{ok:true,results,isTeamLeader:assignedMembers.length>0,teamResults,teamPeriod:latestTeamPeriod,teamAverage,teamLeadName,teamSize,assignedMemberCount:assignedMembers.length,availablePeriods});
    }

    // Senior TSR EOD Jira activity: read-only visibility into AM tickets touched, commented on,
    // or handed off from PH JIRA Support to CRM/Website Request Team, day-by-day for the current
    // month. Informational only - never feeds KPI scoring. zendesk-proxy.js computes this (it's
    // the only server with Jira credentials) and syncs it here like every other cached snapshot.
    if (parsed.pathname === '/api/my/senior-jira-activity' && req.method === 'GET') {
      const roster = await loadRosterSnapshot();
      const me = (roster.records || []).find(x => ptoLogic.cleanEmail(x.employeeEmail) === identity) || null;
      const previewingSeniorTsr = effectiveViewAsRole(identity, session) === 'SENIOR TSR';
      if ((!me || me.kpiType !== 'Senior TSR') && !previewingSeniorTsr) return json(res, 403, { ok: false, error: 'This view is only available to Senior TSRs.' });
      const snapshot = await loadSeniorJiraActivitySnapshot();
      const periods = snapshot.periods || {};
      const availableMonths = Object.keys(periods).sort((a, b) => b.localeCompare(a));
      const requestedMonth = String(parsed.searchParams.get('month') || '');
      const month = (requestedMonth && periods[requestedMonth]) ? requestedMonth : (availableMonths[0] || '');
      const period = periods[month] || { sourceAvailable: false, byEmail: {} };
      const days = period.byEmail?.[identity] || {};
      const dayKeys = Object.keys(days).sort((a, b) => b.localeCompare(a));
      const totals = { touched: 0, commented: 0, reassignedPhToCrm: 0 };
      for (const day of dayKeys) { totals.touched += days[day].touched.length; totals.commented += days[day].commented.length; totals.reassignedPhToCrm += days[day].reassignedPhToCrm.length; }
      return json(res, 200, {
        ok: true,
        month,
        availableMonths,
        generatedAt: period.generatedAt || '',
        sourceAvailable: Boolean(period.sourceAvailable),
        sourceError: period.sourceError || '',
        totals,
        days: dayKeys.map(day => ({ day, ...days[day] }))
      });
    }

    // Company-wide "who's currently in training" - visible to any signed-in user, not just the
    // Training Manager, since a team lead elsewhere or an admin previewing shouldn't need
    // Training Manager access (or the local admin dashboard's roster filter) just to see who's
    // still onboarding. No role gate at all, matching Site KPI's own broad visibility.
    if (parsed.pathname === '/api/site-trainees' && req.method === 'GET') {
      const roster = await loadRosterSnapshot();
      const trainees = (roster.records || []).filter(x => x.active !== false && x.kpiType === 'Trainee')
        .map(x => ({ employeeName: x.employeeName, employeeEmail: ptoLogic.cleanEmail(x.employeeEmail), teamLeadName: x.teamLeadName, primaryChannel: x.primaryChannel, effectiveDate: x.effectiveDate || x.hireDate || '' }))
        .sort((a, b) => (a.effectiveDate || '').localeCompare(b.effectiveDate || ''));
      return json(res, 200, { ok: true, trainees });
    }

    if (parsed.pathname === '/api/my/site-metrics' && req.method === 'GET') {
      const siteMetricsData = await loadSiteMetricsSnapshot();
      const periods = siteMetricsData.periods || {};
      const availablePeriods = currentPeriodKeys(Object.keys(periods)).sort((a, b) => b.localeCompare(a));
      const requestedPeriod = String(parsed.searchParams.get('period') || '');
      const period = (requestedPeriod && periods[requestedPeriod]) ? requestedPeriod : (availablePeriods[0] || '');
      // Daily EOD history for the trend table - each stored period is a cumulative
      // month-to-date-through-that-day snapshot (that's what the cards above use), but "EOD"
      // means that single day's own activity, not blended with the rest of the month. Derive
      // it by subtracting the previous same-month day's cumulative counts, so day 1 of a month
      // (nothing earlier to subtract) and every day after it show that day alone.
      const sortedByDate = availablePeriods
        .map(key => ({ period: key, month: key.split('|')[0] || '', endDate: key.split('|')[1] || key, ...periods[key] }))
        .sort((a, b) => a.endDate.localeCompare(b.endDate));
      const history = sortedByDate.map((row, i) => {
        const prev = sortedByDate[i - 1];
        const sameMonthPrev = prev && prev.month === row.month ? prev : null;
        // No same-month day before this one: if it's the 1st, that cumulative IS the day's own
        // total already. Otherwise (e.g. the only entry captured for an older month, before
        // daily capture existed) there's no way to isolate that single day - it's really the
        // whole month's total, and isDailyIsolated:false says so for the UI to label honestly.
        if (!sameMonthPrev) return { ...row, isDailyIsolated: row.endDate.endsWith('-01') };
        const cc = row.callCompletion || {}, pcc = sameMonthPrev.callCompletion || {};
        const lcr = row.longCallRate || {}, plcr = sameMonthPrev.longCallRate || {};
        const cs = row.csat || {}, pcs = sameMonthPrev.csat || {};
        const totalInbound = (cc.totalInbound || 0) - (pcc.totalInbound || 0);
        const completedInbound = (cc.completedInbound || 0) - (pcc.completedInbound || 0);
        const accepted = (lcr.accepted || 0) - (plcr.accepted || 0);
        const longCalls = (lcr.longCalls || 0) - (plcr.longCalls || 0);
        const good = (cs.good || 0) - (pcs.good || 0);
        const bad = (cs.bad || 0) - (pcs.bad || 0);
        // A cumulative month-to-date total can only hold steady or grow as the month goes on -
        // a negative delta here means the stored MTD snapshot for this day (or the one before
        // it) is inconsistent with the other, e.g. a refresh ran before the labeled day had
        // fully elapsed, or Zendesk's own data changed between the two snapshots being
        // captured. Subtracting two negatives previously produced a false "100%" on
        // 2026-08-08 (1220 total that day vs. 1244 the day before) - fall back to the day's
        // own raw cumulative rather than trust arithmetic on numbers that can't both be right.
        // Every component needs its own check, not just the three used above: checking only
        // totalInbound/accepted/(good+bad) still lets e.g. completedInbound or bad go negative
        // on its own (good absorbing the swing) and produce a >100% or negative rate undetected.
        if (totalInbound < 0 || completedInbound < 0 || accepted < 0 || longCalls < 0 || good < 0 || bad < 0) return { ...row, isDailyIsolated: false };
        return {
          period: row.period, endDate: row.endDate, lastUpdated: row.lastUpdated, isDailyIsolated: true,
          callCompletion: { totalInbound, completedInbound, rate: totalInbound ? completedInbound / totalInbound * 100 : null },
          longCallRate: { accepted, longCalls, rate: accepted ? longCalls / accepted * 100 : null },
          csat: { good, bad, rate: (good + bad) ? good / (good + bad) * 100 : null }
        };
      });
      // Onsite/WFH/Present headcount per day, so a dip or improvement in the metrics above can
      // be checked against the day's work-setup mix. Attendance is entered per-date regardless
      // of which "month|endDate" period it was saved under, so flatten every period's per-email
      // per-date codes into a single date->email->code map (later-saved periods win on
      // conflict) rather than requiring an exact period-key match with the site-metrics rows.
      // A LATE entry is stored as an object ({status:'LATE', minutesLate, location}), every
      // other code as a plain string - unwrap to {code, location} uniformly so the tally below
      // never compares a string to an object (which silently drops the entry, matching neither
      // branch).
      const attendanceData = await loadAttendanceSnapshot();
      const attendanceByDate = new Map();
      for (const key of Object.keys(attendanceData.periods || {}).sort()) {
        const byEmail = attendanceData.periods[key] || {};
        for (const email of Object.keys(byEmail)) {
          for (const [date, raw] of Object.entries(byEmail[email] || {})) {
            const code = raw && typeof raw === 'object' ? raw.status : raw;
            const location = raw && typeof raw === 'object' ? raw.location : null;
            if (!attendanceByDate.has(date)) attendanceByDate.set(date, new Map());
            attendanceByDate.get(date).set(email, { code, location });
          }
        }
      }
      const historyWithAttendance = history.map(row => {
        const codesForDay = attendanceByDate.get(row.endDate);
        let onsite = 0, wfh = 0, late = 0, plannedOut = 0, unplannedOut = 0;
        // A late entry now records where that employee actually worked, so it counts toward
        // Onsite/WFH like any other present day - Late is a separate tardiness indicator on
        // top of that, not a third location bucket. Older entries saved before this field
        // existed (and any future one somehow missing it) have no location on file; default
        // those to Onsite for now rather than dropping them from the headcount entirely.
        if (codesForDay) for (const { code, location } of codesForDay.values()) {
          if (code === 'ONSITE') onsite++;
          else if (code === 'WFH') wfh++;
          else if (code === 'LATE') {
            late++;
            if (location === 'WFH') wfh++;
            else onsite++;
          }
          else if (PLANNED_OUT_CODES.has(code)) plannedOut++;
          else if (UNPLANNED_OUT_CODES.has(code)) unplannedOut++;
        }
        return { ...row, attendance: { onsite, wfh, present: onsite + wfh, late, plannedOut, unplannedOut } };
      });
      return json(res, 200, { ok: true, period, siteMetrics: period ? periods[period] : null, availablePeriods, history: historyWithAttendance });
    }

    if (parsed.pathname === '/api/my/notifications' && req.method === 'GET') {
      const roster = await loadRosterSnapshot();
      const signedInEmployee = (roster.records || []).find(x => ptoLogic.cleanEmail(x.employeeEmail) === identity) || null;
      const leaderName = String(signedInEmployee?.employeeName || session.employeeName || '').trim();
      const leaderEmail = ptoLogic.cleanEmail(signedInEmployee?.employeeEmail || identity);
      const assignedMembers = (roster.records || []).filter(x => x.active !== false && ptoLogic.cleanEmail(x.employeeEmail) !== identity && (ptoLogic.cleanEmail(x.teamLeadEmail) === leaderEmail || String(x.teamLeadName || '').trim() === leaderName));
      const todayParts = easternDateParts(new Date());
      const today = `${todayParts.year}-${todayParts.month}-${todayParts.day}`;
      const birthdays = assignedMembers
        .map(m => { const info = nextBirthdayInfo(m.birthday, today); return info ? { employeeEmail: ptoLogic.cleanEmail(m.employeeEmail), employeeName: m.employeeName, ...info } : null; })
        .filter(Boolean).filter(x => x.daysUntil <= 30)
        .sort((a, b) => a.daysUntil - b.daysUntil);
      const probationInfo = assignedMembers
        .map(m => { const info = probationEvalInfo(m.hireDate, today); return info ? { employeeEmail: ptoLogic.cleanEmail(m.employeeEmail), employeeName: m.employeeName, hireDate: m.hireDate, ...info } : null; })
        .filter(Boolean);
      const evaluations = probationInfo.filter(x => x.evalMonth < 5).sort((a, b) => a.daysUntilDue - b.daysUntilDue);
      // Month 5 is the regularization decision itself, not just another monthly check-in -
      // called out as its own, more prominent list rather than buried in "evaluations".
      const regularizations = probationInfo.filter(x => x.evalMonth === 5).sort((a, b) => a.daysUntilDue - b.daysUntilDue);
      const anniversaries = assignedMembers
        .map(m => { const info = nextAnniversaryInfo(m.hireDate, today); return info ? { employeeEmail: ptoLogic.cleanEmail(m.employeeEmail), employeeName: m.employeeName, ...info } : null; })
        .filter(Boolean).filter(x => x.daysUntil <= 30)
        .sort((a, b) => a.daysUntil - b.daysUntil);

      const [schedules, attendance, kpiResults, pto, ptoAccess] = await Promise.all([
        loadScheduleSnapshot(), loadAttendanceSnapshot(), loadKpiResultsSnapshot(), loadPto(), ptoReviewAccess(identity, session.employeeName)
      ]);

      // KPI performance: flag anyone currently Watch/Intervention, or whose tier dropped
      // from their prior rated period - lets a lead step in before it hits a formal review.
      const periodsSorted = Object.keys(kpiResults.periods || {}).sort((a, b) => b.localeCompare(a));
      const kpiAlerts = assignedMembers.map(m => {
        const email = ptoLogic.cleanEmail(m.employeeEmail);
        const rated = periodsSorted.map(p => (kpiResults.periods[p] || []).find(r => ptoLogic.cleanEmail(r.employeeEmail) === email && r.finalKpi != null)).filter(Boolean);
        if (!rated.length) return null;
        const [latest, previous] = rated;
        const latestTier = PERFORMANCE_TIER[latest.performanceStatus] ?? null;
        const previousTier = previous ? (PERFORMANCE_TIER[previous.performanceStatus] ?? null) : null;
        const isLow = latestTier != null && latestTier <= PERFORMANCE_TIER.Watch;
        const dropped = latestTier != null && previousTier != null && latestTier < previousTier;
        if (!isLow && !dropped) return null;
        return { employeeEmail: email, employeeName: m.employeeName, period: latest.period, finalKpi: latest.finalKpi, performanceStatus: latest.performanceStatus, previousPerformanceStatus: previous?.performanceStatus || null, dropped };
      }).filter(Boolean);

      // Attendance red flags: this month only, computed directly from raw entries (same
      // source MTD_Attendance_Eligible_Workdays.html's own late/missing counts use) rather
      // than attendanceSummaries.json, since that stored summary doesn't carry a lateDays
      // count today.
      const monthStart = `${today.slice(0, 7)}-01`;
      const priorDates = ptoLogic.dateRange(monthStart, today).filter(d => d < today);
      const attendanceFlags = assignedMembers.map(m => {
        const email = ptoLogic.cleanEmail(m.employeeEmail);
        let lateCount = 0, missingCount = 0;
        for (const date of ptoLogic.dateRange(monthStart, today)) {
          const code = ptoLogic.attendanceCodeOnDate(attendance, email, date);
          if (code === 'LATE') lateCount++;
        }
        for (const date of priorDates) {
          const resolved = ptoLogic.scheduleForDate(schedules, email, date);
          const eligible = !resolved.missingSchedule && Boolean(resolved.template) && !resolved.template.off;
          if (!eligible) continue;
          if (!ptoLogic.attendanceCodeOnDate(attendance, email, date)) missingCount++;
        }
        if (lateCount < 3 && missingCount < 1) return null;
        return { employeeEmail: email, employeeName: m.employeeName, lateCount, missingCount };
      }).filter(Boolean);

      const pendingApprovalRequests = (pto.requests || []).filter(request => request.status !== 'DRAFT' && canReviewPtoRequest(ptoAccess, request) && ['SUBMITTED', 'PENDING'].includes(request.status));
      const pendingApprovals = pendingApprovalRequests.length;
      const pendingApprovalIds = pendingApprovalRequests.map(r => r.requestId);

      // Coaching follow-ups due: reminds BOTH sides of a coaching session - the employee
      // (their own upcoming/overdue follow-up) and the team lead who created it - so
      // neither has to remember to check back on their own. "Due" = within 7 days,
      // including overdue (negative daysUntil), on any session that's actually been sent.
      const coaching = await loadCoaching();
      const daysUntil = (dateStr) => {
        const [y1, m1, d1] = dateStr.split('-').map(Number);
        const [y2, m2, d2] = today.split('-').map(Number);
        return Math.round((Date.UTC(y1, m1 - 1, d1) - Date.UTC(y2, m2 - 1, d2)) / 86400000);
      };
      const dueCoachingFollowUps = (coaching.records || [])
        .filter(r => r.targetFollowUpDate && ['SENT', 'ACKNOWLEDGED'].includes(r.status))
        .map(r => ({ ...r, daysUntil: daysUntil(r.targetFollowUpDate) }))
        .filter(r => r.daysUntil <= 7);
      const myCoachingFollowUps = dueCoachingFollowUps
        .filter(r => ptoLogic.cleanEmail(r.employeeEmail) === identity)
        .map(r => ({ coachingId: r.coachingId, teamLeadName: r.teamLeadName, category: r.category, followUpDate: r.targetFollowUpDate, daysUntil: r.daysUntil }))
        .sort((a, b) => a.daysUntil - b.daysUntil);
      const teamCoachingFollowUps = dueCoachingFollowUps
        .filter(r => ptoLogic.cleanEmail(r.teamLeadEmail) === identity)
        .map(r => ({ coachingId: r.coachingId, employeeName: r.employeeName, category: r.category, followUpDate: r.targetFollowUpDate, daysUntil: r.daysUntil }))
        .sort((a, b) => a.daysUntil - b.daysUntil);

      // Disciplinary: reminds whoever holds the next action on a case so nothing sits
      // waiting unnoticed - the employee whose case was just decided (needs to sign), the
      // Senior Operations Manager (cases awaiting pre-review), and HR (cases awaiting the
      // final decision).
      const disciplinaryData = await loadDisciplinary();
      const disciplinaryAccess = await disciplinaryReviewAccess(identity, session.employeeName);
      const myDisciplinaryPending = (disciplinaryData.records || [])
        .filter(r => r.status === 'DECIDED' && ptoLogic.cleanEmail(r.employeeEmail) === identity)
        .map(r => ({ violationId: r.violationId, category: r.category, finalTier: r.finalTier, finalSanction: r.finalSanction, sanctionDate: r.sanctionDate }))
        .sort((a, b) => String(a.sanctionDate || '').localeCompare(String(b.sanctionDate || '')));
      const disciplinaryPreReviewPending = disciplinaryAccess.canPreDecide
        ? (disciplinaryData.records || []).filter(r => r.status === 'FILED')
          .map(r => ({ violationId: r.violationId, employeeName: r.employeeName, category: r.category, tier: r.tier, infractionDate: r.infractionDate }))
          .sort((a, b) => a.infractionDate.localeCompare(b.infractionDate))
        : [];
      const disciplinaryDecisionPending = disciplinaryAccess.canDecide
        ? (disciplinaryData.records || []).filter(r => r.status === 'PRE_DECIDED')
          .map(r => ({ violationId: r.violationId, employeeName: r.employeeName, category: r.category, preTier: r.preTier, infractionDate: r.infractionDate }))
          .sort((a, b) => a.infractionDate.localeCompare(b.infractionDate))
        : [];

      return json(res, 200, { ok: true, isTeamLeader: assignedMembers.length > 0, asOfDate: today, birthdays, evaluations, regularizations, anniversaries, kpiAlerts, attendanceFlags, pendingApprovals, pendingApprovalIds, myCoachingFollowUps, teamCoachingFollowUps, myDisciplinaryPending, disciplinaryPreReviewPending, disciplinaryDecisionPending });
    }

    if (parsed.pathname === '/api/my/schedule' && req.method === 'GET') {
      const schedules = await loadScheduleSnapshot();
      const roster = await loadRosterSnapshot();
      const employee = (roster.records || []).find(x => ptoLogic.cleanEmail(x.employeeEmail) === identity) || null;
      const today = new Date();
      const startDate = parsed.searchParams.get('startDate') || new Date(today.getTime() - 3 * 86400000).toISOString().slice(0, 10);
      const endDate = parsed.searchParams.get('endDate') || new Date(today.getTime() + 10 * 86400000).toISOString().slice(0, 10);
      if (!ptoLogic.validDate(startDate) || !ptoLogic.validDate(endDate) || startDate > endDate) {
        return json(res, 400, { ok: false, error: 'A valid startDate/endDate range is required.' });
      }
      const days = ptoLogic.dateRange(startDate, endDate).map(date => {
        const resolved = ptoLogic.scheduleForDate(schedules, identity, date);
        const t = resolved.template;
        return {
          date,
          weekday: resolved.weekday,
          missingSchedule: resolved.missingSchedule,
          off: t ? Boolean(t.off) : null,
          shiftStartEastern: t?.off ? null : (t?.shiftStartEastern || null),
          shiftEndEastern: t?.off ? null : (t?.shiftEndEastern || null),
          overnight: Boolean(t?.overnight),
          assignments: t && !t.off ? (t.assignments || {}) : {},
          exactActivities: t?.off ? [] : (resolved.override ? (resolved.override.exactActivities || []) : (resolved.record?.exactActivities?.[resolved.weekday] || [])),
          // KPI type/channel decides the default queue activity, not whatever the schedule record
          // happens to have stored - schedules are often created from a template and never get
          // their defaultAssignment corrected for Non-Voice/Senior reps, which otherwise silently
          // shows everyone as "Call".
          defaultActivityId: serverDefaultAssignmentFor(employee) || t?.defaultAssignment || resolved.record?.defaultAssignment || 'CALL'
        };
      });
      return json(res, 200, { ok: true, days });
    }

    if (parsed.pathname === '/api/my/status' && req.method === 'GET') {
      const data = await loadRepStatus();
      const entry = data.statuses?.[identity] || null;
      return json(res, 200, { ok: true, activityId: entry?.activityId || '', updatedAt: entry?.updatedAt || '', clockedInAt: entry?.clockedInAt || null, clockedIn: repStatusClockedInToday(entry) });
    }

    if (parsed.pathname === '/api/my/status/clock-in' && req.method === 'POST') {
      const data = await loadRepStatus();
      data.statuses = data.statuses || {};
      const now = new Date().toISOString();
      data.statuses[identity] = { clockedInAt: now, activityId: '', updatedAt: now };
      await saveRepStatus(data);
      return json(res, 200, { ok: true, clockedInAt: now, activityId: '', updatedAt: now });
    }

    if (parsed.pathname === '/api/my/status/clock-out' && req.method === 'POST') {
      const data = await loadRepStatus();
      data.statuses = data.statuses || {};
      const now = new Date().toISOString();
      data.statuses[identity] = { clockedInAt: null, activityId: '', updatedAt: now };
      await saveRepStatus(data);
      return json(res, 200, { ok: true, clockedInAt: null, activityId: '', updatedAt: now });
    }

    if (parsed.pathname === '/api/my/status' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const activityId = String(body.activityId || '').trim().toUpperCase();
      if (!VALID_STATUS_ACTIVITY_IDS.has(activityId)) return json(res, 400, { ok: false, error: 'Unrecognized status.' });
      const data = await loadRepStatus();
      data.statuses = data.statuses || {};
      const current = data.statuses[identity] || null;
      if (!repStatusClockedInToday(current)) return json(res, 400, { ok: false, error: 'Time in before setting a status.' });
      const now = new Date().toISOString();
      data.statuses[identity] = { ...current, activityId, updatedAt: now };
      await saveRepStatus(data);
      return json(res, 200, { ok: true, activityId, updatedAt: now, clockedInAt: current.clockedInAt });
    }

    if (parsed.pathname === '/api/my/attendance' && req.method === 'GET') {
      const attendance = await loadAttendanceSnapshot();
      const month = parsed.searchParams.get('month') || new Date().toISOString().slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(month)) return json(res, 400, { ok: false, error: 'A valid month (YYYY-MM) is required.' });
      const today = new Date().toISOString().slice(0, 10);
      const requestedEnd = parsed.searchParams.get('endDate') || '';
      const monthEnd = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).toISOString().slice(0, 10);
      const endDate = requestedEnd || (month === today.slice(0, 7) ? today : monthEnd);
      const days = ptoLogic.dateRange(`${month}-01`, endDate).map(date => ({
        date,
        code: ptoLogic.attendanceCodeOnDate(attendance, identity, date) || null
      }));
      return json(res, 200, { ok: true, days });
    }

    if (parsed.pathname === '/api/my/team-attendance' && req.method === 'GET') {
      const month = parsed.searchParams.get('month') || '', endDate = parsed.searchParams.get('endDate') || '';
      if (!/^\d{4}-\d{2}$/.test(month) || !ptoLogic.validDate(endDate) || !endDate.startsWith(month)) return json(res, 400, { ok: false, error: 'A valid month (YYYY-MM) and endDate within that month are required.' });
      const roster = await loadRosterSnapshot();
      const assignedMembers = scopedTeamMembers(roster, identity, session, session.employeeName);
      if (!assignedMembers.length) return json(res, 200, { ok: true, isTeamLeader: false, month, endDate, dates: [], members: [] });
      const [schedules, attendance] = await Promise.all([loadScheduleSnapshot(), loadAttendanceSnapshot()]);
      const dates = ptoLogic.dateRange(`${month}-01`, endDate);
      const members = assignedMembers.map(emp => {
        const email = ptoLogic.cleanEmail(emp.employeeEmail);
        const days = dates.map(date => {
          const resolved = ptoLogic.scheduleForDate(schedules, email, date);
          const eligible = !resolved.missingSchedule && Boolean(resolved.template) && !resolved.template.off;
          const auto = attendance.autoEntries?.[email]?.[date] || null;
          const code = ptoLogic.attendanceCodeOnDate(attendance, email, date) || '';
          const minutesLate = ptoLogic.attendanceMinutesLateOnDate(attendance, email, date);
          const reason = ptoLogic.attendanceReasonOnDate(attendance, email, date);
          const location = ptoLogic.attendanceLocationOnDate(attendance, email, date);
          return { date, eligible, locked: Boolean(auto), code, minutesLate, reason, location, displayLabel: auto?.displayLabel || '' };
        });
        return { employeeEmail: email, employeeName: emp.employeeName, days };
      });
      return json(res, 200, { ok: true, isTeamLeader: true, month, endDate, dates, members });
    }

    if (parsed.pathname === '/api/my/team-attendance' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const month = String(body.month || ''), endDate = String(body.endDate || '');
      if (!/^\d{4}-\d{2}$/.test(month) || !ptoLogic.validDate(endDate) || !endDate.startsWith(month)) return json(res, 400, { ok: false, error: 'A valid month (YYYY-MM) and endDate within that month are required.' });
      if (!body.entries || typeof body.entries !== 'object') return json(res, 400, { ok: false, error: 'Attendance entries are required.' });
      const roster = await loadRosterSnapshot();
      const memberEmails = new Set(scopedTeamMembers(roster, identity, session, session.employeeName, false).map(x => ptoLogic.cleanEmail(x.employeeEmail)));
      if (!memberEmails.size) return json(res, 403, { ok: false, error: 'You do not have any direct reports.' });
      const [schedules, attendance] = await Promise.all([loadScheduleSnapshot(), loadAttendanceSnapshot()]);
      const accepted = {}, skipped = [];
      for (const [rawEmail, byDate] of Object.entries(body.entries)) {
        const email = ptoLogic.cleanEmail(rawEmail);
        if (!memberEmails.has(email)) { skipped.push({ employeeEmail: email, reason: 'Not your direct report.' }); continue; }
        for (const [date, rawValue] of Object.entries(byDate || {})) {
          const isObj = rawValue && typeof rawValue === 'object';
          const code = String((isObj ? rawValue.code : rawValue) || '').trim().toUpperCase();
          if (!ptoLogic.validDate(date) || !date.startsWith(month)) { skipped.push({ employeeEmail: email, date, reason: 'Date outside the selected month.' }); continue; }
          if (code && !ATTENDANCE_CODES.includes(code)) { skipped.push({ employeeEmail: email, date, reason: 'Invalid attendance code.' }); continue; }
          if (attendance.autoEntries?.[email]?.[date]) { skipped.push({ employeeEmail: email, date, reason: 'Protected by an approved PTO request.' }); continue; }
          const resolved = ptoLogic.scheduleForDate(schedules, email, date);
          if (resolved.missingSchedule || !resolved.template || resolved.template.off) { skipped.push({ employeeEmail: email, date, reason: 'Not a scheduled workday.' }); continue; }
          const minutesLate = isObj && code === 'LATE' && Number.isFinite(Number(rawValue.minutesLate)) && Number(rawValue.minutesLate) > 0 ? Math.round(Number(rawValue.minutesLate)) : null;
          const reason = isObj && typeof rawValue.reason === 'string' ? rawValue.reason.trim().slice(0, 300) : '';
          const rawLocation = isObj && typeof rawValue.location === 'string' ? rawValue.location.trim().toUpperCase() : '';
          const location = code === 'LATE' && ['ONSITE', 'WFH'].includes(rawLocation) ? rawLocation : '';
          accepted[email] ??= {};
          const extra = {};
          if (minutesLate != null) extra.minutesLate = minutesLate;
          if (reason) extra.reason = reason;
          if (location) extra.location = location;
          accepted[email][date] = Object.keys(extra).length ? { status: code, ...extra } : code;
        }
      }
      if (Object.keys(accepted).length) {
        const pending = await cloudStore.kvGetJson(ATTENDANCE_UPDATES_KEY, []);
        pending.push({ month, endDate, entries: accepted, updatedBy: identity, updatedAt: new Date().toISOString() });
        await cloudStore.kvSetJson(ATTENDANCE_UPDATES_KEY, pending);
        // Optimistic local reflection so the team lead sees their own change immediately on
        // the next GET, without waiting for zendesk-proxy's next sync tick to merge it into
        // the canonical local attendance.json.
        const key = `${month}|${endDate}`;
        attendance.periods ??= {};
        attendance.periods[key] ??= {};
        for (const [email, byDate] of Object.entries(accepted)) attendance.periods[key][email] = { ...(attendance.periods[key][email] || {}), ...byDate };
        await cloudStore.kvSetJson('mtdkpi:snapshot:attendance', attendance);
        snapshotCache.set('mtdkpi:snapshot:attendance', { value: attendance, at: Date.now() });
      }
      return json(res, 200, { ok: true, accepted, skipped });
    }

    if (parsed.pathname === '/api/my/team-attendance/attachment' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const email = ptoLogic.cleanEmail(body.employeeEmail || '');
      const date = String(body.date || '');
      const filename = String(body.filename || '').trim();
      const contentBase64 = String(body.contentBase64 || '');
      if (!email || !ptoLogic.validDate(date)) return json(res, 400, { ok: false, error: 'A valid employee and date are required.' });
      if (!filename || !contentBase64) return json(res, 400, { ok: false, error: 'A file is required.' });
      if (contentBase64.length > MAX_ATTACHMENT_BASE64_LENGTH) return json(res, 400, { ok: false, error: 'File is too large. Please attach a file under 3MB.' });
      const roster = await loadRosterSnapshot();
      const signedInEmployee = (roster.records || []).find(x => ptoLogic.cleanEmail(x.employeeEmail) === identity) || null;
      const leaderName = String(signedInEmployee?.employeeName || session.employeeName || '').trim();
      const memberEmails = new Set(scopedTeamMembers(roster, identity, session, session.employeeName).map(x => ptoLogic.cleanEmail(x.employeeEmail)));
      if (!memberEmails.has(email)) return json(res, 403, { ok: false, error: 'Not your direct report.' });
      const attendance = await loadAttendanceSnapshot();
      const code = ptoLogic.attendanceCodeOnDate(attendance, email, date) || '';
      if (!ATTACHMENT_LEAVE_CODES.includes(code)) return json(res, 400, { ok: false, error: 'Attachments can only be added to a day currently marked Sick Leave or Emergency Leave.' });
      const queue = await cloudStore.kvGetJson(ATTENDANCE_ATTACHMENTS_KEY, []);
      queue.push({ employeeEmail: email, date, code, filename, contentBase64, uploadedBy: identity, uploadedAt: new Date().toISOString() });
      await cloudStore.kvSetJson(ATTENDANCE_ATTACHMENTS_KEY, queue);
      return json(res, 200, { ok: true, code });
    }

    if (parsed.pathname === '/api/my/team-coaching' && req.method === 'GET') {
      const roster = await loadRosterSnapshot();
      const assignedMembers = scopedTeamMembers(roster, identity, session, session.employeeName);
      const memberEmails = new Set(assignedMembers.map(x => ptoLogic.cleanEmail(x.employeeEmail)));
      const data = await loadCoaching();
      // The QA reviewer also sees whatever coaching logs she's personally initiated on behalf
      // of a team lead, even for an employee who isn't one of her own direct reports.
      const records = (data.records || []).filter(x => memberEmails.has(ptoLogic.cleanEmail(x.employeeEmail)) || (portalRoleFor(identity) === 'BQA' && x.createdBy === identity)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const byId = new Map((data.records || []).map(x => [x.coachingId, x]));
      // A coaching session can explicitly link to an earlier one covering the SAME underlying
      // problem (not just the same category - a team lead may file two "Performance / KPI"
      // sessions for entirely unrelated reasons, which shouldn't count as progression). Walking
      // that chain here (not storing it) means occurrence numbers always reflect the current
      // chain even if a link is ever corrected later.
      const occurrenceNumberFor = record => {
        let count = 1, current = record, guard = 0;
        while (current.linkedFromCoachingId && guard++ < 50) {
          const previous = byId.get(current.linkedFromCoachingId);
          if (!previous) break;
          count++; current = previous;
        }
        return count;
      };
      const withProgression = records.map(r => ({
        ...r,
        occurrenceNumber: occurrenceNumberFor(r),
        linkedFromSummary: r.linkedFromCoachingId && byId.has(r.linkedFromCoachingId)
          ? { coachingId: r.linkedFromCoachingId, coachingDate: byId.get(r.linkedFromCoachingId).coachingDate, category: byId.get(r.linkedFromCoachingId).category }
          : null
      }));
      return json(res, 200, { ok: true, isTeamLeader: memberEmails.size > 0, categories: COACHING_CATEGORIES, members: assignedMembers.map(x => ({ employeeEmail: ptoLogic.cleanEmail(x.employeeEmail), employeeName: x.employeeName })), records: withProgression, lastUpdated: data.lastUpdated || '' });
    }

    if (parsed.pathname === '/api/my/team-coaching' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const email = ptoLogic.cleanEmail(body.employeeEmail || '');
      const coachingDate = String(body.coachingDate || '');
      const category = String(body.category || '');
      const observation = String(body.observation || '').trim();
      if (!email || !ptoLogic.validDate(coachingDate)) return json(res, 400, { ok: false, error: 'A valid employee and coaching date are required.' });
      if (!COACHING_CATEGORIES.includes(category)) return json(res, 400, { ok: false, error: 'A valid coaching category is required.' });
      if (!observation) return json(res, 400, { ok: false, error: 'A specific observation is required.' });
      const roster = await loadRosterSnapshot();
      const employee = (roster.records || []).find(x => ptoLogic.cleanEmail(x.employeeEmail) === email);
      const isDirectReport = Boolean(employee) && scopedTeamMembers(roster, identity, session, session.employeeName, false).some(x => ptoLogic.cleanEmail(x.employeeEmail) === email);
      // The QA DSAT reviewer can also file a coaching log for any active employee whose
      // validated DSAT calls for it, on behalf of that employee's actual team lead - not just
      // her own reports. The record still attributes teamLeadEmail/teamLeadName to the real
      // team lead; createdBy (below) is what shows it was actually entered by QA.
      const isQaOnBehalf = !isDirectReport && portalRoleFor(identity) === 'BQA' && employee && employee.active !== false;
      if (!isDirectReport && !isQaOnBehalf) return json(res, 403, { ok: false, error: 'Not your direct report.' });
      const currentStanding = await buildCoachingStandingSnapshot(email);
      const data = await loadCoaching();
      // Explicit linkage to an earlier session on the same underlying problem, not an
      // auto-detected one - the team lead decides whether this is really a continuation.
      // Restricted to the SAME employee, any category (see the GET route's comment above).
      let linkedFromCoachingId = null;
      if (body.linkedFromCoachingId) {
        const linkTarget = (data.records || []).find(x => x.coachingId === String(body.linkedFromCoachingId));
        if (!linkTarget) return json(res, 400, { ok: false, error: 'The coaching session to link from could not be found.' });
        if (ptoLogic.cleanEmail(linkTarget.employeeEmail) !== email) return json(res, 400, { ok: false, error: 'Can only link to a previous session for the same employee.' });
        linkedFromCoachingId = linkTarget.coachingId;
      }
      const year = coachingDate.slice(0, 4);
      const sequence = (data.sequenceByYear[year] || 0) + 1;
      const coachingId = `COACH-${year}-${String(sequence).padStart(4, '0')}`;
      const now = new Date().toISOString();
      const status = body.status === 'SENT' ? 'SENT' : 'DRAFT';
      const record = {
        coachingId, employeeEmail: email, employeeName: employee.employeeName || email, employeeId: employee.employeeId || '',
        teamLeadEmail: isQaOnBehalf ? ptoLogic.cleanEmail(employee.teamLeadEmail || '') : identity,
        teamLeadName: isQaOnBehalf ? (employee.teamLeadName || '') : (String((roster.records || []).find(x => ptoLogic.cleanEmail(x.employeeEmail) === identity)?.employeeName || session.employeeName || '').trim()),
        coachingDate, category, currentStanding, observation, linkedFromCoachingId,
        // Discussion & Development Plan, Action Plan, and Follow-Up Date are filled in by the
        // employee at acknowledge time (see the 'acknowledge' action below), not by the team
        // lead who files this session.
        discussionSummary: '', actionPlan: '', targetFollowUpDate: null,
        status, createdAt: now, updatedAt: now, sentAt: status === 'SENT' ? now : null,
        acknowledgment: null, createdBy: identity, initiatedByQa: isQaOnBehalf ? (session.employeeName || identity) : null
      };
      data.sequenceByYear[year] = sequence;
      data.records.push(record);
      await saveCoaching(data);
      await appendCoachingAudit(coachingId, status === 'SENT' ? 'CREATED_AND_SENT' : 'CREATED_DRAFT', { user: identity, newValue: record });
      return json(res, 201, { ok: true, record });
    }

    const coachingMatch = parsed.pathname.match(/^\/api\/my\/(?:team-)?coaching\/([^/]+)(?:\/(send|acknowledge))?$/);
    if (coachingMatch) {
      const coachingId = decodeURIComponent(coachingMatch[1]), action = coachingMatch[2] || '';
      const data = await loadCoaching();
      const index = (data.records || []).findIndex(x => x.coachingId === coachingId);
      if (index < 0) return json(res, 404, { ok: false, error: 'Coaching record not found.' });
      const current = data.records[index];
      const isOwner = ptoLogic.cleanEmail(current.teamLeadEmail) === identity;
      if (req.method === 'GET' && !action) {
        if (!isOwner && ptoLogic.cleanEmail(current.employeeEmail) !== identity) return json(res, 403, { ok: false, error: 'Not authorized to view this coaching record.' });
        if (!isOwner && current.status === 'DRAFT') return json(res, 404, { ok: false, error: 'Coaching record not found.' });
        return json(res, 200, { ok: true, record: current });
      }
      const body = await readJsonBody(req);
      const now = new Date().toISOString();
      if (req.method === 'PUT' && !action) {
        if (!isOwner) return json(res, 403, { ok: false, error: 'Only the team lead who created this record can edit it.' });
        if (current.status !== 'DRAFT') return json(res, 409, { ok: false, error: 'Only a draft coaching record can be edited.' });
        const next = {
          ...current,
          category: COACHING_CATEGORIES.includes(body.category) ? body.category : current.category,
          observation: String(body.observation ?? current.observation).trim(),
          updatedAt: now
        };
        data.records[index] = next;
        await saveCoaching(data);
        await appendCoachingAudit(coachingId, 'EDITED', { user: identity, previousValue: current, newValue: next });
        return json(res, 200, { ok: true, record: next });
      }
      if (req.method === 'DELETE' && !action) {
        if (!isOwner) return json(res, 403, { ok: false, error: 'Only the team lead who created this record can delete it.' });
        if (current.status === 'ACKNOWLEDGED') return json(res, 409, { ok: false, error: 'An acknowledged coaching record cannot be deleted.' });
        data.records.splice(index, 1);
        data.deletedCoachingIds = [...new Set([...(data.deletedCoachingIds || []), coachingId])];
        await saveCoaching(data);
        await appendCoachingAudit(coachingId, 'DELETED', { user: identity, previousValue: current });
        return json(res, 200, { ok: true, deleted: coachingId });
      }
      if (action === 'send') {
        if (!isOwner) return json(res, 403, { ok: false, error: 'Only the team lead who created this record can send it.' });
        if (current.status !== 'DRAFT') return json(res, 409, { ok: false, error: 'Only a draft coaching record can be sent.' });
        const next = { ...current, status: 'SENT', sentAt: now, updatedAt: now };
        data.records[index] = next;
        await saveCoaching(data);
        await appendCoachingAudit(coachingId, 'SENT', { user: identity, previousValue: current.status, newValue: 'SENT' });
        return json(res, 200, { ok: true, record: next });
      }
      if (action === 'acknowledge') {
        if (ptoLogic.cleanEmail(current.employeeEmail) !== identity) return json(res, 403, { ok: false, error: 'You can only sign your own coaching record.' });
        if (current.status !== 'SENT') return json(res, 409, { ok: false, error: 'Only a sent coaching record can be acknowledged.' });
        const signedName = String(body.signedName || '').trim();
        if (!signedName) return json(res, 400, { ok: false, error: 'Please type your full name to sign.' });
        const next = {
          ...current, status: 'ACKNOWLEDGED', updatedAt: now,
          discussionSummary: String(body.discussionSummary ?? current.discussionSummary ?? '').trim(),
          actionPlan: String(body.actionPlan ?? current.actionPlan ?? '').trim(),
          targetFollowUpDate: ptoLogic.validDate(body.targetFollowUpDate) ? body.targetFollowUpDate : (body.targetFollowUpDate === null ? null : current.targetFollowUpDate),
          acknowledgment: { signedName, signedAt: now, repComments: String(body.repComments || '').trim() }
        };
        data.records[index] = next;
        await saveCoaching(data);
        await appendCoachingAudit(coachingId, 'ACKNOWLEDGED', { user: identity, previousValue: current.status, newValue: 'ACKNOWLEDGED', notes: signedName });
        return json(res, 200, { ok: true, record: next });
      }
      return json(res, 404, { ok: false, error: 'Unknown coaching action.' });
    }

    if (parsed.pathname === '/api/my/coaching' && req.method === 'GET') {
      const data = await loadCoaching();
      const records = (data.records || []).filter(x => ptoLogic.cleanEmail(x.employeeEmail) === identity && x.status !== 'DRAFT').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return json(res, 200, { ok: true, records, lastUpdated: data.lastUpdated || '' });
    }

    // SOM coaching oversight: company-wide read-only view of every coaching log across every
    // team, not scoped to any one team lead's own records like /api/my/team-coaching is. Drafts
    // are excluded (still private to the team lead who's drafting them, same rule as
    // /api/my/coaching above) since a draft isn't a real coaching action yet.
    if (parsed.pathname === '/api/som/coaching-overview' && req.method === 'GET') {
      if (portalRoleFor(identity) !== 'SOM' && effectiveViewAsRole(identity, session) !== 'SOM') return json(res, 403, { ok: false, error: 'Not authorized.' });
      const data = await loadCoaching();
      const records = (data.records || []).filter(x => x.status !== 'DRAFT').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const statusKey = s => (s === 'SENT' ? 'sent' : 'acknowledged');
      const byTeam = new Map(), byRep = new Map();
      for (const r of records) {
        const teamKey = r.teamLeadName || 'Unassigned';
        if (!byTeam.has(teamKey)) byTeam.set(teamKey, { teamLeadName: teamKey, total: 0, sent: 0, acknowledged: 0 });
        const team = byTeam.get(teamKey);
        team.total++; team[statusKey(r.status)]++;
        const repKey = ptoLogic.cleanEmail(r.employeeEmail);
        if (!byRep.has(repKey)) byRep.set(repKey, { employeeEmail: repKey, employeeName: r.employeeName, teamLeadName: teamKey, total: 0, sent: 0, acknowledged: 0, lastCoachingDate: '' });
        const rep = byRep.get(repKey);
        rep.total++; rep[statusKey(r.status)]++;
        if (r.coachingDate > rep.lastCoachingDate) rep.lastCoachingDate = r.coachingDate;
      }
      const site = { total: records.length, sent: records.filter(r => r.status === 'SENT').length, acknowledged: records.filter(r => r.status === 'ACKNOWLEDGED').length };
      return json(res, 200, {
        ok: true, site,
        byTeam: [...byTeam.values()].sort((a, b) => b.total - a.total),
        byRep: [...byRep.values()].sort((a, b) => b.total - a.total),
        records
      });
    }

    // Alignment: a team lead pastes an SOP/Process Update/Feature Update, picks which employees
    // need to acknowledge it (any active non-leadership employee company-wide, not just their
    // own direct reports - a process update often needs to reach reps outside one's own team),
    // and submits it to the SOM (Charlotte) for approval. Only once APPROVED does it appear on
    // each target rep's own portal to e-sign - unlike Coaching (one session, one employee), one
    // Alignment item can be signed by many reps independently, so acknowledgments are keyed by
    // employeeEmail on the record itself rather than being a single status transition.
    // "Leadership" = kpiType 'Excluded' (team leads, SOM, HR) - they're left off the target
    // pool since they don't need to acknowledge rep-level process updates the same way.
    async function hasDirectReports(identity, employeeName, viewAsRole = '') {
      const roster = await loadRosterSnapshot();
      if (viewAsRole === 'TRAINING' || portalRoleFor(identity) === 'TRAINING') {
        const scopeIdentity = viewAsRole === 'TRAINING' ? trainingManagerIdentity() : ptoLogic.cleanEmail(identity);
        return (roster.records || []).some(x => x.active !== false && x.kpiType === 'Trainee' && ptoLogic.cleanEmail(x.teamLeadEmail) === scopeIdentity);
      }
      const signedInEmployee = (roster.records || []).find(x => ptoLogic.cleanEmail(x.employeeEmail) === identity) || null;
      const leaderName = String(signedInEmployee?.employeeName || employeeName || '').trim();
      return (roster.records || []).some(x => x.active !== false && ptoLogic.cleanEmail(x.employeeEmail) !== identity && (ptoLogic.cleanEmail(x.teamLeadEmail) === identity || String(x.teamLeadName || '').trim() === leaderName));
    }
    // Leadership (kpiType 'Excluded') used to be excluded outright - now included, tagged with
    // isLeadership, since leadership sometimes needs to acknowledge the same SOP/process update
    // as everyone else. The "Include Leaders" checkbox in the target picker is a client-side
    // display filter over this same full list, not a separate eligibility rule - a team lead
    // being able to loop in a manager isn't a privilege concern worth gating server-side.
    async function eligibleAlignmentTargets(identity) {
      const roster = await loadRosterSnapshot();
      return (roster.records || []).filter(x => x.active !== false && ptoLogic.cleanEmail(x.employeeEmail) !== identity)
        .map(x => ({ ...x, isLeadership: x.kpiType === 'Excluded' }));
    }
    // Shared by /api/my/generate-quiz's AI output and the team-alignment create/edit routes'
    // manually-authored questions - drops anything malformed (no text, fewer than 2 options,
    // not exactly one marked correct) rather than trusting either source blindly.
    function sanitizeQuizQuestions(raw) {
      if (!Array.isArray(raw)) return [];
      return raw.map((q, qi) => {
        const text = String(q?.text || '').trim();
        const options = Array.isArray(q?.options)
          ? q.options.map((o, oi) => ({ id: `o${oi}`, text: String(o?.text || '').trim(), correct: Boolean(o?.correct) })).filter(o => o.text)
          : [];
        return { id: `q${qi}`, text, options };
      }).filter(q => q.text && q.options.length >= 2 && q.options.filter(o => o.correct).length === 1);
    }
    if (parsed.pathname === '/api/my/team-alignment' && req.method === 'GET') {
      const [isTeamLeader, eligibleTargets] = await Promise.all([hasDirectReports(identity, session.employeeName, effectiveViewAsRole(identity, session)), eligibleAlignmentTargets(identity)]);
      const data = await loadAlignment();
      const records = (data.records || []).filter(x => ptoLogic.cleanEmail(x.createdBy) === identity).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return json(res, 200, { ok: true, isTeamLeader, categories: ALIGNMENT_CATEGORY_OPTIONS, members: eligibleTargets.map(x => ({ employeeEmail: ptoLogic.cleanEmail(x.employeeEmail), employeeName: x.employeeName, isLeadership: x.isLeadership })), records, lastUpdated: data.lastUpdated || '' });
    }

    if (parsed.pathname === '/api/my/team-alignment' && req.method === 'POST') {
      if (!(await hasDirectReports(identity, session.employeeName))) return json(res, 403, { ok: false, error: 'Only a team lead can file an alignment item.' });
      const body = await readJsonBody(req);
      const title = String(body.title || '').trim();
      const category = String(body.category || '');
      const contentHtml = String(body.body || '').trim();
      if (!title) return json(res, 400, { ok: false, error: 'A title is required.' });
      if (!ALIGNMENT_CATEGORIES.includes(category)) return json(res, 400, { ok: false, error: 'A valid category is required.' });
      if (!contentHtml) return json(res, 400, { ok: false, error: 'Content is required.' });
      const effectiveDate = ptoLogic.validDate(body.effectiveDate) ? body.effectiveDate : null;
      const dueDate = ptoLogic.validDate(body.dueDate) ? body.dueDate : null;
      const roster = await loadRosterSnapshot();
      const signedInEmployee = (roster.records || []).find(x => ptoLogic.cleanEmail(x.employeeEmail) === identity) || null;
      const leaderName = String(signedInEmployee?.employeeName || session.employeeName || '').trim();
      const eligibleTargets = await eligibleAlignmentTargets(identity);
      const requestedTargets = Array.isArray(body.targetEmployees) ? body.targetEmployees.map(ptoLogic.cleanEmail) : [];
      const targetEmployees = eligibleTargets.filter(x => requestedTargets.includes(ptoLogic.cleanEmail(x.employeeEmail))).map(x => ({ employeeEmail: ptoLogic.cleanEmail(x.employeeEmail), employeeName: x.employeeName }));
      if (!targetEmployees.length) return json(res, 400, { ok: false, error: 'Select at least one employee who needs to acknowledge this.' });
      const data = await loadAlignment();
      const year = new Date().toISOString().slice(0, 4);
      const sequence = (data.sequenceByYear[year] || 0) + 1;
      const alignmentId = `ALIGN-${year}-${String(sequence).padStart(4, '0')}`;
      const now = new Date().toISOString();
      const status = body.status === 'PENDING_APPROVAL' ? 'PENDING_APPROVAL' : 'DRAFT';
      const record = {
        alignmentId, title, category, body: contentHtml, effectiveDate, dueDate,
        createdBy: identity, teamLeadName: leaderName || session.employeeName || '',
        targetEmployees, status, createdAt: now, updatedAt: now,
        submittedAt: status === 'PENDING_APPROVAL' ? now : null,
        decidedAt: null, decidedByName: null, decisionNotes: null,
        quiz: sanitizeQuizQuestions(body.quiz),
        acknowledgments: {}
      };
      data.sequenceByYear[year] = sequence;
      data.records.push(record);
      await saveAlignment(data);
      await appendAlignmentAudit(alignmentId, status === 'PENDING_APPROVAL' ? 'CREATED_AND_SUBMITTED' : 'CREATED_DRAFT', { user: identity, newValue: record });
      return json(res, 201, { ok: true, record });
    }

    // Due Date is scheduling metadata, not reviewed content - unlike title/category/body/
    // targets (locked once APPROVED so a change can't quietly diverge from what SOM actually
    // approved), a team lead should still be able to fix a due-date typo or push a deadline
    // regardless of status, without needing to unwind an already-approved item.
    const alignmentDueDateMatch = parsed.pathname.match(/^\/api\/my\/team-alignment\/([^/]+)\/due-date$/);
    if (alignmentDueDateMatch && req.method === 'PUT') {
      const alignmentId = decodeURIComponent(alignmentDueDateMatch[1]);
      const data = await loadAlignment();
      const index = (data.records || []).findIndex(x => x.alignmentId === alignmentId);
      if (index < 0) return json(res, 404, { ok: false, error: 'Alignment record not found.' });
      const current = data.records[index];
      if (ptoLogic.cleanEmail(current.createdBy) !== identity) return json(res, 403, { ok: false, error: 'Only the team lead who created this can manage it.' });
      const body = await readJsonBody(req);
      if (body.dueDate && !ptoLogic.validDate(body.dueDate)) return json(res, 400, { ok: false, error: 'Due date must be a valid date.' });
      const dueDate = body.dueDate ? body.dueDate : null;
      const now = new Date().toISOString();
      const next = { ...current, dueDate, updatedAt: now };
      data.records[index] = next;
      await saveAlignment(data);
      await appendAlignmentAudit(alignmentId, 'DUE_DATE_UPDATED', { user: identity, previousValue: { dueDate: current.dueDate || null }, newValue: { dueDate } });
      return json(res, 200, { ok: true, record: next });
    }

    const alignmentMatch = parsed.pathname.match(/^\/api\/my\/team-alignment\/([^/]+)(?:\/(submit))?$/);
    if (alignmentMatch) {
      const alignmentId = decodeURIComponent(alignmentMatch[1]), action = alignmentMatch[2] || '';
      const data = await loadAlignment();
      const index = (data.records || []).findIndex(x => x.alignmentId === alignmentId);
      if (index < 0) return json(res, 404, { ok: false, error: 'Alignment record not found.' });
      const current = data.records[index];
      if (ptoLogic.cleanEmail(current.createdBy) !== identity) return json(res, 403, { ok: false, error: 'Only the team lead who created this can manage it.' });
      if (req.method === 'GET' && !action) return json(res, 200, { ok: true, record: current });
      const body = await readJsonBody(req);
      const now = new Date().toISOString();
      if (req.method === 'PUT' && !action) {
        if (!['DRAFT', 'REJECTED'].includes(current.status)) return json(res, 409, { ok: false, error: 'Only a draft or rejected item can be edited.' });
        const title = String(body.title ?? current.title).trim();
        const category = ALIGNMENT_CATEGORIES.includes(body.category) ? body.category : current.category;
        const contentHtml = String(body.body ?? current.body).trim();
        const effectiveDate = body.effectiveDate === undefined ? current.effectiveDate : (ptoLogic.validDate(body.effectiveDate) ? body.effectiveDate : null);
        const dueDate = body.dueDate === undefined ? current.dueDate : (ptoLogic.validDate(body.dueDate) ? body.dueDate : null);
        let targetEmployees = current.targetEmployees;
        if (Array.isArray(body.targetEmployees)) {
          const eligibleTargets = await eligibleAlignmentTargets(identity);
          const requestedTargets = body.targetEmployees.map(ptoLogic.cleanEmail);
          targetEmployees = eligibleTargets.filter(x => requestedTargets.includes(ptoLogic.cleanEmail(x.employeeEmail))).map(x => ({ employeeEmail: ptoLogic.cleanEmail(x.employeeEmail), employeeName: x.employeeName }));
        }
        if (!title) return json(res, 400, { ok: false, error: 'A title is required.' });
        if (!contentHtml) return json(res, 400, { ok: false, error: 'Content is required.' });
        if (!targetEmployees.length) return json(res, 400, { ok: false, error: 'Select at least one employee who needs to acknowledge this.' });
        const quiz = body.quiz === undefined ? current.quiz : sanitizeQuizQuestions(body.quiz);
        const next = { ...current, title, category, body: contentHtml, effectiveDate, dueDate, targetEmployees, quiz, updatedAt: now };
        data.records[index] = next;
        await saveAlignment(data);
        await appendAlignmentAudit(alignmentId, 'EDITED', { user: identity, previousValue: current, newValue: next });
        return json(res, 200, { ok: true, record: next });
      }
      if (req.method === 'DELETE' && !action) {
        if (current.status === 'APPROVED') return json(res, 409, { ok: false, error: 'An approved alignment item cannot be deleted.' });
        data.records.splice(index, 1);
        await saveAlignment(data);
        await appendAlignmentAudit(alignmentId, 'DELETED', { user: identity, previousValue: current });
        return json(res, 200, { ok: true, deleted: alignmentId });
      }
      if (action === 'submit') {
        if (!['DRAFT', 'REJECTED'].includes(current.status)) return json(res, 409, { ok: false, error: 'Only a draft or rejected item can be submitted for approval.' });
        const next = { ...current, status: 'PENDING_APPROVAL', submittedAt: now, updatedAt: now, decidedAt: null, decidedByName: null, decisionNotes: null };
        data.records[index] = next;
        await saveAlignment(data);
        await appendAlignmentAudit(alignmentId, 'SUBMITTED', { user: identity, previousValue: current.status, newValue: 'PENDING_APPROVAL' });
        return json(res, 200, { ok: true, record: next });
      }
      return json(res, 404, { ok: false, error: 'Unknown alignment action.' });
    }

    if (parsed.pathname === '/api/som/alignment-review' && req.method === 'GET') {
      if (portalRoleFor(identity) !== 'SOM' && effectiveViewAsRole(identity, session) !== 'SOM') return json(res, 403, { ok: false, error: 'Not authorized.' });
      const data = await loadAlignment();
      const records = (data.records || []).filter(x => x.status !== 'DRAFT').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      // Mirrors the byTeam/byRep summary shape /api/som/coaching-overview already returns -
      // same "company-wide oversight, not just a raw list" pattern for this SOM tab too.
      const statusKey = s => (s === 'PENDING_APPROVAL' ? 'pendingApproval' : s === 'APPROVED' ? 'approved' : s === 'REJECTED' ? 'rejected' : null);
      const byTeam = new Map(), byCategory = new Map();
      let totalTargets = 0, totalAcknowledged = 0;
      for (const r of records) {
        const key = statusKey(r.status);
        const teamKey = r.teamLeadName || 'Unassigned';
        if (!byTeam.has(teamKey)) byTeam.set(teamKey, { teamLeadName: teamKey, total: 0, pendingApproval: 0, approved: 0, rejected: 0 });
        const team = byTeam.get(teamKey);
        team.total++; if (key) team[key]++;
        const categoryKey = r.category || 'Uncategorized';
        byCategory.set(categoryKey, (byCategory.get(categoryKey) || 0) + 1);
        if (r.status === 'APPROVED') {
          totalTargets += (r.targetEmployees || []).length;
          totalAcknowledged += Object.keys(r.acknowledgments || {}).length;
        }
      }
      const site = {
        total: records.length,
        pendingApproval: records.filter(r => r.status === 'PENDING_APPROVAL').length,
        approved: records.filter(r => r.status === 'APPROVED').length,
        rejected: records.filter(r => r.status === 'REJECTED').length,
        totalTargets, totalAcknowledged
      };
      return json(res, 200, {
        ok: true, site,
        byTeam: [...byTeam.values()].sort((a, b) => b.total - a.total),
        byCategory: [...byCategory.entries()].map(([category, total]) => ({ category, total })).sort((a, b) => b.total - a.total),
        records
      });
    }

    const alignmentDecideMatch = parsed.pathname.match(/^\/api\/som\/alignment-review\/([^/]+)\/decide$/);
    if (alignmentDecideMatch && req.method === 'POST') {
      if (portalRoleFor(identity) !== 'SOM') return json(res, 403, { ok: false, error: 'Not authorized.' });
      const alignmentId = decodeURIComponent(alignmentDecideMatch[1]);
      const body = await readJsonBody(req);
      const decision = String(body.decision || '').toUpperCase();
      if (!['APPROVED', 'REJECTED'].includes(decision)) return json(res, 400, { ok: false, error: 'A valid decision (APPROVED or REJECTED) is required.' });
      const data = await loadAlignment();
      const index = (data.records || []).findIndex(x => x.alignmentId === alignmentId);
      if (index < 0) return json(res, 404, { ok: false, error: 'Alignment record not found.' });
      const current = data.records[index];
      if (current.status !== 'PENDING_APPROVAL') return json(res, 409, { ok: false, error: 'Only an item pending approval can be decided.' });
      const now = new Date().toISOString();
      const next = { ...current, status: decision, decidedAt: now, decidedByName: session.employeeName, decisionNotes: String(body.notes || '').trim(), updatedAt: now };
      data.records[index] = next;
      await saveAlignment(data);
      await appendAlignmentAudit(alignmentId, decision, { user: identity, previousValue: current.status, newValue: decision, notes: next.decisionNotes });
      return json(res, 200, { ok: true, record: next });
    }

    if (parsed.pathname === '/api/my/alignment' && req.method === 'GET') {
      const data = await loadAlignment();
      const records = (data.records || [])
        .filter(x => x.status === 'APPROVED' && (x.targetEmployees || []).some(t => ptoLogic.cleanEmail(t.employeeEmail) === identity))
        .map(x => ({ ...x, myAcknowledgment: x.acknowledgments?.[identity] || null }))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return json(res, 200, { ok: true, records });
    }

    const alignmentAckMatch = parsed.pathname.match(/^\/api\/my\/alignment\/([^/]+)\/acknowledge$/);
    if (alignmentAckMatch && req.method === 'POST') {
      const alignmentId = decodeURIComponent(alignmentAckMatch[1]);
      const body = await readJsonBody(req);
      const signedName = String(body.signedName || '').trim();
      if (!signedName) return json(res, 400, { ok: false, error: 'Please type your full name to sign.' });
      const data = await loadAlignment();
      const index = (data.records || []).findIndex(x => x.alignmentId === alignmentId);
      if (index < 0) return json(res, 404, { ok: false, error: 'Alignment record not found.' });
      const current = data.records[index];
      if (!(current.targetEmployees || []).some(t => ptoLogic.cleanEmail(t.employeeEmail) === identity)) return json(res, 403, { ok: false, error: 'This item was not assigned to you.' });
      if (current.status !== 'APPROVED') return json(res, 409, { ok: false, error: 'Only an approved item can be acknowledged.' });
      if (current.acknowledgments?.[identity]) return json(res, 409, { ok: false, error: 'You have already acknowledged this.' });
      // Correctness itself is checked client-side (the sign button stays disabled until every
      // question is right) - this is a training/comprehension check, not a security boundary,
      // so the server's role is just making sure that gate wasn't skipped, and recording how
      // many wrong answers it took so the team lead sees more than a bare pass/fail.
      if ((current.quiz || []).length && !body.quizPassed) return json(res, 400, { ok: false, error: 'Answer every quiz question correctly before signing.' });
      const quizAttempts = Number.isFinite(Number(body.quizAttempts)) ? Math.max(0, Math.round(Number(body.quizAttempts))) : 0;
      const now = new Date().toISOString();
      const next = { ...current, acknowledgments: { ...current.acknowledgments, [identity]: { signedName, signedAt: now, quizAttempts } }, updatedAt: now };
      data.records[index] = next;
      await saveAlignment(data);
      await appendAlignmentAudit(alignmentId, 'ACKNOWLEDGED', { user: identity, notes: signedName });
      return json(res, 200, { ok: true, record: next });
    }

    // --- Training Manager: onboard new hires, log training performance, endorse to Ops ---

    if (parsed.pathname === '/api/training/new-hires' && req.method === 'GET') {
      if (portalRoleFor(identity) !== 'TRAINING' && effectiveViewAsRole(identity, session) !== 'TRAINING') return json(res, 403, { ok: false, error: 'Not authorized.' });
      const trainingIdentity = portalRoleFor(identity) === 'TRAINING' ? identity : trainingManagerIdentity();
      const roster = await loadRosterSnapshot();
      const trainees = (roster.records || []).filter(x => x.active !== false && x.kpiType === 'Trainee' && ptoLogic.cleanEmail(x.teamLeadEmail) === trainingIdentity)
        .sort((a, b) => (b.effectiveDate || '').localeCompare(a.effectiveDate || ''));
      return json(res, 200, { ok: true, trainees, destinations: eligibleTrainingDestinations(roster), productionKpiTypes: PRODUCTION_KPI_TYPES });
    }

    if (parsed.pathname === '/api/training/new-hires' && req.method === 'POST') {
      if (portalRoleFor(identity) !== 'TRAINING') return json(res, 403, { ok: false, error: 'Not authorized.' });
      const body = await readJsonBody(req);
      const employeeName = String(body.employeeName || '').trim();
      const employeeEmail = ptoLogic.cleanEmail(body.employeeEmail || '');
      const primaryChannel = String(body.primaryChannel || '').trim();
      const hireDate = String(body.hireDate || '').trim();
      const scheduleGroup = String(body.scheduleGroup || '').trim();
      if (!employeeName) return json(res, 400, { ok: false, error: 'Employee name is required.' });
      if (!employeeEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(employeeEmail)) return json(res, 400, { ok: false, error: 'A valid employee email is required.' });
      if (!primaryChannel) return json(res, 400, { ok: false, error: 'Primary channel is required.' });
      if (hireDate && !ptoLogic.validDate(hireDate)) return json(res, 400, { ok: false, error: 'Hire date must be a valid date.' });
      const roster = await loadRosterSnapshot();
      if ((roster.records || []).some(x => ptoLogic.cleanEmail(x.employeeEmail) === employeeEmail)) return json(res, 409, { ok: false, error: 'An employee with this email already exists.' });
      const now = new Date().toISOString();
      const record = {
        employeeName, employeeEmail, employeeId: '', jobTitle: '', teamLeadName: session.employeeName, teamLeadEmail: identity,
        primaryChannel, kpiType: 'Trainee', employmentStatus: 'Trainee', hireDate, birthday: '', active: true,
        effectiveDate: todayEasternDate(), separationDate: '', seniorTsrAssignment: '', scheduleGroup,
        contactNumber: '', contactEmail: '', emergencyContactName: '', emergencyContactRelationship: '', emergencyContactNumber: '', currentResidence: '', notes: '',
        lastUpdated: now
      };
      // Optimistic local update so the new hire shows up in Mae's own list immediately,
      // instead of waiting for the admin process's next ~30s sync tick to write it to disk.
      roster.records.push(record);
      await cloudStore.kvSetJson('mtdkpi:snapshot:roster', roster);
      snapshotCache.set('mtdkpi:snapshot:roster', { value: roster, at: Date.now() });
      const queue = await cloudStore.kvGetJson(NEW_HIRE_REQUESTS_KEY, []);
      queue.push({ action: 'create', record, requestedBy: identity, requestedAt: now });
      await cloudStore.kvSetJson(NEW_HIRE_REQUESTS_KEY, queue);
      return json(res, 201, { ok: true, employee: record });
    }

    const trainingEndorseMatch = parsed.pathname.match(/^\/api\/training\/new-hires\/([^/]+)\/endorse$/);
    if (trainingEndorseMatch && req.method === 'POST') {
      if (portalRoleFor(identity) !== 'TRAINING') return json(res, 403, { ok: false, error: 'Not authorized.' });
      const targetEmail = ptoLogic.cleanEmail(decodeURIComponent(trainingEndorseMatch[1]));
      const roster = await loadRosterSnapshot();
      const trainee = (roster.records || []).find(x => ptoLogic.cleanEmail(x.employeeEmail) === targetEmail && x.kpiType === 'Trainee' && ptoLogic.cleanEmail(x.teamLeadEmail) === identity);
      if (!trainee) return json(res, 404, { ok: false, error: 'This person is not one of your current trainees.' });
      const body = await readJsonBody(req);
      const decision = String(body.decision || '').toUpperCase();
      if (!['ENDORSED', 'REJECTED'].includes(decision)) return json(res, 400, { ok: false, error: 'A valid decision (ENDORSED or REJECTED) is required.' });
      const now = new Date().toISOString();
      let request, updatedFields;
      if (decision === 'ENDORSED') {
        const kpiType = String(body.kpiType || '');
        if (!PRODUCTION_KPI_TYPES.includes(kpiType)) return json(res, 400, { ok: false, error: 'A valid production role is required to endorse.' });
        const destinationEmail = ptoLogic.cleanEmail(body.teamLeadEmail || '');
        const destination = (roster.records || []).find(x => ptoLogic.cleanEmail(x.employeeEmail) === destinationEmail && x.active !== false);
        if (!destination) return json(res, 400, { ok: false, error: 'A valid destination team lead is required to endorse.' });
        const primaryChannel = String(body.primaryChannel || trainee.primaryChannel || '');
        updatedFields = { kpiType, employmentStatus: 'Active', teamLeadName: destination.employeeName, teamLeadEmail: destinationEmail, primaryChannel, effectiveDate: todayEasternDate() };
        request = { action: 'endorse', employeeEmail: targetEmail, ...updatedFields, requestedBy: identity, requestedAt: now };
      } else {
        updatedFields = { employmentStatus: 'Terminated', active: false, separationDate: todayEasternDate() };
        request = { action: 'reject', employeeEmail: targetEmail, requestedBy: identity, requestedAt: now };
      }
      const index = roster.records.findIndex(x => ptoLogic.cleanEmail(x.employeeEmail) === targetEmail);
      roster.records[index] = { ...trainee, ...updatedFields, lastUpdated: now };
      await cloudStore.kvSetJson('mtdkpi:snapshot:roster', roster);
      snapshotCache.set('mtdkpi:snapshot:roster', { value: roster, at: Date.now() });
      const queue = await cloudStore.kvGetJson(NEW_HIRE_REQUESTS_KEY, []);
      queue.push(request);
      await cloudStore.kvSetJson(NEW_HIRE_REQUESTS_KEY, queue);
      return json(res, 200, { ok: true, employee: roster.records[index] });
    }

    if (parsed.pathname === '/api/training/scores' && req.method === 'GET') {
      if (portalRoleFor(identity) !== 'TRAINING' && effectiveViewAsRole(identity, session) !== 'TRAINING') return json(res, 403, { ok: false, error: 'Not authorized.' });
      const trainingIdentity = portalRoleFor(identity) === 'TRAINING' ? identity : trainingManagerIdentity();
      const roster = await loadRosterSnapshot();
      const traineeEmails = new Set((roster.records || []).filter(x => ptoLogic.cleanEmail(x.teamLeadEmail) === trainingIdentity).map(x => ptoLogic.cleanEmail(x.employeeEmail)));
      const requestedEmail = ptoLogic.cleanEmail(parsed.searchParams.get('employeeEmail') || '');
      const data = await loadTrainingScores();
      const records = (data.records || []).filter(x => traineeEmails.has(ptoLogic.cleanEmail(x.employeeEmail)) && (!requestedEmail || ptoLogic.cleanEmail(x.employeeEmail) === requestedEmail))
        .sort((a, b) => (b.entryDate || '').localeCompare(a.entryDate || ''));
      return json(res, 200, { ok: true, records, categories: TRAINING_SCORE_CATEGORIES });
    }

    if (parsed.pathname === '/api/training/scores' && req.method === 'POST') {
      if (portalRoleFor(identity) !== 'TRAINING') return json(res, 403, { ok: false, error: 'Not authorized.' });
      const body = await readJsonBody(req);
      const employeeEmail = ptoLogic.cleanEmail(body.employeeEmail || '');
      const category = String(body.category || '');
      const title = String(body.title || '').trim();
      const entryDate = String(body.entryDate || '').trim() || todayEasternDate();
      if (!TRAINING_SCORE_CATEGORIES.includes(category)) return json(res, 400, { ok: false, error: 'A valid category is required.' });
      if (!title) return json(res, 400, { ok: false, error: 'A title/description is required.' });
      if (!ptoLogic.validDate(entryDate)) return json(res, 400, { ok: false, error: 'Entry date must be a valid date.' });
      const roster = await loadRosterSnapshot();
      const trainee = (roster.records || []).find(x => ptoLogic.cleanEmail(x.employeeEmail) === employeeEmail && ptoLogic.cleanEmail(x.teamLeadEmail) === identity);
      if (!trainee) return json(res, 403, { ok: false, error: 'That employee is not one of your trainees.' });
      let score = null;
      if (body.score !== '' && body.score != null) {
        if (!Number.isFinite(Number(body.score))) return json(res, 400, { ok: false, error: 'Score must be a number.' });
        score = Math.max(0, Math.min(100, Math.round(Number(body.score))));
      }
      const data = await loadTrainingScores();
      const record = { scoreId: `TRN-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, employeeEmail, employeeName: trainee.employeeName, category, title, score, notes: String(body.notes || '').trim(), entryDate, createdBy: identity, createdAt: new Date().toISOString() };
      data.records.push(record);
      await saveTrainingScores(data);
      return json(res, 201, { ok: true, record });
    }

    const trainingScoreDeleteMatch = parsed.pathname.match(/^\/api\/training\/scores\/([^/]+)$/);
    if (trainingScoreDeleteMatch && req.method === 'DELETE') {
      if (portalRoleFor(identity) !== 'TRAINING') return json(res, 403, { ok: false, error: 'Not authorized.' });
      const scoreId = decodeURIComponent(trainingScoreDeleteMatch[1]);
      const data = await loadTrainingScores();
      const index = (data.records || []).findIndex(x => x.scoreId === scoreId);
      if (index < 0) return json(res, 404, { ok: false, error: 'Score entry not found.' });
      data.records.splice(index, 1);
      await saveTrainingScores(data);
      return json(res, 200, { ok: true, deleted: scoreId });
    }

    if (parsed.pathname === '/api/my/team-disciplinary' && req.method === 'GET') {
      const [roster, access] = await Promise.all([loadRosterSnapshot(), disciplinaryReviewAccess(identity, session.employeeName, effectiveViewAsRole(identity, session))]);
      const data = await loadDisciplinary();
      const allRecords = data.records || [];
      const records = (access.canDecide || access.canPreDecide)
        ? allRecords.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        : allRecords.filter(x => access.memberEmails.has(ptoLogic.cleanEmail(x.employeeEmail))).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const assignedMembers = (roster.records || []).filter(x => access.memberEmails.has(ptoLogic.cleanEmail(x.employeeEmail)));
      return json(res, 200, {
        ok: true, isTeamLeader: access.isTeamLeader, canPreDecide: access.canPreDecide, canDecide: access.canDecide,
        categories: DISCIPLINARY_CATEGORIES, tiers: DISCIPLINE_TIERS, tierLabels: DISCIPLINE_TIER_LABELS,
        members: assignedMembers.map(x => ({ employeeEmail: ptoLogic.cleanEmail(x.employeeEmail), employeeName: x.employeeName })),
        records, lastUpdated: data.lastUpdated || ''
      });
    }

    if (parsed.pathname === '/api/my/team-disciplinary' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const email = ptoLogic.cleanEmail(body.employeeEmail || '');
      const infractionDate = String(body.infractionDate || '');
      const category = String(body.category || '');
      const tier = String(body.tier || '');
      const infractionDescription = String(body.infractionDescription || '').trim();
      if (!email || !ptoLogic.validDate(infractionDate)) return json(res, 400, { ok: false, error: 'A valid employee and infraction date are required.' });
      if (!DISCIPLINARY_CATEGORIES.includes(category)) return json(res, 400, { ok: false, error: 'A valid infraction category is required.' });
      if (!DISCIPLINE_TIERS.includes(tier)) return json(res, 400, { ok: false, error: 'A valid infraction tier is required.' });
      if (!infractionDescription) return json(res, 400, { ok: false, error: 'A description of the infraction is required.' });
      const roster = await loadRosterSnapshot();
      const signedInEmployee = (roster.records || []).find(x => ptoLogic.cleanEmail(x.employeeEmail) === identity) || null;
      const leaderName = String(signedInEmployee?.employeeName || session.employeeName || '').trim();
      const employee = (roster.records || []).find(x => ptoLogic.cleanEmail(x.employeeEmail) === email);
      const isDirectReport = Boolean(employee) && scopedTeamMembers(roster, identity, session, session.employeeName, false).some(x => ptoLogic.cleanEmail(x.employeeEmail) === email);
      if (!isDirectReport) return json(res, 403, { ok: false, error: 'Not your direct report.' });
      const data = await loadDisciplinary();
      const { instanceNumber, suggestedSanction } = disciplinaryInstanceAndSanction(tier, email, infractionDate, data.records || []);
      const year = infractionDate.slice(0, 4);
      const sequence = (data.sequenceByYear[year] || 0) + 1;
      const violationId = `VIOL-${year}-${String(sequence).padStart(4, '0')}`;
      const now = new Date().toISOString();
      const record = {
        violationId, employeeEmail: email, employeeName: employee.employeeName || email, employeeId: employee.employeeId || '',
        teamLeadEmail: identity, teamLeadName: leaderName || session.employeeName || '',
        category, tier, infractionDescription, infractionDate, filedDate: todayEasternDate(),
        instanceNumber, suggestedSanction,
        preTier: null, preSanction: null, preNotes: '', preDecidedBy: null, preDecidedByName: null, preDecidedAt: null,
        finalTier: null, finalSanction: null, circumstanceNotes: '', sanctionDate: null, cleansingExpiryDate: null,
        status: 'FILED', decidedBy: null, decidedByName: null,
        acknowledgment: null, createdAt: now, updatedAt: now, createdBy: identity
      };
      data.sequenceByYear[year] = sequence;
      data.records.push(record);
      await saveDisciplinary(data);
      await appendDisciplinaryAudit(violationId, 'FILED', { user: identity, newValue: record });
      return json(res, 201, { ok: true, record });
    }

    const violationMatch = parsed.pathname.match(/^\/api\/my\/(?:team-)?disciplinary\/([^/]+)(?:\/(predecide|decide|acknowledge))?$/);
    if (violationMatch) {
      const violationId = decodeURIComponent(violationMatch[1]), action = violationMatch[2] || '';
      const data = await loadDisciplinary();
      const index = (data.records || []).findIndex(x => x.violationId === violationId);
      if (index < 0) return json(res, 404, { ok: false, error: 'Disciplinary record not found.' });
      const current = data.records[index];
      // viewAsRole is only ever passed on a plain GET below - predecide/decide/acknowledge
      // (action truthy, always POST) always call disciplinaryReviewAccess with no override,
      // so those branches check the real identity exclusively.
      const access = await disciplinaryReviewAccess(identity, session.employeeName, req.method === 'GET' && !action ? effectiveViewAsRole(identity, session) : '');
      const isOwner = ptoLogic.cleanEmail(current.teamLeadEmail) === identity;
      if (req.method === 'GET' && !action) {
        const isEmployee = ptoLogic.cleanEmail(current.employeeEmail) === identity;
        if (!isOwner && !access.canDecide && !access.canPreDecide && !isEmployee) return json(res, 403, { ok: false, error: 'Not authorized to view this record.' });
        if (isEmployee && !isOwner && !access.canDecide && !access.canPreDecide && !['DECIDED', 'ACKNOWLEDGED'].includes(current.status)) return json(res, 404, { ok: false, error: 'Disciplinary record not found.' });
        return json(res, 200, { ok: true, record: current });
      }
      const body = await readJsonBody(req);
      const now = new Date().toISOString();
      if (req.method === 'PUT' && !action) {
        if (!isOwner) return json(res, 403, { ok: false, error: 'Only the team lead who filed this record can edit it.' });
        if (current.status !== 'FILED') return json(res, 409, { ok: false, error: 'Only a case still awaiting pre-review can be edited.' });
        const tier = DISCIPLINE_TIERS.includes(body.tier) ? body.tier : current.tier;
        const infractionDate = ptoLogic.validDate(body.infractionDate) ? body.infractionDate : current.infractionDate;
        const { instanceNumber, suggestedSanction } = disciplinaryInstanceAndSanction(tier, current.employeeEmail, infractionDate, (data.records || []).filter(x => x.violationId !== violationId));
        const next = {
          ...current,
          category: DISCIPLINARY_CATEGORIES.includes(body.category) ? body.category : current.category,
          tier, infractionDate, instanceNumber, suggestedSanction,
          infractionDescription: String(body.infractionDescription ?? current.infractionDescription).trim(),
          updatedAt: now
        };
        data.records[index] = next;
        await saveDisciplinary(data);
        await appendDisciplinaryAudit(violationId, 'EDITED', { user: identity, previousValue: current, newValue: next });
        return json(res, 200, { ok: true, record: next });
      }
      if (req.method === 'DELETE' && !action) {
        if (!isOwner) return json(res, 403, { ok: false, error: 'Only the team lead who filed this record can withdraw it.' });
        if (!['FILED', 'PRE_DECIDED'].includes(current.status)) return json(res, 409, { ok: false, error: 'Only a case still awaiting a final decision can be withdrawn.' });
        data.records[index] = { ...current, status: 'WITHDRAWN', updatedAt: now };
        await saveDisciplinary(data);
        await appendDisciplinaryAudit(violationId, 'WITHDRAWN', { user: identity, previousValue: current.status, newValue: 'WITHDRAWN' });
        return json(res, 200, { ok: true, record: data.records[index] });
      }
      if (action === 'predecide') {
        if (!access.canPreDecide) return json(res, 403, { ok: false, error: 'Only the Senior Operations Manager can pre-review a disciplinary case.' });
        if (current.status !== 'FILED') return json(res, 409, { ok: false, error: 'Only a newly filed case can be pre-reviewed.' });
        const preTier = DISCIPLINE_TIERS.includes(body.preTier) ? body.preTier : current.tier;
        const preNotes = String(body.preNotes || '').trim();
        const { suggestedSanction: ladderSanction } = disciplinaryInstanceAndSanction(preTier, current.employeeEmail, current.infractionDate, (data.records || []).filter(x => x.violationId !== violationId));
        const preSanction = DISCIPLINE_LADDER[preTier]?.includes(body.preSanction) ? body.preSanction : ladderSanction;
        const next = { ...current, preTier, preSanction, preNotes, status: 'PRE_DECIDED', preDecidedBy: identity, preDecidedByName: session.employeeName, preDecidedAt: now, updatedAt: now };
        data.records[index] = next;
        await saveDisciplinary(data);
        await appendDisciplinaryAudit(violationId, 'PRE_DECIDED', { user: identity, previousValue: current, newValue: next });
        return json(res, 200, { ok: true, record: next });
      }
      if (action === 'decide') {
        if (!access.canDecide) return json(res, 403, { ok: false, error: 'Only HR can make the final decision on a disciplinary case.' });
        if (current.status !== 'PRE_DECIDED') return json(res, 409, { ok: false, error: 'This case must be pre-reviewed by the Senior Operations Manager first.' });
        const baseTier = current.preTier || current.tier;
        const finalTier = DISCIPLINE_TIERS.includes(body.finalTier) ? body.finalTier : baseTier;
        const sanctionDate = ptoLogic.validDate(body.sanctionDate) ? body.sanctionDate : todayEasternDate();
        const circumstanceNotes = String(body.circumstanceNotes || '').trim();
        if (finalTier !== baseTier && !circumstanceNotes) return json(res, 400, { ok: false, error: 'Please note the mitigating/aggravating circumstance for adjusting the tier.' });
        const { suggestedSanction: ladderSanction } = disciplinaryInstanceAndSanction(finalTier, current.employeeEmail, current.infractionDate, (data.records || []).filter(x => x.violationId !== violationId));
        const finalSanction = DISCIPLINE_LADDER[finalTier]?.includes(body.finalSanction) ? body.finalSanction : ladderSanction;
        const cleansingExpiryDate = disciplinaryCleansingExpiry(sanctionDate, finalTier);
        const next = { ...current, finalTier, finalSanction, circumstanceNotes, sanctionDate, cleansingExpiryDate, status: 'DECIDED', decidedBy: identity, decidedByName: session.employeeName, updatedAt: now };
        data.records[index] = next;
        await saveDisciplinary(data);
        await appendDisciplinaryAudit(violationId, 'DECIDED', { user: identity, previousValue: current, newValue: next });
        return json(res, 200, { ok: true, record: next });
      }
      if (action === 'acknowledge') {
        if (ptoLogic.cleanEmail(current.employeeEmail) !== identity) return json(res, 403, { ok: false, error: 'You can only sign your own disciplinary record.' });
        if (current.status !== 'DECIDED') return json(res, 409, { ok: false, error: 'Only a decided case can be acknowledged.' });
        const signedName = String(body.signedName || '').trim();
        if (!signedName) return json(res, 400, { ok: false, error: 'Please type your full name to sign.' });
        const next = { ...current, status: 'ACKNOWLEDGED', updatedAt: now, acknowledgment: { signedName, signedAt: now, employeeComments: String(body.employeeComments || '').trim() } };
        data.records[index] = next;
        await saveDisciplinary(data);
        await appendDisciplinaryAudit(violationId, 'ACKNOWLEDGED', { user: identity, previousValue: current.status, newValue: 'ACKNOWLEDGED', notes: signedName });
        return json(res, 200, { ok: true, record: next });
      }
      return json(res, 404, { ok: false, error: 'Unknown disciplinary action.' });
    }

    if (parsed.pathname === '/api/my/disciplinary' && req.method === 'GET') {
      const data = await loadDisciplinary();
      const records = (data.records || []).filter(x => ptoLogic.cleanEmail(x.employeeEmail) === identity && ['DECIDED', 'ACKNOWLEDGED'].includes(x.status)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return json(res, 200, { ok: true, records, lastUpdated: data.lastUpdated || '' });
    }

    if (parsed.pathname === '/api/pto/settings' && req.method === 'GET') {
      const settings = await loadSettings();
      return json(res, 200, { ok: true, settings, dataStatus: 'Live' });
    }
    if (parsed.pathname === '/api/pto/settings' && req.method === 'PUT') {
      return json(res, 403, { ok: false, error: 'Threshold settings are managed on the internal dashboard, not the public PTO link.' });
    }

    if (parsed.pathname === '/api/pto/requests' && req.method === 'GET') {
      const data = await loadPto();
      const filters = {
        employee: identity,
        status: String(parsed.searchParams.get('status') || ''),
        ptoDate: String(parsed.searchParams.get('ptoDate') || ''),
        dateRequested: String(parsed.searchParams.get('dateRequested') || '')
      };
      const requests = (data.requests || []).filter(x =>
        ptoLogic.cleanEmail(x.employeeEmail) === filters.employee &&
        (!filters.status || x.status === filters.status) &&
        (!filters.ptoDate || (x.startDate <= filters.ptoDate && x.endDate >= filters.ptoDate)) &&
        (!filters.dateRequested || x.dateRequested === filters.dateRequested)
      );
      return json(res, 200, { ok: true, requests, lastUpdated: data.lastUpdated || '', dataStatus: 'Live' });
    }

    if (parsed.pathname === '/api/pto/team-requests' && req.method === 'GET') {
      const [data, access] = await Promise.all([loadPto(), ptoReviewAccess(identity, session.employeeName)]);
      const requests = (data.requests || []).filter(request =>
        request.status !== 'DRAFT' && canReviewPtoRequest(access, request)
      ).map(request => ({
        ...request,
        permissions: {
          canPreApprove: access.memberEmails.has(ptoLogic.cleanEmail(request.employeeEmail)) &&
            ['SUBMITTED', 'PENDING'].includes(request.status),
          canFinalApprove: access.canFinalApprove &&
            ptoLogic.cleanEmail(request.employeeEmail) !== identity &&
            (request.status === 'PRE_APPROVED' ||
              (['SUBMITTED', 'PENDING'].includes(request.status) &&
                (ptoLogic.cleanEmail(request.teamLeadEmail) === identity ||
                  String(request.teamLeadName || '').trim().toLowerCase() === 'charlotte sanchez')))
        }
      }));
      return json(res, 200, {
        ok: true,
        requests,
        isTeamLeader: access.isTeamLeader,
        canFinalApprove: access.canFinalApprove,
        finalApproverName: 'Charlotte Sanchez',
        lastUpdated: data.lastUpdated || '',
        dataStatus: 'Live'
      });
    }

    if (parsed.pathname === '/api/pto/team-calendar' && req.method === 'GET') {
      const month = /^\d{4}-\d{2}$/.test(parsed.searchParams.get('month') || '') ? parsed.searchParams.get('month') : todayEasternDate().slice(0, 7);
      const [data, leaders] = await Promise.all([loadPto(), leadershipRequesterEmails()]);
      const monthStart = `${month}-01`, monthEnd = `${month}-31`;
      // Company-wide, not team-scoped: PTO capacity limits are checked by KPI type and by team
      // lead across the whole roster (see applyPtoCapacityLimits), so a rep needs visibility into
      // every pending/approved request to judge date availability, not just their own team's.
      // Leadership's own PTO (team leads/BQA/SOM) is excluded here - that lives on the separate,
      // leadership-only Leadership PTO Calendar instead.
      const requests = (data.requests || [])
        .filter(r => r.status !== 'DRAFT' && !leaders.has(ptoLogic.cleanEmail(r.employeeEmail)) && r.startDate <= monthEnd && r.endDate >= monthStart)
        .map(r => ({
          requestId: r.requestId,
          employeeName: r.employeeName,
          isMine: ptoLogic.cleanEmail(r.employeeEmail) === identity,
          startDate: r.startDate,
          endDate: r.endDate,
          requestType: r.requestType,
          partialStartTime: r.partialStartTime || null,
          partialEndTime: r.partialEndTime || null,
          status: r.status,
          rdDates: r.rdDates || []
        }));
      return json(res, 200, { ok: true, month, requests, lastUpdated: data.lastUpdated || '', dataStatus: 'Live' });
    }

    if (parsed.pathname === '/api/pto/leadership-calendar' && req.method === 'GET') {
      if (!(await isPtoLeaderViewer(identity, session))) return json(res, 403, { ok: false, error: 'This calendar is only available to team leads, BQA, and SOM.' });
      const month = /^\d{4}-\d{2}$/.test(parsed.searchParams.get('month') || '') ? parsed.searchParams.get('month') : todayEasternDate().slice(0, 7);
      const [data, leaders] = await Promise.all([loadPto(), leadershipRequesterEmails()]);
      const monthStart = `${month}-01`, monthEnd = `${month}-31`;
      const requests = (data.requests || [])
        .filter(r => r.status !== 'DRAFT' && leaders.has(ptoLogic.cleanEmail(r.employeeEmail)) && r.startDate <= monthEnd && r.endDate >= monthStart)
        .map(r => ({
          requestId: r.requestId,
          employeeName: r.employeeName,
          employeeEmail: r.employeeEmail,
          teamLeadName: r.teamLeadName || '',
          startDate: r.startDate,
          endDate: r.endDate,
          requestType: r.requestType,
          partialStartTime: r.partialStartTime || null,
          partialEndTime: r.partialEndTime || null,
          status: r.status,
          reason: r.reason || '',
          employeeNotes: r.employeeNotes || '',
          requestedWorkdays: r.requestedWorkdays,
          rdDates: r.rdDates || [],
          preApproverName: r.preApproverName || r.preApproverEmail || '',
          preApprovalDate: r.preApprovalDate || '',
          preApproverNotes: r.preApproverNotes || '',
          approverName: r.approverName || r.approverEmail || r.finalApproverName || r.finalApproverEmail || '',
          approverNotes: r.approverNotes || r.finalApproverNotes || '',
          decisionDate: r.decisionDate || '',
          updatedAt: r.updatedAt || ''
        }));
      return json(res, 200, { ok: true, month, requests, lastUpdated: data.lastUpdated || '', dataStatus: 'Live' });
    }

    if (parsed.pathname === '/api/pto/requests' && req.method === 'POST') {
      if (mustChangePassword) return json(res, 403, { ok: false, error: 'Please change your temporary password before filing a request.' });
      const body = await readJsonBody(req);
      body.employeeEmail = identity;
      body.createdBy = identity;
      const [roster, schedules, data] = await Promise.all([loadRosterSnapshot(), loadScheduleSnapshot(), loadPto()]);
      const normalized = ptoLogic.normalizePtoRequest(body, { roster: roster.records || [], schedules });
      const conflicts = ptoLogic.ptoConflictsFor(normalized, data.requests || []);
      if (conflicts.length) return json(res, 409, { ok: false, error: 'This request overlaps an existing active PTO request.', conflicts });
      const year = normalized.dateRequested.slice(0, 4);
      const sequence = (data.sequenceByYear[year] || 0) + 1;
      const requestId = `PTO-${year}-${String(sequence).padStart(4, '0')}`;
      const now = new Date().toISOString();
      const request = { ...normalized, requestId, status: body.status === 'SUBMITTED' ? 'SUBMITTED' : 'DRAFT', approverEmail: null, approverName: '', approverNotes: '', decisionDate: null, approvedDates: [], integrationStatus: 'Not Applied', createdAt: now, updatedAt: now, revisions: [] };
      data.sequenceByYear[year] = sequence;
      data.requests.push(request);
      await savePto(data);
      await appendAudit(requestId, request.status === 'DRAFT' ? 'REQUEST_CREATED' : 'REQUEST_SUBMITTED', { user: identity, newValue: request, notes: request.reason });
      return json(res, 201, { ok: true, request, lastUpdated: data.lastUpdated });
    }

    if (parsed.pathname === '/api/pto/forecast' && req.method === 'GET') {
      const requestId = parsed.searchParams.get('requestId');
      const [pto, settings, roster, schedules, attendance] = await Promise.all([loadPto(), loadSettings(), loadRosterSnapshot(), loadScheduleSnapshot(), loadAttendanceSnapshot()]);
      const ctx = { pto, settings, roster: roster.records || [], schedules, attendance };
      if (requestId) {
        const request = (pto.requests || []).find(x => x.requestId === requestId);
        if (!request) return json(res, 404, { ok: false, error: 'PTO request not found.' });
        if (ptoLogic.cleanEmail(request.employeeEmail) !== identity) {
          const access = await ptoReviewAccess(identity, session.employeeName);
          if (!canReviewPtoRequest(access, request)) return json(res, 403, { ok: false, error: 'You can only view forecasts for your own requests or requests assigned to you for review.' });
        }
        const forecastResult = ptoLogic.buildPtoForecast({ requestId }, ctx);
        forecastResult.rdDates = request.rdDates || [];
        if (forecastResult.forecastStatus === 'SCHEDULE_MISSING') return json(res, 200, forecastResult);
        return json(res, 200, ptoLogic.applyPtoCapacityLimits(forecastResult, request, ctx));
      }
      const input = {
        employeeEmail: identity,
        startDate: parsed.searchParams.get('startDate'),
        endDate: parsed.searchParams.get('endDate'),
        requestType: parsed.searchParams.get('requestType') || 'FULL_DAY',
        partialStartTime: parsed.searchParams.get('partialStartTime') || null,
        partialEndTime: parsed.searchParams.get('partialEndTime') || null,
        kpiType: parsed.searchParams.get('kpiType') || ''
      };
      const employee = (roster.records || []).find(x => ptoLogic.cleanEmail(x.employeeEmail) === input.employeeEmail);
      if (!employee) return json(res, 400, { ok: false, error: 'Employee must exist in the roster.' });
      if (!ptoLogic.validDate(input.startDate) || !ptoLogic.validDate(input.endDate) || input.startDate > input.endDate) return json(res, 400, { ok: false, error: 'A valid PTO date range is required for the forecast.' });
      const calculation = ptoLogic.calculatePtoWorkdays(input, schedules);
      const scheduleMissing = calculation.missingScheduleDates.length > 0;
      // Missing schedule is a warning (buildPtoForecast reports SCHEDULE_MISSING below), never a 409.
      if (!scheduleMissing && !calculation.workDates.length) return json(res, 409, { ok: false, error: 'The requested dates are all scheduled rest days.', rdDates: calculation.rdDates });
      const workDates = scheduleMissing ? ptoLogic.dateRange(input.startDate, input.endDate) : calculation.workDates;
      Object.assign(input, { employeeName: employee.employeeName, kpiType: employee.kpiType, primaryChannel: employee.primaryChannel, teamLeadName: employee.teamLeadName, workDates });
      const forecastResult = ptoLogic.buildPtoForecast(input, ctx);
      forecastResult.rdDates = calculation.rdDates || [];
      forecastResult.requestedWorkdays = workDates.length;
      if (forecastResult.forecastStatus === 'SCHEDULE_MISSING') return json(res, 200, forecastResult);
      return json(res, 200, ptoLogic.applyPtoCapacityLimits(forecastResult, input, ctx));
    }

    if (parsed.pathname === '/api/pto/conflicts' && req.method === 'GET') {
      const data = await loadPto();
      const candidate = { employeeEmail: identity, startDate: parsed.searchParams.get('startDate'), endDate: parsed.searchParams.get('endDate') };
      const excludeId = parsed.searchParams.get('excludeId') || '';
      return json(res, 200, { ok: true, conflicts: ptoLogic.ptoConflictsFor(candidate, data.requests || [], excludeId), lastUpdated: data.lastUpdated || '' });
    }

    if (parsed.pathname === '/api/pto/audit' && req.method === 'GET') {
      const requestId = parsed.searchParams.get('requestId');
      const [pto, audit] = await Promise.all([loadPto(), loadAudit()]);
      const ownRequestIds = new Set((pto.requests || []).filter(x => ptoLogic.cleanEmail(x.employeeEmail) === identity).map(x => x.requestId));
      const events = (audit.events || []).filter(x => ownRequestIds.has(x.requestId) && (!requestId || x.requestId === requestId));
      return json(res, 200, { ok: true, events, lastUpdated: audit.lastUpdated || '', dataStatus: 'Live' });
    }

    const ptoRequestMatch = parsed.pathname.match(/^\/api\/pto\/requests\/([^/]+)(?:\/(submit|pre-approve|final-approve|approve|partial-approve|decline|withdraw|cancel|return))?$/);
    if (ptoRequestMatch) {
      const requestId = decodeURIComponent(ptoRequestMatch[1]);
      const action = ptoRequestMatch[2] || '';
      const data = await loadPto();
      const index = (data.requests || []).findIndex(x => x.requestId === requestId);
      if (index < 0) return json(res, 404, { ok: false, error: 'PTO request not found.' });
      const current = data.requests[index];

      if (req.method === 'GET' && !action) {
        if (ptoLogic.cleanEmail(current.employeeEmail) !== identity) {
          const access = await ptoReviewAccess(identity, session.employeeName);
          if (!canReviewPtoRequest(access, current)) return json(res, 403, { ok: false, error: 'You can only view your own PTO requests or requests assigned to you for review.' });
        }
        return json(res, 200, { ok: true, request: current, lastUpdated: data.lastUpdated || '', dataStatus: 'Live' });
      }

      if (['pre-approve', 'final-approve'].includes(action)) {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'Method not allowed.' });
        const access = await ptoReviewAccess(identity, session.employeeName);
        const body = await readJsonBody(req);
        const now = new Date().toISOString();
        const notes = String(body.approverNotes || '').trim();

        if (action === 'pre-approve') {
          if (!access.memberEmails.has(ptoLogic.cleanEmail(current.employeeEmail))) return json(res, 403, { ok: false, error: 'Only the employee’s assigned team leader can pre-approve this request.' });
          if (!['SUBMITTED', 'PENDING'].includes(current.status)) return json(res, 409, { ok: false, error: 'Only a submitted or pending request can be pre-approved.' });
          const next = {
            ...current,
            status: 'PRE_APPROVED',
            preApproverEmail: identity,
            preApproverName: session.employeeName,
            preApproverNotes: notes,
            preApprovalDate: now.slice(0, 10),
            preApprovedAt: now,
            updatedAt: now
          };
          data.requests[index] = next;
          await savePto(data);
          await appendAudit(requestId, 'PRE_APPROVED', { user: identity, previousValue: current.status, newValue: 'PRE_APPROVED', notes });
          return json(res, 200, { ok: true, request: next, lastUpdated: data.lastUpdated });
        }

        if (!access.canFinalApprove) return json(res, 403, { ok: false, error: 'Final approval on the public portal is restricted to Charlotte Sanchez.' });
        if (ptoLogic.cleanEmail(current.employeeEmail) === identity) return json(res, 403, { ok: false, error: 'Final approvers cannot approve their own PTO request.' });
        if (!['SUBMITTED', 'PENDING', 'PRE_APPROVED'].includes(current.status)) return json(res, 409, { ok: false, error: 'This request is not awaiting final approval.' });
        const finalApproverIsDirectLeader = ptoLogic.cleanEmail(current.teamLeadEmail) === identity ||
          String(current.teamLeadName || '').trim().toLowerCase() === 'charlotte sanchez';
        if (current.status !== 'PRE_APPROVED' && !finalApproverIsDirectLeader) return json(res, 409, { ok: false, error: 'The assigned team leader must pre-approve this request before final approval.' });
        const [settings, roster, schedules, attendance] = await Promise.all([loadSettings(), loadRosterSnapshot(), loadScheduleSnapshot(), loadAttendanceSnapshot()]);
        const ctx = { pto: data, settings, roster: roster.records || [], schedules, attendance };
        const baseForecast = ptoLogic.buildPtoForecast({ requestId }, ctx);
        if (baseForecast.forecastStatus === 'SCHEDULE_MISSING') return json(res, 409, { ok: false, error: 'Final approval cannot be queued until the employee schedule exists.', forecast: baseForecast });
        const forecast = ptoLogic.applyPtoCapacityLimits(baseForecast, current, ctx);
        const warnings = [
          ...(forecast.dates || []).filter(x => ['Warning', 'Critical', 'Below Minimum'].includes(x.status)).map(x => `${x.date}: ${x.status}`),
          ...(forecast.staffingWarnings || [])
        ];
        if (warnings.length && !notes) return json(res, 400, { ok: false, error: 'Final approver notes are required when staffing warnings are present.', warnings });
        const next = {
          ...current,
          status: 'FINAL_APPROVAL_QUEUED',
          approvedDates: [...(current.workDates || [])],
          finalApproverEmail: identity,
          finalApproverName: session.employeeName,
          finalApproverNotes: notes,
          finalApprovalRequestedAt: now,
          integrationStatus: 'Queued for local admin integration',
          updatedAt: now
        };
        data.requests[index] = next;
        await savePto(data);
        await appendAudit(requestId, 'FINAL_APPROVAL_QUEUED', { user: identity, previousValue: current.status, newValue: 'FINAL_APPROVAL_QUEUED', notes });
        return json(res, 202, { ok: true, request: next, forecast, lastUpdated: data.lastUpdated });
      }

      if (['approve', 'partial-approve', 'decline', 'cancel', 'return'].includes(action)) {
        return json(res, 403, { ok: false, error: 'Approvals and declines are handled on the internal dashboard, not the public PTO link.' });
      }

      if (ptoLogic.cleanEmail(current.employeeEmail) !== identity) return json(res, 403, { ok: false, error: 'You can only edit your own PTO requests.' });
      if (mustChangePassword) return json(res, 403, { ok: false, error: 'Please change your temporary password before editing a request.' });

      const body = await readJsonBody(req);
      const now = new Date().toISOString();
      const user = identity;

      if (req.method === 'PUT' && !action) {
        if (['APPROVED', 'PARTIALLY_APPROVED'].includes(current.status)) return json(res, 403, { ok: false, error: 'Approved requests can only be revised on the internal dashboard.' });
        body.employeeEmail = identity;
        const [roster, schedules] = await Promise.all([loadRosterSnapshot(), loadScheduleSnapshot()]);
        const next = ptoLogic.normalizePtoRequest(body, { roster: roster.records || [], schedules }, current);
        const conflicts = ptoLogic.ptoConflictsFor(next, data.requests, requestId);
        if (conflicts.length) return json(res, 409, { ok: false, error: 'The revision overlaps another active PTO request.', conflicts });
        next.revisions = [...(current.revisions || []), { revisionId: `${requestId}-R${(current.revisions || []).length + 1}`, timestamp: now, user, previousValue: current, notes: String(body.revisionReason || 'Request edited.') }];
        data.requests[index] = next;
        await savePto(data);
        await appendAudit(requestId, 'REQUEST_EDITED', { user, previousValue: current, newValue: next, notes: body.revisionReason });
        return json(res, 200, { ok: true, request: next, lastUpdated: data.lastUpdated });
      }

      if (req.method !== 'POST' || !action) return json(res, 405, { ok: false, error: 'Method not allowed.' });

      if (action === 'submit') {
        if (!['DRAFT', 'SUBMITTED'].includes(current.status)) return json(res, 409, { ok: false, error: 'Only a draft request can be submitted.' });
        const [roster, schedules] = await Promise.all([loadRosterSnapshot(), loadScheduleSnapshot()]);
        const normalized = ptoLogic.normalizePtoRequest(current, { roster: roster.records || [], schedules }, current);
        const conflicts = ptoLogic.ptoConflictsFor(normalized, data.requests, requestId);
        if (conflicts.length) return json(res, 409, { ok: false, error: 'The request overlaps another active PTO request.', conflicts });
        data.requests[index] = { ...normalized, status: 'PENDING', submittedAt: now, updatedAt: now };
        await savePto(data);
        await appendAudit(requestId, 'REQUEST_SUBMITTED', { user, previousValue: current.status, newValue: 'PENDING' });
        return json(res, 200, { ok: true, request: data.requests[index], lastUpdated: data.lastUpdated });
      }

      if (action === 'withdraw') {
        if (!['DRAFT', 'SUBMITTED', 'PENDING', 'PRE_APPROVED'].includes(current.status)) return json(res, 409, { ok: false, error: 'Only a draft, pending, or pre-approved request can be withdrawn.' });
        data.requests[index] = { ...current, status: 'WITHDRAWN', withdrawalReason: String(body.reason || ''), updatedAt: now };
        await savePto(data);
        await appendAudit(requestId, 'WITHDRAWN', { user, previousValue: current.status, newValue: 'WITHDRAWN', notes: body.reason });
        return json(res, 200, { ok: true, request: data.requests[index], lastUpdated: data.lastUpdated });
      }
    }

    // Schedule Requests (Shift Change + Offline Task) - mirrors the PTO request block above.
    if (parsed.pathname === '/api/my/schedule-requests' && req.method === 'GET') {
      const data = await loadScheduleRequests();
      const status = String(parsed.searchParams.get('status') || '');
      const requests = (data.requests || []).filter(x => ptoLogic.cleanEmail(x.employeeEmail) === identity && (!status || x.status === status));
      return json(res, 200, { ok: true, requests, lastUpdated: data.lastUpdated || '', dataStatus: 'Live' });
    }

    if (parsed.pathname === '/api/my/schedule-requests' && req.method === 'POST') {
      if (mustChangePassword) return json(res, 403, { ok: false, error: 'Please change your temporary password before filing a request.' });
      const body = await readJsonBody(req);
      body.employeeEmail = identity;
      const [roster, data] = await Promise.all([loadRosterSnapshot(), loadScheduleRequests()]);
      const normalized = normalizeScheduleRequestBody(body, roster.records || []);
      const conflicts = scheduleRequestConflicts(normalized, data.requests || []);
      if (conflicts.length) return json(res, 409, { ok: false, error: 'This request overlaps an existing active schedule request for this date.', conflicts });
      const year = normalized.date.slice(0, 4);
      const sequence = (data.sequenceByYear[year] || 0) + 1;
      const requestId = `SCHEDREQ-${year}-${String(sequence).padStart(4, '0')}`;
      const now = new Date().toISOString();
      const request = { ...normalized, requestId, status: body.status === 'SUBMITTED' ? 'SUBMITTED' : 'DRAFT', approverEmail: null, approverName: '', approverNotes: '', decisionDate: null, integrationStatus: 'Not Applied', createdAt: now, updatedAt: now };
      data.sequenceByYear[year] = sequence;
      data.requests.push(request);
      await saveScheduleRequests(data);
      await appendScheduleRequestAudit(requestId, request.status === 'DRAFT' ? 'REQUEST_CREATED' : 'REQUEST_SUBMITTED', { user: identity, newValue: request, notes: request.reason });
      return json(res, 201, { ok: true, request, lastUpdated: data.lastUpdated });
    }

    const scheduleRequestMatch = parsed.pathname.match(/^\/api\/my\/schedule-requests\/([^/]+)(?:\/(submit|approve|decline|withdraw|cancel))?$/);
    if (scheduleRequestMatch) {
      const requestId = decodeURIComponent(scheduleRequestMatch[1]);
      const action = scheduleRequestMatch[2] || '';
      const data = await loadScheduleRequests();
      const index = (data.requests || []).findIndex(x => x.requestId === requestId);
      if (index < 0) return json(res, 404, { ok: false, error: 'Schedule request not found.' });
      const current = data.requests[index];

      if (req.method === 'GET' && !action) {
        if (ptoLogic.cleanEmail(current.employeeEmail) !== identity) return json(res, 403, { ok: false, error: 'You can only view your own schedule requests.' });
        return json(res, 200, { ok: true, request: current, lastUpdated: data.lastUpdated || '', dataStatus: 'Live' });
      }

      if (['approve', 'decline', 'cancel'].includes(action)) {
        return json(res, 403, { ok: false, error: 'Approvals and declines are handled on the internal dashboard, not the public PTO link.' });
      }

      if (ptoLogic.cleanEmail(current.employeeEmail) !== identity) return json(res, 403, { ok: false, error: 'You can only edit your own schedule requests.' });
      if (mustChangePassword) return json(res, 403, { ok: false, error: 'Please change your temporary password before editing a request.' });

      const body = await readJsonBody(req);
      const now = new Date().toISOString();
      const user = identity;

      if (req.method === 'PUT' && !action) {
        if (current.status === 'APPROVED') return json(res, 403, { ok: false, error: 'Approved requests can only be revised on the internal dashboard.' });
        body.employeeEmail = identity;
        const roster = await loadRosterSnapshot();
        const next = normalizeScheduleRequestBody(body, roster.records || [], current);
        const conflicts = scheduleRequestConflicts(next, data.requests, requestId);
        if (conflicts.length) return json(res, 409, { ok: false, error: 'The revision overlaps another active schedule request for this date.', conflicts });
        data.requests[index] = next;
        await saveScheduleRequests(data);
        await appendScheduleRequestAudit(requestId, 'REQUEST_EDITED', { user, previousValue: current, newValue: next, notes: body.revisionReason });
        return json(res, 200, { ok: true, request: next, lastUpdated: data.lastUpdated });
      }

      if (req.method !== 'POST' || !action) return json(res, 405, { ok: false, error: 'Method not allowed.' });

      if (action === 'submit') {
        if (!['DRAFT', 'SUBMITTED'].includes(current.status)) return json(res, 409, { ok: false, error: 'Only a draft request can be submitted.' });
        const conflicts = scheduleRequestConflicts(current, data.requests, requestId);
        if (conflicts.length) return json(res, 409, { ok: false, error: 'The request overlaps another active schedule request for this date.', conflicts });
        data.requests[index] = { ...current, status: 'PENDING', submittedAt: now, updatedAt: now };
        await saveScheduleRequests(data);
        await appendScheduleRequestAudit(requestId, 'REQUEST_SUBMITTED', { user, previousValue: current.status, newValue: 'PENDING' });
        return json(res, 200, { ok: true, request: data.requests[index], lastUpdated: data.lastUpdated });
      }

      if (action === 'withdraw') {
        if (!['DRAFT', 'SUBMITTED', 'PENDING'].includes(current.status)) return json(res, 409, { ok: false, error: 'Only a draft or pending request can be withdrawn.' });
        data.requests[index] = { ...current, status: 'WITHDRAWN', withdrawalReason: String(body.reason || ''), updatedAt: now };
        await saveScheduleRequests(data);
        await appendScheduleRequestAudit(requestId, 'WITHDRAWN', { user, previousValue: current.status, newValue: 'WITHDRAWN', notes: body.reason });
        return json(res, 200, { ok: true, request: data.requests[index], lastUpdated: data.lastUpdated });
      }
    }

    // ---------- Points & Rewards ----------
    // Points are always computed fresh from data this app already owns (CSAT good ratings, KPI
    // tier, attendance, Alignment quiz results) rather than kept as a running counter - a
    // separate ledger for "earned" would eventually drift from the source data it's supposed to
    // reflect. Only "spent" (redemptions) is a real ledger, since a redemption is an actual
    // event with no other record of it. Redeemable balance = all-time earned minus approved
    // spend; the leaderboard ranks by a single month's earnings so it stays fresh.
    if (parsed.pathname === '/api/points/leaderboard' && req.method === 'GET') {
      const requestedMonth = String(parsed.searchParams.get('month') || '');
      const points = await computeAllPoints();
      const month = points.months.includes(requestedMonth) ? requestedMonth : (points.months[points.months.length - 1] || '');
      const leaderboard = Object.entries(points.byEmployee)
        .map(([email, p]) => ({ employeeEmail: email, employeeName: p.employeeName, month: p.byMonth[month]?.total || 0, breakdown: p.byMonth[month] || null, allTime: p.allTime.total }))
        .filter(x => x.month > 0 || x.allTime > 0)
        .sort((a, b) => b.month - a.month);
      const redemptions = await cloudStore.kvGetJson(REWARD_REDEMPTIONS_KEY, []);
      const spent = redemptions.filter(r => ptoLogic.cleanEmail(r.employeeEmail) === identity && r.status === 'APPROVED').reduce((sum, r) => sum + r.pointCost, 0);
      const myEarned = points.byEmployee[identity]?.allTime.total || 0;
      return json(res, 200, { ok: true, month, availableMonths: points.months, leaderboard, myBalance: { earned: myEarned, spent, balance: myEarned - spent } });
    }

    if (parsed.pathname === '/api/rewards/catalog' && req.method === 'GET') {
      const catalog = await cloudStore.kvGetJson(REWARD_CATALOG_KEY, []);
      // A PENDING or APPROVED redemption both hold a unit of stock - only REJECTED gives it
      // back, since that's the only outcome where the reward was never actually granted.
      const redemptions = await cloudStore.kvGetJson(REWARD_REDEMPTIONS_KEY, []);
      const claimedByReward = new Map();
      for (const r of redemptions) {
        if (r.status === 'REJECTED') continue;
        claimedByReward.set(r.rewardId, (claimedByReward.get(r.rewardId) || 0) + 1);
      }
      const items = catalog.filter(x => x.active !== false).map(x => {
        const claimed = claimedByReward.get(x.id) || 0;
        const remaining = x.stockLimit == null ? null : Math.max(0, x.stockLimit - claimed);
        return { ...x, claimed, remaining };
      });
      return json(res, 200, { ok: true, items, canManage: canManageRewards(identity) });
    }
    if (parsed.pathname === '/api/rewards/catalog' && req.method === 'POST') {
      if (!canManageRewards(identity)) return json(res, 403, { ok: false, error: 'Not authorized to manage the rewards catalog.' });
      const body = await readJsonBody(req);
      const name = String(body.name || '').trim();
      const description = String(body.description || '').trim();
      const pointCost = Math.round(Number(body.pointCost));
      const imageBase64 = String(body.imageBase64 || '');
      // Blank/null means unlimited stock - only coerce to a number when the field was actually filled in.
      const stockLimit = body.stockLimit === '' || body.stockLimit == null ? null : Math.round(Number(body.stockLimit));
      if (!name) return json(res, 400, { ok: false, error: 'A reward name is required.' });
      if (!Number.isFinite(pointCost) || pointCost <= 0) return json(res, 400, { ok: false, error: 'Point cost must be a positive number.' });
      if (stockLimit != null && (!Number.isFinite(stockLimit) || stockLimit < 0)) return json(res, 400, { ok: false, error: 'Stock limit must be a non-negative number, or left blank for unlimited.' });
      if (imageBase64 && !/^data:image\/(jpeg|png|webp);base64,/.test(imageBase64)) return json(res, 400, { ok: false, error: 'A valid image is required.' });
      if (imageBase64.length > MAX_REWARD_IMAGE_BASE64_LENGTH) return json(res, 400, { ok: false, error: 'Photo is too large.' });
      const catalog = await cloudStore.kvGetJson(REWARD_CATALOG_KEY, []);
      const item = { id: `REWARD-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`, name, description, pointCost, stockLimit, imageBase64, active: true, createdBy: identity, createdAt: new Date().toISOString() };
      catalog.push(item);
      await cloudStore.kvSetJson(REWARD_CATALOG_KEY, catalog);
      return json(res, 201, { ok: true, item });
    }
    const catalogItemMatch = parsed.pathname.match(/^\/api\/rewards\/catalog\/([^/]+)$/);
    if (catalogItemMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
      if (!canManageRewards(identity)) return json(res, 403, { ok: false, error: 'Not authorized to manage the rewards catalog.' });
      const catalog = await cloudStore.kvGetJson(REWARD_CATALOG_KEY, []);
      const index = catalog.findIndex(x => x.id === catalogItemMatch[1]);
      if (index < 0) return json(res, 404, { ok: false, error: 'Reward not found.' });
      if (req.method === 'DELETE') {
        // Soft-delete: a past redemption may still reference this item by id, and its history
        // should keep showing what was actually redeemed rather than a broken lookup.
        catalog[index] = { ...catalog[index], active: false };
        await cloudStore.kvSetJson(REWARD_CATALOG_KEY, catalog);
        return json(res, 200, { ok: true });
      }
      const body = await readJsonBody(req);
      const name = String(body.name || '').trim();
      const description = String(body.description || '').trim();
      const pointCost = Math.round(Number(body.pointCost));
      const stockLimit = body.stockLimit === '' || body.stockLimit == null ? null : Math.round(Number(body.stockLimit));
      // Present-but-empty means "remove the photo"; absent entirely means "leave it as is" -
      // the client always sends one or the other, never omits the key.
      const imageBase64 = body.imageBase64 === undefined ? catalog[index].imageBase64 || '' : String(body.imageBase64 || '');
      if (!name) return json(res, 400, { ok: false, error: 'A reward name is required.' });
      if (!Number.isFinite(pointCost) || pointCost <= 0) return json(res, 400, { ok: false, error: 'Point cost must be a positive number.' });
      if (stockLimit != null && (!Number.isFinite(stockLimit) || stockLimit < 0)) return json(res, 400, { ok: false, error: 'Stock limit must be a non-negative number, or left blank for unlimited.' });
      if (imageBase64 && !/^data:image\/(jpeg|png|webp);base64,/.test(imageBase64)) return json(res, 400, { ok: false, error: 'A valid image is required.' });
      if (imageBase64.length > MAX_REWARD_IMAGE_BASE64_LENGTH) return json(res, 400, { ok: false, error: 'Photo is too large.' });
      catalog[index] = { ...catalog[index], name, description, pointCost, stockLimit, imageBase64 };
      await cloudStore.kvSetJson(REWARD_CATALOG_KEY, catalog);
      return json(res, 200, { ok: true, item: catalog[index] });
    }

    if (parsed.pathname === '/api/rewards/redeem' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const rewardId = String(body.rewardId || '').trim();
      const catalog = await cloudStore.kvGetJson(REWARD_CATALOG_KEY, []);
      const reward = catalog.find(x => x.id === rewardId && x.active !== false);
      if (!reward) return json(res, 404, { ok: false, error: 'That reward is no longer available.' });
      const points = await computeAllPoints();
      const redemptions = await cloudStore.kvGetJson(REWARD_REDEMPTIONS_KEY, []);
      const spent = redemptions.filter(r => ptoLogic.cleanEmail(r.employeeEmail) === identity && r.status === 'APPROVED').reduce((sum, r) => sum + r.pointCost, 0);
      const balance = (points.byEmployee[identity]?.allTime.total || 0) - spent;
      if (balance < reward.pointCost) return json(res, 400, { ok: false, error: `Not enough points - you have ${balance}, this costs ${reward.pointCost}.` });
      if (reward.stockLimit != null) {
        const claimed = redemptions.filter(r => r.rewardId === reward.id && r.status !== 'REJECTED').length;
        if (claimed >= reward.stockLimit) return json(res, 400, { ok: false, error: 'This reward is out of stock.' });
      }
      const redemption = { id: `REDEEM-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`, employeeEmail: identity, employeeName: session.employeeName, rewardId: reward.id, rewardName: reward.name, pointCost: reward.pointCost, status: 'PENDING', requestedAt: new Date().toISOString(), decidedAt: null, decidedBy: '', decisionNotes: '' };
      redemptions.push(redemption);
      await cloudStore.kvSetJson(REWARD_REDEMPTIONS_KEY, redemptions);
      return json(res, 201, { ok: true, redemption });
    }
    if (parsed.pathname === '/api/rewards/my-redemptions' && req.method === 'GET') {
      const redemptions = await cloudStore.kvGetJson(REWARD_REDEMPTIONS_KEY, []);
      const mine = redemptions.filter(r => ptoLogic.cleanEmail(r.employeeEmail) === identity).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
      return json(res, 200, { ok: true, redemptions: mine });
    }
    if (parsed.pathname === '/api/rewards/redemptions' && req.method === 'GET') {
      if (!canManageRewards(identity)) return json(res, 403, { ok: false, error: 'Not authorized.' });
      const redemptions = await cloudStore.kvGetJson(REWARD_REDEMPTIONS_KEY, []);
      return json(res, 200, { ok: true, redemptions: [...redemptions].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)) });
    }
    const redemptionDecideMatch = parsed.pathname.match(/^\/api\/rewards\/redemptions\/([^/]+)\/decide$/);
    if (redemptionDecideMatch && req.method === 'POST') {
      if (!canManageRewards(identity)) return json(res, 403, { ok: false, error: 'Not authorized.' });
      const body = await readJsonBody(req);
      const decision = String(body.decision || '').toUpperCase();
      if (!['APPROVED', 'REJECTED'].includes(decision)) return json(res, 400, { ok: false, error: 'A valid decision (APPROVED or REJECTED) is required.' });
      const redemptions = await cloudStore.kvGetJson(REWARD_REDEMPTIONS_KEY, []);
      const index = redemptions.findIndex(x => x.id === redemptionDecideMatch[1]);
      if (index < 0) return json(res, 404, { ok: false, error: 'Redemption not found.' });
      if (redemptions[index].status !== 'PENDING') return json(res, 409, { ok: false, error: `This redemption has already been ${redemptions[index].status.toLowerCase()}.` });
      redemptions[index] = { ...redemptions[index], status: decision, decidedAt: new Date().toISOString(), decidedBy: session.employeeName, decisionNotes: String(body.notes || '').trim() };
      await cloudStore.kvSetJson(REWARD_REDEMPTIONS_KEY, redemptions);
      return json(res, 200, { ok: true, redemption: redemptions[index] });
    }

    return json(res, 404, { ok: false, error: 'Not found' });
  } catch (err) {
    // Upstash outages (rate limit exhausted, connectivity, etc.) surface as a plain Error
    // whose message is prefixed "Upstash..." by kv-store.js - never show that raw
    // infra-level text to an end user (it's confusing and leaks internal details).
    // Instead, flag it distinctly so the client can render a clean maintenance state.
    if (String(err.message || '').startsWith('Upstash')) {
      console.error('[outage]', err.message);
      return json(res, 503, { ok: false, error: 'The portal is temporarily unavailable for maintenance. Please try again in a few minutes.', maintenance: true });
    }
    return json(res, err.statusCode || 500, { ok: false, error: err.message });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Public PTO server running on port ${PORT}`);
    console.log(`Reps sign in individually at: https://<your-render-host>/pto`);
    if (!ADMIN_KEY) console.log('Note: PTO_ADMIN_KEY is not set - the admin credential-reset endpoint will refuse all requests until it is configured.');
  });
}

module.exports = { server };
