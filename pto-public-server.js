'use strict';
/*
  Standalone public PTO server for reps.

  Deliberately separate from zendesk-proxy.js: this process only ever exposes
  PTO request filing/status plus the minimal read-only roster/schedule data
  needed to calculate conflicts and staffing forecasts. It never touches
  Zendesk credentials, the roster/schedule/attendance WRITE endpoints, KPI
  results, or any of the internal monitoring dashboards.

  Approvals/declines/threshold settings stay on the local admin dashboard
  (zendesk-proxy.js) - this server only allows: list/create/edit-draft/submit/
  withdraw, and only ever as the signed-in rep themselves.

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
*/

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cloudStore = require('./server/kv-store.js');
const ptoLogic = require('./server/pto-logic.js');
const ptoPassword = require('./server/password.js');

const PORT = Number(process.env.PORT || 3050);
const ADMIN_KEY = process.env.PTO_ADMIN_KEY || '';
const ROSTER_CONTACT_FIELDS = ['contactNumber','contactEmail','emergencyContactName','emergencyContactRelationship','emergencyContactNumber','currentResidence'];
const SESSION_COOKIE_NAME = 'pto_session';
const SESSION_TTL_SECONDS = 14 * 24 * 60 * 60; // 14 days
const MTD_ROOT = __dirname;
const SNAPSHOT_MAX_AGE_MS = Number(process.env.PTO_SNAPSHOT_CACHE_MS || 15000);
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS = 10 * 60 * 1000; // 10 minutes

if (!cloudStore.isConfigured()) {
  console.error('Missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN. The public PTO server has nowhere to store data - refusing to start.');
  process.exit(1);
}

const STATIC_SHARED = new Set(['ui-utils.js', 'date-utils.js', 'kpi-config.js', 'roster-service.js', 'pto-service.js', 'auth-service.js', 'my-data-service.js', 'loading-status.js', 'loading-status.css', 'kpi.css']);
const STATIC_SHARED_BINARY = new Set(['img/lofty-logo.png']);

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

// --- Cloud data access (with a short-lived cache on the read-only snapshots) ---
const PTO_KEY = 'mtdkpi:pto-requests';
const AUDIT_KEY = 'mtdkpi:pto-audit';
const SETTINGS_KEY = 'mtdkpi:pto-settings';
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
async function loadScheduleSnapshot() { return getSnapshot('schedules', 'mtdkpi:snapshot:schedules', { schedules: [], overrides: [] }); }
async function loadAttendanceSnapshot() { return getSnapshot('attendance', 'mtdkpi:snapshot:attendance', { periods: {}, autoEntries: {} }); }
async function loadKpiResultsSnapshot() { return getSnapshot('kpi-results', 'mtdkpi:snapshot:kpi-results', { periods: {} }); }

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

// --- Rep accounts (credentials + sessions) ---
function credentialKey(email) { return CREDENTIAL_KEY_PREFIX + ptoLogic.cleanEmail(email); }
function sessionKey(token) { return SESSION_KEY_PREFIX + token; }

async function loadCredential(email) { return cloudStore.kvGetJson(credentialKey(email), null); }
async function saveCredential(record) { await cloudStore.kvSetJson(credentialKey(record.employeeEmail), record); }

async function createSession(employeeEmail, employeeName) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const record = { employeeEmail, employeeName, issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + SESSION_TTL_SECONDS * 1000).toISOString() };
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
      const token = await createSession(credential.employeeEmail, credential.employeeName);
      credential.lastLoginAt = new Date().toISOString();
      await saveCredential(credential);
      res.setHeader('Set-Cookie', sessionCookieHeader(token, isSecureReq));
      return json(res, 200, { ok: true, employeeEmail: credential.employeeEmail, employeeName: credential.employeeName, mustChangePassword: Boolean(credential.mustChangePassword) });
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
        mustChangePassword: true,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
        lastLoginAt: existing?.lastLoginAt || null
      };
      await saveCredential(record);
      return json(res, 200, { ok: true, employeeEmail: email });
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
    const mustChangePassword = Boolean(credential?.mustChangePassword);

    if (parsed.pathname === '/api/auth/session' && req.method === 'GET') {
      return json(res, 200, { ok: true, authenticated: true, employeeEmail: session.employeeEmail, employeeName: session.employeeName, mustChangePassword });
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
      credential.updatedAt = new Date().toISOString();
      await saveCredential(credential);
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

    if (parsed.pathname === '/api/my/kpi' && req.method === 'GET') {
      const kpiResults = await loadKpiResultsSnapshot();
      const periods = kpiResults.periods || {};
      const results = Object.entries(periods)
        .flatMap(([period, rows]) => (rows || []).filter(x => ptoLogic.cleanEmail(x.employeeEmail) === identity).map(x => ({ period, ...x })))
        .sort((a, b) => b.period.localeCompare(a.period));
      return json(res, 200, { ok: true, results });
    }

    if (parsed.pathname === '/api/my/schedule' && req.method === 'GET') {
      const schedules = await loadScheduleSnapshot();
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
          overnight: Boolean(t?.overnight)
        };
      });
      return json(res, 200, { ok: true, days });
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
        if (ptoLogic.cleanEmail(request.employeeEmail) !== identity) return json(res, 403, { ok: false, error: 'You can only view the forecast for your own requests.' });
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

    const ptoRequestMatch = parsed.pathname.match(/^\/api\/pto\/requests\/([^/]+)(?:\/(submit|approve|partial-approve|decline|withdraw|cancel|return))?$/);
    if (ptoRequestMatch) {
      const requestId = decodeURIComponent(ptoRequestMatch[1]);
      const action = ptoRequestMatch[2] || '';
      const data = await loadPto();
      const index = (data.requests || []).findIndex(x => x.requestId === requestId);
      if (index < 0) return json(res, 404, { ok: false, error: 'PTO request not found.' });
      const current = data.requests[index];

      if (req.method === 'GET' && !action) {
        if (ptoLogic.cleanEmail(current.employeeEmail) !== identity) return json(res, 403, { ok: false, error: 'You can only view your own PTO requests.' });
        return json(res, 200, { ok: true, request: current, lastUpdated: data.lastUpdated || '', dataStatus: 'Live' });
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
        if (!['DRAFT', 'SUBMITTED', 'PENDING'].includes(current.status)) return json(res, 409, { ok: false, error: 'Only a draft or pending request can be withdrawn.' });
        data.requests[index] = { ...current, status: 'WITHDRAWN', withdrawalReason: String(body.reason || ''), updatedAt: now };
        await savePto(data);
        await appendAudit(requestId, 'WITHDRAWN', { user, previousValue: current.status, newValue: 'WITHDRAWN', notes: body.reason });
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
