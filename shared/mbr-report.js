import {copilotChat, copilotResponseText} from './qa-dsat-service.js';
import {api} from './ui-utils.js';

// Palette extracted directly from the sample deck's explicit slide fills (not its unused
// default Office theme) - see MBR - Team Reymark Mac Lopez - July 2026.pptx.
export const MBR_PALETTE = {
  darkBg: '0B142B',
  accent: '6C63FF',
  muted: '9AA4C2',
  lightBg: 'F2F4FA',
  navyMid: '152040',
  navyCard: '1B274A',
  navyDeep: '1F3864',
  good: '2ECC8F',
  goodLight: '8BC34A',
  bad: 'C0504D',
  white: 'FFFFFF',
  ink: '1B1F2A'
};

const PRESENT_CODES = new Set(['ONSITE', 'WFH', 'LATE']);
const PTO_CODES = new Set(['PTO', 'PARTIAL_PTO']);
const HALF_DAY_CODES = new Set(['SL-HD', 'EL-HD']);
const GOOD_STATUSES = new Set(['Exceptional', 'Exceeds']);

// A real customer complaint/compliment can run to several sentences - left untruncated in a
// narrow table cell that reliably blows out the row height and pushes into whatever's below it
// (the insight callout, the next section). Table cells still wrap normally up to this cap.
function truncate(text, maxLen) {
  const value = String(text || '').trim();
  return value.length > maxLen ? `${value.slice(0, maxLen - 1).trim()}…` : value;
}
// Attendance dates arrive as bare "YYYY-MM-DD"; ticket surveyDate fields arrive as full ISO
// timestamps ("2026-08-03T17:34:05Z") - appending "T12:00:00Z" to an already-full timestamp
// produces an invalid string, so only do that for a bare date.
function shortDate(date) {
  const value = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? `${date}T12:00:00Z` : date;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleDateString('en-US', {month: 'short', day: 'numeric', timeZone: 'UTC'});
}
export function monthLabel(month) { return new Date(`${month}-01T12:00:00Z`).toLocaleDateString('en-US', {month: 'long', year: 'numeric', timeZone: 'UTC'}); }
function roundTo(n, places) { return Number.isFinite(n) ? Math.round(n * 10 ** places) / 10 ** places : null; }

// --- Attendance -------------------------------------------------------------------------
// /api/my/team-attendance already resolves `eligible` per day (excludes Rest Days and dates
// with no schedule on file) - this mirrors the exact present/pto/absence classification the
// personal "My Attendance" tab already applies (renderAttendance in pto-public.html), just
// run per team member instead of just the signed-in user, plus a half-day nuance for SL-HD/EL-HD.
export function aggregateMemberAttendance(member, month) {
  const monthDays = (member.days || []).filter(d => d.date.startsWith(month));
  let scheduled = 0, present = 0, absence = 0, pto = 0, lateCount = 0, ncnsCount = 0;
  const reasonParts = [];
  for (const d of monthDays) {
    if (!d.eligible) continue;
    scheduled++;
    if (d.code === 'LATE') lateCount++;
    if (d.code === 'NCNS') ncnsCount++;
    if (PRESENT_CODES.has(d.code)) { present++; continue; }
    if (PTO_CODES.has(d.code)) { pto++; continue; }
    if (!d.code) continue;
    if (HALF_DAY_CODES.has(d.code)) { present += 0.5; absence += 0.5; }
    else absence++;
    reasonParts.push(`${shortDate(d.date)} ${d.code}${d.reason ? ` — ${d.reason}` : ''}`);
  }
  return {
    employeeEmail: member.employeeEmail,
    employeeName: member.employeeName,
    scheduled, present, absenceDays: absence, ptoDays: pto, lateCount, ncnsCount,
    attendancePct: scheduled ? roundTo((present / scheduled) * 100, 2) : null,
    absenceReason: reasonParts.join(', ') || '—'
  };
}

