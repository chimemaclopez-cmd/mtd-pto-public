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
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cloudStore = require('./server/kv-store.js');
const ptoLogic = require('./server/pto-logic.js');
const ptoPassword = require('./server/password.js');
const emailService = require('./server/email-service.js');

const PORT = Number(process.env.PORT || 3050);
const ADMIN_KEY = process.env.PTO_ADMIN_KEY || '';
const STATUS_WALL_KEY = process.env.STATUS_WALL_KEY || '';
const STATUS_WALL_COOKIE_NAME = 'status_wall_key';
const ROSTER_CONTACT_FIELDS = ['contactNumber','contactEmail','emergencyContactName','emergencyContactRelationship','emergencyContactNumber','currentResidence'];
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

const STATIC_SHARED = new Set(['ui-utils.js', 'date-utils.js', 'kpi-config.js', 'roster-service.js', 'pto-service.js', 'auth-service.js', 'my-data-service.js', 'chat-service.js', 'announcement-service.js', 'phone-utils.js', 'csat-dispute-service.js', 'schedule-request-service.js', 'activity-config.js', 'loading-status.js', 'loading-status.css', 'kpi.css']);
const STATIC_SHARED_BINARY = new Set(['img/lofty-logo.png', 'img/icon-192.png', 'img/icon-512.png', 'img/icon-512-maskable.png', 'img/apple-touch-icon.png']);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
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
  const roster = (await loadRosterSnapshot()).records.filter(x => x.active && ['Voice Jr TSR', 'Non-Voice Jr TSR', 'Senior TSR'].includes(x.kpiType));
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
      sinceIso = signal.callStartedAt || signal.availabilityUpdatedAt || entry?.updatedAt || entry?.clockedInAt || null;
    } else if (liveOnChat) {
      statusLabel = 'On Chat';
      statusCode = 'ON_CHAT';
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
  return 'CALL';
}
async function loadScheduleSnapshot() { return getSnapshot('schedules', 'mtdkpi:snapshot:schedules', { schedules: [], overrides: [] }); }
async function loadAttendanceSnapshot() { return getSnapshot('attendance', 'mtdkpi:snapshot:attendance', { periods: {}, autoEntries: {} }); }
async function loadKpiResultsSnapshot() { return getSnapshot('kpi-results', 'mtdkpi:snapshot:kpi-results', { periods: {} }); }
async function loadAnnouncementsSnapshot() { return getSnapshot('announcements', 'mtdkpi:snapshot:announcements', { announcements: [] }); }
async function loadStatusSignalsSnapshot() { return getSnapshot('status-signals', 'mtdkpi:snapshot:status-signals', { generatedAt: '', byEmail: {}, warnings: [] }); }

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

