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
  withdraw. All other PTO actions are rejected here regardless of any
  self-declared "role" in the request body, since role is not authenticated.

  Data lives in Upstash (shared with zendesk-proxy.js's background sync loop),
  not on this server's local disk - safe to run on a host with no persistent
  storage (e.g. Render's free tier).

  Required env vars:
    UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN  - shared cloud data store
    PTO_ACCESS_KEY                                     - shared link passphrase
  Optional:
    PORT (default 3050)
*/

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cloudStore = require('./server/kv-store.js');
const ptoLogic = require('./server/pto-logic.js');

const PORT = Number(process.env.PORT || 3050);
const ACCESS_KEY = process.env.PTO_ACCESS_KEY || '';
const COOKIE_NAME = 'pto_access';
const MTD_ROOT = __dirname;
const SNAPSHOT_MAX_AGE_MS = Number(process.env.PTO_SNAPSHOT_CACHE_MS || 15000);

if (!cloudStore.isConfigured()) {
  console.error('Missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN. The public PTO server has nowhere to store data - refusing to start.');
  process.exit(1);
}
if (!ACCESS_KEY) {
  console.error('Missing PTO_ACCESS_KEY. Set a passphrase so the public link is not wide open - refusing to start.');
  process.exit(1);
}

const STATIC_SHARED = new Set(['ui-utils.js', 'date-utils.js', 'kpi-config.js', 'roster-service.js', 'pto-service.js', 'loading-status.js', 'loading-status.css', 'kpi.css']);

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(text);
}

function contentTypeFor(file) {
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
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

// --- Cloud data access (with a short-lived cache on the read-only snapshots) ---
const PTO_KEY = 'mtdkpi:pto-requests';
const AUDIT_KEY = 'mtdkpi:pto-audit';
const SETTINGS_KEY = 'mtdkpi:pto-settings';
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

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
    const parsed = new URL(req.url, `http://localhost:${PORT}`);
    const cookies = parseCookies(req);
    const suppliedKey = parsed.searchParams.get('key');
    const isSecureReq = req.headers['x-forwarded-proto'] === 'https' || Boolean(req.socket.encrypted);

    let authorized = Boolean(cookies[COOKIE_NAME]) && timingSafeEqualStr(cookies[COOKIE_NAME], ACCESS_KEY);
    let setCookieHeader = null;
    if (!authorized && suppliedKey && timingSafeEqualStr(suppliedKey, ACCESS_KEY)) {
      authorized = true;
      setCookieHeader = `${COOKIE_NAME}=${encodeURIComponent(ACCESS_KEY)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${isSecureReq ? '; Secure' : ''}`;
    }
    if (setCookieHeader) res.setHeader('Set-Cookie', setCookieHeader);

    if (!authorized) {
      if (parsed.pathname.startsWith('/api/')) return json(res, 401, { ok: false, error: 'A valid access link is required.' });
      return sendText(res, 401, 'Access denied. Use the PTO link your team lead shared with you.');
    }

    if (parsed.pathname === '/' || parsed.pathname === '/pto' || parsed.pathname === '/MTD_PTO_Management.html') {
      const filePath = path.join(MTD_ROOT, 'MTD_PTO_Management.html');
      return sendText(res, 200, fs.readFileSync(filePath, 'utf8'), 'text/html; charset=utf-8');
    }

    const sharedMatch = parsed.pathname.match(/^\/shared\/([a-zA-Z0-9._-]+)$/);
    if (sharedMatch && STATIC_SHARED.has(sharedMatch[1])) {
      const filePath = path.join(MTD_ROOT, 'shared', sharedMatch[1]);
      return sendText(res, 200, fs.readFileSync(filePath, 'utf8'), contentTypeFor(sharedMatch[1]));
    }

    if (parsed.pathname === '/api/health') {
      return json(res, 200, { ok: true, success: true, server: 'online', timestamp: new Date().toISOString() });
    }

    if (parsed.pathname === '/api/roster' && req.method === 'GET') {
      const roster = await loadRosterSnapshot();
      return json(res, 200, { ok: true, records: roster.records || [], lastUpdated: roster.lastUpdated || '' });
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
        employee: ptoLogic.cleanEmail(parsed.searchParams.get('employeeEmail')),
        teamLead: String(parsed.searchParams.get('teamLead') || ''),
        kpi: String(parsed.searchParams.get('kpiType') || ''),
        channel: String(parsed.searchParams.get('primaryChannel') || ''),
        status: String(parsed.searchParams.get('status') || ''),
        approver: ptoLogic.cleanEmail(parsed.searchParams.get('approverEmail')),
        ptoDate: String(parsed.searchParams.get('ptoDate') || ''),
        dateRequested: String(parsed.searchParams.get('dateRequested') || '')
      };
      const requests = (data.requests || []).filter(x =>
        (!filters.employee || ptoLogic.cleanEmail(x.employeeEmail) === filters.employee) &&
        (!filters.teamLead || x.teamLeadName === filters.teamLead) &&
        (!filters.kpi || x.kpiType === filters.kpi) &&
        (!filters.channel || x.primaryChannel === filters.channel) &&
        (!filters.status || x.status === filters.status) &&
        (!filters.approver || ptoLogic.cleanEmail(x.approverEmail) === filters.approver) &&
        (!filters.ptoDate || (x.startDate <= filters.ptoDate && x.endDate >= filters.ptoDate)) &&
        (!filters.dateRequested || x.dateRequested === filters.dateRequested)
      );
      return json(res, 200, { ok: true, requests, lastUpdated: data.lastUpdated || '', dataStatus: 'Live' });
    }

    if (parsed.pathname === '/api/pto/requests' && req.method === 'POST') {
      const body = await readJsonBody(req);
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
      await appendAudit(requestId, request.status === 'DRAFT' ? 'REQUEST_CREATED' : 'REQUEST_SUBMITTED', { user: request.createdBy, newValue: request, notes: request.reason });
      return json(res, 201, { ok: true, request, lastUpdated: data.lastUpdated });
    }

    if (parsed.pathname === '/api/pto/forecast' && req.method === 'GET') {
      const requestId = parsed.searchParams.get('requestId');
      const [pto, settings, roster, schedules, attendance] = await Promise.all([loadPto(), loadSettings(), loadRosterSnapshot(), loadScheduleSnapshot(), loadAttendanceSnapshot()]);
      const ctx = { pto, settings, roster: roster.records || [], schedules, attendance };
      if (requestId) {
        const request = (pto.requests || []).find(x => x.requestId === requestId);
        if (!request) return json(res, 404, { ok: false, error: 'PTO request not found.' });
        return json(res, 200, ptoLogic.applyPtoCapacityLimits(ptoLogic.buildPtoForecast({ requestId }, ctx), request, ctx));
      }
      const input = {
        employeeEmail: ptoLogic.cleanEmail(parsed.searchParams.get('employeeEmail')),
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
      if (calculation.missingScheduleDates.length) return json(res, 409, { ok: false, error: `Forecast unavailable because schedule is missing for: ${calculation.missingScheduleDates.join(', ')}.`, missingScheduleDates: calculation.missingScheduleDates });
      if (!calculation.workDates.length) return json(res, 409, { ok: false, error: 'The requested dates are all scheduled rest days.', rdDates: calculation.rdDates });
      Object.assign(input, { employeeName: employee.employeeName, kpiType: employee.kpiType, primaryChannel: employee.primaryChannel, teamLeadName: employee.teamLeadName, workDates: calculation.workDates });
      return json(res, 200, ptoLogic.applyPtoCapacityLimits(ptoLogic.buildPtoForecast(input, ctx), input, ctx));
    }

    if (parsed.pathname === '/api/pto/conflicts' && req.method === 'GET') {
      const data = await loadPto();
      const candidate = { employeeEmail: ptoLogic.cleanEmail(parsed.searchParams.get('employeeEmail')), startDate: parsed.searchParams.get('startDate'), endDate: parsed.searchParams.get('endDate') };
      const excludeId = parsed.searchParams.get('excludeId') || '';
      return json(res, 200, { ok: true, conflicts: ptoLogic.ptoConflictsFor(candidate, data.requests || [], excludeId), lastUpdated: data.lastUpdated || '' });
    }

    if (parsed.pathname === '/api/pto/audit' && req.method === 'GET') {
      const requestId = parsed.searchParams.get('requestId');
      const data = await loadAudit();
      const events = (data.events || []).filter(x => !requestId || x.requestId === requestId);
      return json(res, 200, { ok: true, events, lastUpdated: data.lastUpdated || '', dataStatus: 'Live' });
    }

    const ptoRequestMatch = parsed.pathname.match(/^\/api\/pto\/requests\/([^/]+)(?:\/(submit|approve|partial-approve|decline|withdraw|cancel|return))?$/);
    if (ptoRequestMatch) {
      const requestId = decodeURIComponent(ptoRequestMatch[1]);
      const action = ptoRequestMatch[2] || '';
      const data = await loadPto();
      const index = (data.requests || []).findIndex(x => x.requestId === requestId);
      if (index < 0) return json(res, 404, { ok: false, error: 'PTO request not found.' });
      const current = data.requests[index];

      if (req.method === 'GET' && !action) return json(res, 200, { ok: true, request: current, lastUpdated: data.lastUpdated || '', dataStatus: 'Live' });

      if (['approve', 'partial-approve', 'decline', 'cancel', 'return'].includes(action)) {
        return json(res, 403, { ok: false, error: 'Approvals and declines are handled on the internal dashboard, not the public PTO link.' });
      }

      const body = await readJsonBody(req);
      const now = new Date().toISOString();
      const user = String(body.user || current.employeeEmail || 'Rep');

      if (req.method === 'PUT' && !action) {
        if (['APPROVED', 'PARTIALLY_APPROVED'].includes(current.status)) return json(res, 403, { ok: false, error: 'Approved requests can only be revised on the internal dashboard.' });
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
    console.log(`Share links as: https://<your-render-host>/pto?key=<PTO_ACCESS_KEY>`);
  });
}

module.exports = { server };