export function attendanceFactSummary(rows) {
  const totalLate = rows.reduce((sum, r) => sum + r.lateCount, 0);
  const totalNcns = rows.reduce((sum, r) => sum + r.ncnsCount, 0);
  const withAbsence = rows.filter(r => r.absenceDays > 0).length;
  const parts = [
    totalLate ? `${totalLate} LATE code(s) logged team-wide this period.` : 'No LATE codes were logged team-wide this period.',
    withAbsence ? `${withAbsence} of ${rows.length} team member(s) had at least one absence.` : 'No absences recorded this period.'
  ];
  if (totalNcns) parts.push(`${totalNcns} NCNS instance(s) recorded.`);
  return parts.join(' ');
}

// --- Productivity -----------------------------------------------------------------------
export function productivityGroups(teamResults) {
  const voice = [], nonVoice = [], senior = [];
  for (const row of teamResults || []) {
    if (row.kpiType === 'Voice Jr TSR' || row.kpiType === 'Voice Sr TSR') {
      voice.push({employeeName: row.employeeName, accepted: row.calls?.accepted ?? null, dailyAverage: row.calls?.dailyAverage ?? null, longCalls: row.calls?.longCalls ?? null, lcrRate: row.lcr?.rate ?? null});
    } else if (row.kpiType === 'Non-Voice Jr TSR' || row.kpiType === 'Non-Voice Sr TSR') {
      nonVoice.push({employeeName: row.employeeName, solved: row.tickets?.solved ?? null, excluded: row.tickets?.excluded ?? null});
    } else if (row.kpiType === 'Senior TSR') {
      senior.push({employeeName: row.employeeName, updated: row.tickets?.unique ?? null, publicCount: row.tickets?.publicCount ?? null, internalCount: row.tickets?.internalCount ?? null, teamAvgBaseKpi: row.team?.average ?? null});
    }
  }
  return {voice, nonVoice, senior};
}

// --- CSAT -------------------------------------------------------------------------------
export function csatRows(teamResults) {
  return (teamResults || []).map(row => ({employeeName: row.employeeName, rate: row.csat?.rate ?? null, good: row.csat?.good ?? 0, bad: row.csat?.bad ?? 0, hasSurveys: (row.csat?.good ?? 0) + (row.csat?.bad ?? 0) > 0}));
}
export function csatBadDetail(teamResults) {
  const out = [];
  for (const row of teamResults || []) for (const t of row.csat?.badTickets || []) out.push({employeeName: row.employeeName, ticketId: t.ticketId, subject: t.subject, surveyDate: t.surveyDate, comment: t.comment || ''});
  return out.sort((a, b) => String(a.surveyDate).localeCompare(String(b.surveyDate)));
}
export function csatGoodHighlights(teamResults, limit = 5) {
  const out = [];
  for (const row of teamResults || []) for (const t of row.csat?.goodTickets || []) if (t.comment && t.comment.trim()) out.push({employeeName: row.employeeName, surveyDate: t.surveyDate, comment: t.comment.trim()});
  return out.sort((a, b) => String(b.surveyDate).localeCompare(String(a.surveyDate))).slice(0, limit);
}
export function csatGoodCounts(teamResults) {
  return (teamResults || []).map(row => ({employeeName: row.employeeName, good: row.csat?.good ?? 0})).filter(r => r.good > 0).sort((a, b) => b.good - a.good);
}

// --- Coaching ---------------------------------------------------------------------------
export function coachingSections(records, month) {
  const inPeriod = (records || []).filter(r => String(r.coachingDate || '').startsWith(month));
  const inProgress = (records || []).filter(r => String(r.coachingDate || '') > `${month}-31`).sort((a, b) => String(a.coachingDate).localeCompare(String(b.coachingDate)));
  return {inPeriod, inProgress};
}

// --- Pending / Reminders -----------------------------------------------------------------
export function pendingReminders(notifications) {
  const evaluations = [...(notifications?.evaluations || []), ...(notifications?.regularizations || [])].sort((a, b) => a.daysUntilDue - b.daysUntilDue);
  const anniversaries = (notifications?.anniversaries || []).sort((a, b) => a.daysUntil - b.daysUntil);
  return {evaluations, anniversaries};
}

