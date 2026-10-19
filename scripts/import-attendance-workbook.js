#!/usr/bin/env node
'use strict';
// Imports the OTHER teams' attendance (TSR / Sr TSR rows) from the shared "Lofty TSR Attendance.xlsx" workbook
// (Von's OneDrive) into the portal, month by month, up to YESTERDAY (ET - today's shift is not over yet).
// Mac's own team is skipped on purpose: it is entered directly in the portal.
//
//   node scripts/import-attendance-workbook.js dry     # show what would be imported, change nothing
//   node scripts/import-attendance-workbook.js apply   # POST to the local proxy, then recalculate KPI
//
// Needs the local proxy (zendesk-proxy.js) running on :3040 for `apply`.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const DRIVE = 'b!EYCLkBXWdUen8G98c-7A1IYhtUc8GeZGjm2194NJs0qwcR6ryvs3RKXMyGjwYjjZ', ITEM = '01RRM2EX6LPKGC62KIDZEKW72ABAVKZRBF';
const MODE = process.argv[2] === 'apply' ? 'apply' : 'dry';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const etParts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
const todayEt = `${etParts.find(p => p.type === 'year').value}-${etParts.find(p => p.type === 'month').value}-${etParts.find(p => p.type === 'day').value}`;
const monthKey = todayEt.slice(0, 7);
const sheetName = `${MONTHS[Number(monthKey.slice(5)) - 1]} ${monthKey.slice(0, 4)}`;

function readRange() {
  for (let i = 0; i < 6; i += 1) {
    try {
      return JSON.parse(execFileSync('msgraph-cli', ['api', 'get', `/drives/${DRIVE}/items/${ITEM}/workbook/worksheets('${sheetName}')/usedRange`, '--params', '$select=address,values', '--json'], { maxBuffer: 64e6, timeout: 120000 }).toString()).data;
    } catch (e) { console.error('workbook read retry', i + 1, String(e.message).slice(0, 80)); }
  }
  throw new Error('Could not read the attendance workbook.');
}
const range = readRange();
const values = range.values;
const dateRow = values[1]; // Excel serial dates
const colDates = {};
dateRow.forEach((v, c) => {
  if (Number(v) > 40000) {
    const d = new Date(Math.round((Number(v) - 25569) * 86400000)).toISOString().slice(0, 10);
    if (d.startsWith(monthKey) && d < todayEt) colDates[c] = d;
  }
});
const leadStart = values.findIndex(r => String(r[0] || '').trim() === 'Immediate Lead');
const rows = values.slice(3, leadStart === -1 ? values.length : leadStart).filter(r => String(r[1] || '').trim() && ['TSR', 'Sr TSR'].includes(String(r[2] || '').trim()));
const roster = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'roster.json'))).records;
const normName = n => String(n || '').replace(/"[^"]*"/g, ' ').replace(/[^a-zA-Z\s]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
function namesMatch(a, b) {
  const split = n => { const p = normName(n).split(' ').filter(Boolean); const last = p.pop() || ''; return { last, first: p.join(''), initials: p.map(x => x[0]).join(''), firstToken: p[0] || '' }; };
  const x = split(a), y = split(b);
  if (!x.last || x.last !== y.last) return false;
  if (x.first === y.first || x.first === y.initials || y.first === x.initials) return true;
  if ((y.first.length >= 2 && x.initials.startsWith(y.first)) || (x.first.length >= 2 && y.initials.startsWith(x.first))) return true;
  if (x.firstToken && y.firstToken && x.firstToken === y.firstToken) return true;
  const [s, l] = x.first.length <= y.first.length ? [x.first, y.first] : [y.first, x.first];
  return s.length >= 4 && l.startsWith(s);
}
const VALID = new Set(['ONSITE', 'WFH', 'RD', 'PTO', 'PARTIAL_PTO', 'SL', 'SL-HD', 'EL', 'EL-HD', 'LATE', 'NCNS', 'A', 'BL', 'SUSPENDED']);
const entries = {}, report = [], skipped = [];
for (const r of rows) {
  const team = String(r[0]).trim(), name = String(r[1]).trim();
  if (team === 'Reymark "Mac" Lopez') { skipped.push(name); continue; }
  const rec = roster.find(x => x.active && namesMatch(x.employeeName, name));
  if (!rec) { report.push(`NO ROSTER MATCH: ${name}`); continue; }
  const by = {};
  for (const [c, d] of Object.entries(colDates)) {
    const code = String(r[c] || '').trim().toUpperCase();
    if (!code) continue;
    if (!VALID.has(code)) { report.push(`UNKNOWN CODE ${code} for ${name} ${d}`); continue; }
    by[d] = code;
  }
  if (Object.keys(by).length) entries[rec.employeeEmail.toLowerCase()] = by;
  report.push(`${team.slice(0, 12).padEnd(12)} ${name.padEnd(28)} -> ${rec.employeeName.padEnd(28)} ${Object.keys(by).length} days`);
}
const dates = Object.values(colDates).sort();
console.log(`sheet "${sheetName}" | dates ${dates[0]} -> ${dates.at(-1)} | employees ${Object.keys(entries).length} | Mac's team skipped: ${skipped.length}`);
console.log(report.join('\n'));
const payload = { month: monthKey, endDate: todayEt, entries };
if (MODE === 'dry') { console.log('\nDRY RUN - nothing changed. Run with "apply" to import.'); process.exit(0); }

function post(p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({ host: '127.0.0.1', port: 3040, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
      let out = ''; res.on('data', c => out += c); res.on('end', () => resolve({ status: res.statusCode, body: out.slice(0, 300) }));
    });
    req.on('error', reject); req.setTimeout(300000, () => req.destroy(new Error('timeout')));
    req.write(data); req.end();
  });
}
(async () => {
  const backup = path.join(ROOT, 'data', '.backups');
  fs.mkdirSync(backup, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'data', 'attendance.json'), path.join(backup, `attendance-before-workbook-import-${todayEt}.json`));
  const a = await post('/api/attendance', payload);
  console.log('import:', a.status, a.body);
  const k = await post('/api/attendance/recalculate-all');
  console.log('recalculate KPI:', k.status, k.body);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