// --- Rep self-reported status (Online/Break/Lunch/Offline Task) - a live "what am I doing right
// now" flag reps set themselves, separate from the schedule. Admins compare it against the
// resolved schedule and the live Zendesk signal on the Schedule Adherence dashboard.
async function loadRepStatus() { return cloudStore.kvGetJson(REP_STATUS_KEY, { version: 1, statuses: {} }); }
async function saveRepStatus(data) { data.lastUpdated = new Date().toISOString(); await cloudStore.kvSetJson(REP_STATUS_KEY, data); return data;
}
const PLANNED_OFFLINE_ACTIVITY_IDS = ['COACHING','TRAINING','TEAM_HUDDLE','ONE_ON_ONE','QA_REVIEW','MEETING','CALIBRATION','SIDE_BY_SIDE','PROJECT_WORK','ADMIN','DOCUMENTATION','CASE_REVIEW','OTHER_OFFLINE'];
function validScheduleTimeSlot(value) { return /^([01]\d|2[0-3]):[03]0$/.test(String(value || '')); }
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
    if (!validScheduleTimeSlot(startTime) || !validScheduleTimeSlot(endTime) || minutesOfSlot(endTime) <= minutesOfSlot(startTime)) throw Object.assign(new Error('A valid start and end time (30-minute increments, end after start) are required.'), { statusCode: 400 });
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
    if (parsed.pathname === '/' || parsed.pathname === '/pto') {
      const filePath = path.join(MTD_ROOT, 'pto-public.html');
      return sendText(res, 200, fs.readFileSync(filePath, 'utf8'), 'text/html; charset=utf-8');
    }

    if (parsed.pathname === '/manifest.json') {
      return sendText(res, 200, fs.readFileSync(path.join(MTD_ROOT, 'manifest.json'), 'utf8'), 'application/json; charset=utf-8');
    }

    if (parsed.pathname === '/sw.js') {
      return sendText(res, 200, fs.readFileSync(path.join(MTD_ROOT, 'sw.js'), 'utf8'), 'text/javascript; charset=utf-8');
    }

    const sharedBinaryMatch = parsed.pathname.match(/^\/shared\/([a-zA-Z0-9._/-]+)$/);
    if (sharedBinaryMatch && STATIC_SHARED_BINARY.has(sharedBinaryMatch[1])) {
      const filePath = path.join(MTD_ROOT, 'shared', sharedBinaryMatch[1]);
      return sendBinary(res, 200, fs.readFileSync(filePath), contentTypeFor(sharedBinaryMatch[1]));
    }

    const sharedMatch = parsed.pathname.match(/^\/shared\/([a-zA-Z0-9._-]+)$/);
    if (sharedMatch && STATIC_SHARED.has(sharedMatch[1])) {
      const filePath = path.join(MTD_ROOT, 'shared', sharedMatch[1]);
      return sendText(res, 200, fs.readFileSync(filePath, 'utf8'), contentTypeFor(sharedMatch[1]));
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
      return json(res, 200, { ok: true, employeeEmail: credential.employeeEmail, employeeName: credential.employeeName, mustChangePassword: Boolean(credential.mustChangePassword), tourSeen: Boolean(credential.tourSeen) });
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
      return json(res, 200, { ok: true, authenticated: true, employeeEmail: session.employeeEmail, employeeName: session.employeeName, mustChangePassword, tourSeen: Boolean(credential?.tourSeen) });
    }

    if (parsed.pathname === '/api/my/tour-complete' && req.method === 'POST') {
      if (credential) { credential.tourSeen = true; await saveCredential(credential); }
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
      const roster = await loadRosterSnapshot();
      const index = (roster.records || []).findIndex(x => ptoLogic.cleanEmail(x.employeeEmail) === identity);
      if (index < 0) return json(res, 400, { ok: false, error: 'Employee not found in the roster.' });
      roster.records[index] = { ...roster.records[index], ...update };
      await cloudStore.kvSetJson('mtdkpi:snapshot:roster', roster);
      snapshotCache.set('mtdkpi:snapshot:roster', { value: roster, at: Date.now() });
      const pending = await cloudStore.kvGetJson('mtdkpi:roster-contact-updates', {});
      pending[identity] = { employeeEmail: identity, ...update, updatedAt: new Date().toISOString() };
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

    if (parsed.pathname === '/api/my/announcements' && req.method === 'GET') {
      const snapshot = await loadAnnouncementsSnapshot();
      const announcements = (snapshot.announcements || [])
        .filter(x => x.active !== false)
        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
      return json(res, 200, { ok: true, announcements });
    }

    if (parsed.pathname === '/api/my/kpi' && req.method === 'GET') {
      const [kpiResults, roster] = await Promise.all([loadKpiResultsSnapshot(), loadRosterSnapshot()]);
      const periods = kpiResults.periods || {};
      const signedInEmployee = (roster.records || []).find(x => ptoLogic.cleanEmail(x.employeeEmail) === identity) || null;
      const results = Object.entries(periods)
        .flatMap(([period, rows]) => (rows || []).filter(x => ptoLogic.cleanEmail(x.employeeEmail) === identity).map(x => ({ period, ...x })))
        .sort((a, b) => b.period.localeCompare(a.period));
      const leaderName=String(signedInEmployee?.employeeName||session.employeeName||'').trim(),leaderEmail=ptoLogic.cleanEmail(signedInEmployee?.employeeEmail||identity);
      const assignedMembers=(roster.records||[]).filter(x=>x.active!==false&&ptoLogic.cleanEmail(x.employeeEmail)!==identity&&(ptoLogic.cleanEmail(x.teamLeadEmail)===leaderEmail||String(x.teamLeadName||'').trim()===leaderName));
      const memberEmails=new Set(assignedMembers.map(x=>ptoLogic.cleanEmail(x.employeeEmail)));
      const latestTeamPeriod=Object.keys(periods).sort((a,b)=>b.localeCompare(a)).find(period=>(periods[period]||[]).some(x=>memberEmails.has(ptoLogic.cleanEmail(x.employeeEmail))))||'';
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
      return json(res,200,{ok:true,results,isTeamLeader:assignedMembers.length>0,teamResults,teamPeriod:latestTeamPeriod,teamAverage,teamLeadName,teamSize,assignedMemberCount:assignedMembers.length});
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
          exactActivities: (!resolved.override && !t?.off && resolved.record?.exactActivities?.[resolved.weekday]) || [],
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

    return json(res, 404, { ok: false, error: 'Not found' });
  } catch (err) {
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