// --- Narrative drafting: Copilot drafts, Groq fact-checks -------------------------------
// Copilot (tsr-bot) drafts each line client-side from a lean prompt - see qa-dsat-service.js's
// own note on why tsr-bot can only be reached from a browser on Lofty's network, never from this
// Render-hosted server. That draft then goes to /api/my/mbr-review-insight, which runs
// server-side (the Groq API key never reaches the browser) and checks it against the FULL
// underlying dataset - not just the lean summary Copilot saw - before it goes in the deck.
// Both steps degrade independently and silently: no Copilot token -> skip straight to the
// factual fallback; Groq not configured or briefly down -> the review endpoint itself falls
// back to returning the draft unreviewed. An MBR generation never fails because of either.
async function reviewWithGroq(draft, context, format = 'text') {
  try {
    const result = await api('/api/my/mbr-review-insight', {method: 'POST', body: JSON.stringify({draft, context, format})});
    return result.reviewed || draft;
  } catch { return draft; }
}

async function draftText(token, prompt, fallback, context) {
  if (!token) return fallback;
  let text;
  try {
    const result = await copilotChat(token, prompt);
    text = copilotResponseText(result).trim();
  } catch { return fallback; }
  return text ? reviewWithGroq(text, context) : fallback;
}

export async function draftTeamOverviewInsight(token, teamResults) {
  const counts = {};
  for (const r of teamResults || []) counts[r.performanceStatus] = (counts[r.performanceStatus] || 0) + 1;
  const summary = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ');
  const watchList = (teamResults || []).filter(r => r.performanceStatus === 'Intervention').map(r => `${r.employeeName} (${r.performanceStatus}, ${r.finalKpi})`);
  const fallback = watchList.length ? `Team performance this period: ${summary}. Needs attention: ${watchList.join(', ')}.` : `Team performance this period: ${summary}.`;
  const prompt = `You are drafting one short sentence (max 2 sentences) for a Monthly Business Review slide summarizing a support team's KPI performance this period. Be direct and factual, no fluff, plain text only, no markdown, no preamble. Team performance tier counts: ${JSON.stringify(counts)}. Employees needing attention (Intervention tier): ${JSON.stringify(watchList)}.`;
  const context = {teamPerformance: (teamResults || []).map(r => ({employeeName: r.employeeName, kpiType: r.kpiType, finalKpi: r.finalKpi, performanceStatus: r.performanceStatus}))};
  return draftText(token, prompt, fallback, context);
}

export async function draftCsatInsight(token, badDetail, teamSize) {
  if (!badDetail.length) return `No bad CSATs logged team-wide this period across ${teamSize} employees.`;
  const byEmployee = {};
  for (const t of badDetail) byEmployee[t.employeeName] = (byEmployee[t.employeeName] || 0) + 1;
  const fallback = `${badDetail.length} bad CSAT(s) logged team-wide across ${Object.keys(byEmployee).length} of ${teamSize} employees this period.`;
  const prompt = `You are drafting one short sentence (max 2 sentences) for a Monthly Business Review slide about bad CSAT survey results. Be direct and factual, plain text only, no markdown, no preamble. Bad CSAT tickets this period: ${JSON.stringify(badDetail.map(t => ({employeeName: t.employeeName, subject: t.subject, comment: t.comment})))}.`;
  const context = {teamSize, badCsatCount: badDetail.length, badCsatsByEmployee: byEmployee, badTickets: badDetail.map(t => ({employeeName: t.employeeName, subject: t.subject, comment: t.comment}))};
  return draftText(token, prompt, fallback, context);
}

// A JSON-mode LLM reply matching Array.isArray is not the same as matching the schema - Groq's
// review pass has returned bullet arrays containing objects (e.g. {employeeName,tier,finalKpi})
// instead of the plain strings pptxgenjs's addText() bullet renderer expects, which would either
// print "[object Object]" on the slide or throw. Keep only entries that are actually usable text.
function stringBullets(value, fallback, {allowEmpty = false} = {}) {
  if (!Array.isArray(value)) return fallback;
  if (!value.length) return allowEmpty ? [] : fallback;
  const strings = value.filter(v => typeof v === 'string' && v.trim());
  return strings.length ? strings : fallback;
}

export async function draftWrapUp(token, {teamResults, csatBad, coachingInProgress}) {
  const fallback = {
    workingWell: [`${(teamResults || []).filter(r => GOOD_STATUSES.has(r.performanceStatus)).length} of ${(teamResults || []).length} team members rated Exceptional or Exceeds this period.`],
    needsAttention: (teamResults || []).filter(r => r.performanceStatus === 'Intervention').map(r => `${r.employeeName}: Intervention-tier KPI (${r.finalKpi}).`)
  };
  if (!token) return fallback;
  const prompt = `You are drafting a Monthly Business Review "Wrap-Up" slide for a support team lead. Reply with ONLY a JSON object, no other text and no markdown, in exactly this shape: {"workingWell":["short bullet", ...], "needsAttention":["short bullet", ...]}. Base it strictly on this data - do not invent anything not supported by it. Team KPI results: ${JSON.stringify((teamResults || []).map(r => ({name: r.employeeName, tier: r.performanceStatus, finalKpi: r.finalKpi})))}. Bad CSAT count: ${csatBad.length}. Coaching sessions currently in progress: ${JSON.stringify((coachingInProgress || []).map(c => ({name: c.employeeName, category: c.category})))}.`;
  let draft;
  try {
    const result = await copilotChat(token, prompt);
    const raw = copilotResponseText(result);
    const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw);
    draft = {
      workingWell: stringBullets(parsed.workingWell, fallback.workingWell),
      needsAttention: stringBullets(parsed.needsAttention, fallback.needsAttention, {allowEmpty: true})
    };
  } catch { return fallback; }
  const context = {
    teamPerformance: (teamResults || []).map(r => ({employeeName: r.employeeName, tier: r.performanceStatus, finalKpi: r.finalKpi})),
    badCsatCount: (csatBad || []).length,
    coachingInProgress: (coachingInProgress || []).map(c => ({employeeName: c.employeeName, category: c.category}))
  };
  const reviewedRaw = await reviewWithGroq(JSON.stringify(draft), context, 'json');
  try {
    const reviewedParsed = JSON.parse(reviewedRaw.match(/\{[\s\S]*\}/)?.[0] || reviewedRaw);
    return {
      workingWell: stringBullets(reviewedParsed.workingWell, draft.workingWell),
      needsAttention: stringBullets(reviewedParsed.needsAttention, draft.needsAttention, {allowEmpty: true})
    };
  } catch { return draft; }
}

// --- Deck assembly (pptxgenjs, loaded as window.PptxGenJS via shared/vendor/pptxgen.bundle.js) ---
const P = MBR_PALETTE;
const FONT = 'Calibri';

function newDeck() {
  if (!window.PptxGenJS) throw new Error('pptxgenjs did not load - check shared/vendor/pptxgen.bundle.js.');
  const pres = new window.PptxGenJS();
  pres.layout = 'LAYOUT_WIDE';
  return pres;
}

function addFooter(slide, pageNum) {
  slide.addText('Lofty Support · Monthly Business Review', {x: 0.5, y: 7.1, w: 8, h: 0.3, fontFace: FONT, fontSize: 9, color: P.muted, align: 'left'});
  slide.addText(String(pageNum), {x: 12.4, y: 7.1, w: 0.4, h: 0.3, fontFace: FONT, fontSize: 9, color: P.muted, align: 'right'});
}

function sectionHeaderSlide(pres, {eyebrow, title, subtitle}) {
  const slide = pres.addSlide();
  slide.background = {color: P.lightBg};
  if (eyebrow) slide.addText(eyebrow.toUpperCase(), {x: 0.6, y: 0.4, w: 8, h: 0.35, fontFace: FONT, fontSize: 12, bold: true, color: P.accent, charSpacing: 1});
  slide.addText(title, {x: 0.6, y: 0.75, w: 11, h: 0.7, fontFace: FONT, fontSize: 32, bold: true, color: P.ink});
  if (subtitle) slide.addText(subtitle, {x: 0.6, y: 1.35, w: 11, h: 0.4, fontFace: FONT, fontSize: 14, color: P.muted});
  return slide;
}

function insightCallout(slide, text, y) {
  slide.addShape('roundRect', {x: 0.6, y, w: 12.1, h: 0.8, rectRadius: 0.08, fill: {color: P.navyMid}, line: {type: 'none'}});
  slide.addText(text, {x: 0.9, y: y + 0.08, w: 11.5, h: 0.64, fontFace: FONT, fontSize: 12, color: P.white, valign: 'middle', italic: true, margin: 0});
}

function dataTable(slide, {headRow, rows, x, y, w, colW, statusCol}) {
  const headerStyle = {fill: {color: P.navyDeep}, color: P.white, bold: true, fontFace: FONT, fontSize: 10, align: 'left', valign: 'middle'};
  const bodyStyle = {fontFace: FONT, fontSize: 10, color: P.ink, align: 'left', valign: 'middle', fill: {color: P.white}};
  const tableRows = [headRow.map(h => ({text: h, options: headerStyle}))];
  rows.forEach((row, i) => {
    tableRows.push(row.map((cell, ci) => {
      let opts = {...bodyStyle, fill: {color: i % 2 ? P.lightBg : P.white}};
      if (statusCol === ci) {
        const good = GOOD_STATUSES.has(cell) || cell === 'Ready';
        const bad = cell === 'Intervention';
        if (good) opts = {...opts, color: P.good, bold: true};
        else if (bad) opts = {...opts, color: P.bad, bold: true};
      }
      return {text: cell == null ? '—' : String(cell), options: opts};
    }));
  });
  slide.addTable(tableRows, {x, y, w, colW, border: {type: 'solid', color: 'DDDDDD', pt: 0.5}, autoPage: false});
}

function titleSlide(pres, {leaderName, monthText, sections}) {
  const slide = pres.addSlide();
  slide.background = {color: P.darkBg};
  slide.addText('MONTHLY BUSINESS REVIEW', {x: 0.8, y: 2.3, w: 11.7, h: 0.5, fontFace: FONT, fontSize: 16, bold: true, color: P.accent, charSpacing: 2});
  slide.addText(`Team ${leaderName}`, {x: 0.8, y: 2.85, w: 11.7, h: 0.9, fontFace: FONT, fontSize: 40, bold: true, color: P.white});
  slide.addText(`Performance Summary · ${monthText}`, {x: 0.8, y: 3.75, w: 11.7, h: 0.45, fontFace: FONT, fontSize: 16, color: P.muted});
  slide.addText(sections.join(' · '), {x: 0.8, y: 4.25, w: 11.7, h: 0.4, fontFace: FONT, fontSize: 12, color: P.muted});
  slide.addText(`Prepared for ${leaderName} · Lofty Support`, {x: 0.8, y: 6.6, w: 11.7, h: 0.35, fontFace: FONT, fontSize: 11, color: P.muted});
}

function teamOverviewSlide(pres, {teamResults, insight}, pageNum) {
  const slide = sectionHeaderSlide(pres, {title: 'Team Overview', subtitle: `Team Snapshot — ${teamResults.length} Active Members`});
  dataTable(slide, {
    headRow: ['Employee', 'KPI Type', 'Channel', 'Final KPI', 'Performance'],
    rows: teamResults.map(r => [r.employeeName, r.kpiType, r.primaryChannel, r.finalKpi == null ? '—' : r.finalKpi, r.performanceStatus || '—']),
    x: 0.6, y: 1.9, w: 12.1, colW: [4, 2.6, 2.5, 1.5, 1.5], statusCol: 4
  });
  insightCallout(slide, insight, 6.15);
  addFooter(slide, pageNum);
}

function attendanceSlide(pres, {rows, factSummary}, pageNum) {
  const slide = sectionHeaderSlide(pres, {eyebrow: 'Section 1', title: 'Attendance', subtitle: 'Worked days, unscheduled absences, and PTO'});
  dataTable(slide, {
    headRow: ['Employee', 'Scheduled', 'Present', 'Attendance %', 'Absence Days', 'PTO Days', 'Absence Reason'],
    rows: rows.map(r => [r.employeeName, r.scheduled, r.present, r.attendancePct == null ? '—' : `${r.attendancePct}%`, r.absenceDays, r.ptoDays, r.absenceReason]),
    x: 0.6, y: 1.9, w: 12.1, colW: [2.2, 1.1, 1.1, 1.3, 1.3, 1.1, 4]
  });
  insightCallout(slide, factSummary, 6.15);
  addFooter(slide, pageNum);
}

function productivitySlide(pres, {voice, nonVoice, senior}, pageNum) {
  const slide = sectionHeaderSlide(pres, {eyebrow: 'Section 2', title: 'Productivity', subtitle: 'Volume handled by role type'});
  let y = 1.9;
  if (voice.length) {
    slide.addText('VOICE JR TSR', {x: 0.6, y, w: 6, h: 0.3, fontFace: FONT, fontSize: 11, bold: true, color: P.accent});
    dataTable(slide, {headRow: ['Employee', 'Accepted Calls', 'Daily Avg', 'Long Calls', 'LCR %'], rows: voice.map(v => [v.employeeName, v.accepted, v.dailyAverage == null ? '—' : roundTo(v.dailyAverage, 2), v.longCalls, v.lcrRate == null ? '—' : `${roundTo(v.lcrRate, 2)}%`]), x: 0.6, y: y + 0.3, w: 6, colW: [2.2, 1.4, 1, 1.1, 0.9]});
    y += 0.3 + 0.35 * (voice.length + 1) + 0.25;
  }
  if (nonVoice.length) {
    slide.addText('NON-VOICE JR TSR', {x: 0.6, y, w: 6, h: 0.3, fontFace: FONT, fontSize: 11, bold: true, color: P.accent});
    dataTable(slide, {headRow: ['Employee', 'Tickets Solved', 'Excluded'], rows: nonVoice.map(v => [v.employeeName, v.solved, v.excluded]), x: 0.6, y: y + 0.3, w: 6, colW: [3, 2, 1.5]});
  }
  if (senior.length) {
    slide.addText('SENIOR TSR', {x: 6.9, y: 1.9, w: 5.8, h: 0.3, fontFace: FONT, fontSize: 11, bold: true, color: P.accent});
    dataTable(slide, {headRow: ['Employee', 'Updated', 'Public', 'Internal', 'Team Avg Base KPI'], rows: senior.map(v => [v.employeeName, v.updated, v.publicCount, v.internalCount, v.teamAvgBaseKpi == null ? '—' : roundTo(v.teamAvgBaseKpi, 2)]), x: 6.9, y: 2.2, w: 5.8, colW: [2, 0.9, 0.9, 0.9, 1.1]});
  }
  addFooter(slide, pageNum);
}

function csatBadSlide(pres, {rows, badDetail, insight}, pageNum) {
  const slide = sectionHeaderSlide(pres, {eyebrow: 'Section 3', title: 'CSAT — Focus on Bad CSATs', subtitle: `${badDetail.length} bad CSAT(s) logged team-wide this period`});
  dataTable(slide, {headRow: ['Employee', 'CSAT Rate', 'Good', 'Bad'], rows: rows.map(r => [r.employeeName, r.hasSurveys ? `${roundTo(r.rate, 2)}%` : 'No surveys', r.good, r.bad]), x: 0.6, y: 1.85, w: 5.6, colW: [2.6, 1.4, 0.8, 0.8]});
  if (badDetail.length) {
    slide.addText('BAD CSAT DETAIL', {x: 6.5, y: 1.85, w: 6.2, h: 0.3, fontFace: FONT, fontSize: 11, bold: true, color: P.bad});
    dataTable(slide, {headRow: ['Employee', 'Ticket', 'Date', 'Comment'], rows: badDetail.slice(0, 8).map(t => [t.employeeName, `#${t.ticketId ?? '—'} — ${truncate(t.subject, 40)}`, shortDate(t.surveyDate), truncate(t.comment, 140) || '—']), x: 6.5, y: 2.15, w: 6.2, colW: [1.5, 1.7, 0.8, 2.2]});
  }
  insightCallout(slide, insight, 6.15);
  addFooter(slide, pageNum);
}

function csatGoodSlide(pres, {goodCounts, highlights, totalGood}, pageNum) {
  const slide = sectionHeaderSlide(pres, {eyebrow: 'CSAT — Highlights', title: 'Good CSAT Highlights', subtitle: `${totalGood} good CSAT(s) logged team-wide this period`});
  slide.addText('MOST GOOD CSATS THIS MONTH', {x: 0.6, y: 1.85, w: 5, h: 0.3, fontFace: FONT, fontSize: 11, bold: true, color: P.good});
  dataTable(slide, {headRow: ['Employee', 'Good CSATs'], rows: goodCounts.map(g => [g.employeeName, g.good]), x: 0.6, y: 2.15, w: 5, colW: [3.5, 1.5]});
  if (highlights.length) {
    slide.addText('STANDOUT CUSTOMER COMMENTS', {x: 6, y: 1.85, w: 6.7, h: 0.3, fontFace: FONT, fontSize: 11, bold: true, color: P.good});
    dataTable(slide, {headRow: ['Employee', 'Date', 'Comment'], rows: highlights.map(h => [h.employeeName, shortDate(h.surveyDate), `"${truncate(h.comment, 220)}"`]), x: 6, y: 2.15, w: 6.7, colW: [1.8, 1, 3.9]});
  }
  addFooter(slide, pageNum);
}

function coachingSlide(pres, {inPeriod, inProgress, factSummary}, pageNum) {
  const slide = sectionHeaderSlide(pres, {eyebrow: 'Section 4', title: 'Coaching Sessions', subtitle: inPeriod.length ? `${inPeriod.length} coaching session(s) logged this period` : 'No coaching sessions were logged this period.'});
  let y = 1.9;
  if (inPeriod.length) {
    dataTable(slide, {headRow: ['Employee', 'Category', 'Status', 'Coaching Date'], rows: inPeriod.map(r => [r.employeeName, r.category, r.status, shortDate(r.coachingDate)]), x: 0.6, y, w: 12.1, colW: [3.5, 3.5, 2.5, 2.6]});
    y += 0.4 + 0.35 * (inPeriod.length + 1) + 0.3;
  }
  if (inProgress.length) {
    slide.addText('IN PROGRESS', {x: 0.6, y, w: 6, h: 0.3, fontFace: FONT, fontSize: 11, bold: true, color: P.accent});
    dataTable(slide, {headRow: ['Employee', 'Category', 'Status', 'Follow-up Date'], rows: inProgress.map(r => [r.employeeName, r.category, r.status, r.targetFollowUpDate ? shortDate(r.targetFollowUpDate) : '—']), x: 0.6, y: y + 0.3, w: 12.1, colW: [3.5, 3.5, 2.5, 2.6]});
  }
  insightCallout(slide, factSummary, 6.15);
  addFooter(slide, pageNum);
}

function remindersSlide(pres, {evaluations, anniversaries}, pageNum) {
  const slide = sectionHeaderSlide(pres, {eyebrow: 'Looking Ahead', title: 'Pending & Reminders', subtitle: 'Evaluations due and upcoming anniversaries'});
  slide.addText('EVALUATIONS DUE', {x: 0.6, y: 1.9, w: 5.8, h: 0.3, fontFace: FONT, fontSize: 11, bold: true, color: P.accent});
  dataTable(slide, {headRow: ['Employee', 'Due Date', 'Days Until'], rows: evaluations.length ? evaluations.map(e => [e.employeeName, e.dueDate, e.daysUntilDue]) : [['No evaluations due in the next 30 days.', '', '']], x: 0.6, y: 2.2, w: 5.8, colW: [3.2, 1.6, 1]});
  slide.addText('WORK ANNIVERSARIES', {x: 6.9, y: 1.9, w: 5.8, h: 0.3, fontFace: FONT, fontSize: 11, bold: true, color: P.accent});
  dataTable(slide, {headRow: ['Employee', 'Date', 'Years'], rows: anniversaries.length ? anniversaries.map(a => [a.employeeName, a.nextDate, a.years]) : [['No work anniversaries in the next 30 days.', '', '']], x: 6.9, y: 2.2, w: 5.8, colW: [3.2, 1.6, 1]});
  addFooter(slide, pageNum);
}

function wrapUpSlide(pres, {workingWell, needsAttention}, pageNum) {
  const slide = sectionHeaderSlide(pres, {title: 'Wrap-Up', subtitle: 'Summary & Action Items'});
  slide.addText('WHAT’S WORKING', {x: 0.6, y: 1.9, w: 5.8, h: 0.35, fontFace: FONT, fontSize: 13, bold: true, color: P.good});
  slide.addText(workingWell.map((t, i) => ({text: t, options: {bullet: {characterCode: '2713'}, color: P.ink, breakLine: i < workingWell.length - 1, paraSpaceAfter: 10}})), {x: 0.6, y: 2.3, w: 5.8, h: 4.2, fontFace: FONT, fontSize: 12, valign: 'top'});
  slide.addText('NEEDS ATTENTION', {x: 6.9, y: 1.9, w: 5.8, h: 0.35, fontFace: FONT, fontSize: 13, bold: true, color: P.bad});
  const attentionItems = needsAttention.length ? needsAttention : ['Nothing needs escalation this period.'];
  slide.addText(attentionItems.map((t, i) => ({text: t, options: {bullet: {characterCode: '2757'}, color: P.ink, breakLine: i < attentionItems.length - 1, paraSpaceAfter: 10}})), {x: 6.9, y: 2.3, w: 5.8, h: 4.2, fontFace: FONT, fontSize: 12, valign: 'top'});
  addFooter(slide, pageNum);
}

/**
 * Builds and downloads the MBR deck in the browser. All inputs are already-fetched API
 * responses / already-aggregated data - this function does not fetch anything itself.
 */
export async function generateMbrDeck({leaderName, month, teamResults, teamAttendanceMembers, coachingRecords, notifications, copilotToken}) {
  const attendanceRows = (teamAttendanceMembers || []).map(m => aggregateMemberAttendance(m, month));
  const {voice, nonVoice, senior} = productivityGroups(teamResults);
  const csatTable = csatRows(teamResults);
  const badDetail = csatBadDetail(teamResults);
  const goodHighlights = csatGoodHighlights(teamResults);
  const goodCounts = csatGoodCounts(teamResults);
  const totalGood = goodCounts.reduce((s, r) => s + r.good, 0);
  const {inPeriod, inProgress} = coachingSections(coachingRecords, month);
  const {evaluations, anniversaries} = pendingReminders(notifications);

  const [teamInsight, csatInsight, wrapUp] = await Promise.all([
    draftTeamOverviewInsight(copilotToken, teamResults),
    draftCsatInsight(copilotToken, badDetail, teamResults.length),
    draftWrapUp(copilotToken, {teamResults, csatBad: badDetail, coachingInProgress: inProgress})
  ]);

  const pres = newDeck();
  const monthText = monthLabel(month);
  const sections = ['Attendance', 'Productivity', 'CSAT', 'Coaching', 'Pending & Reminders'];
  titleSlide(pres, {leaderName, monthText, sections});
  teamOverviewSlide(pres, {teamResults, insight: teamInsight}, 2);
  attendanceSlide(pres, {rows: attendanceRows, factSummary: attendanceFactSummary(attendanceRows)}, 3);
  productivitySlide(pres, {voice, nonVoice, senior}, 4);
  csatBadSlide(pres, {rows: csatTable, badDetail, insight: csatInsight}, 5);
  csatGoodSlide(pres, {goodCounts, highlights: goodHighlights, totalGood}, 6);
  const coachingFactSummary = [
    inPeriod.length ? `${inPeriod.length} coaching session(s) logged this period.` : 'No coaching sessions were logged this period.',
    inProgress.length ? `${inProgress.length} of ${teamResults.length} team member(s) already have coaching sessions in progress.` : ''
  ].filter(Boolean).join(' ');
  coachingSlide(pres, {inPeriod, inProgress, factSummary: coachingFactSummary}, 7);
  remindersSlide(pres, {evaluations, anniversaries}, 8);
  wrapUpSlide(pres, wrapUp, 9);

  const fileName = `MBR - Team ${leaderName} - ${monthText}.pptx`;
  await pres.writeFile({fileName});
  return fileName;
}
