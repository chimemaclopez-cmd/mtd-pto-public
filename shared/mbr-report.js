import {copilotChat, copilotResponseText} from './qa-dsat-service.js';
import {api} from './ui-utils.js';

// Lofty's actual brand colors, not the generic violet the original sample deck happened to use -
// accent/accentSecondary sampled directly from shared/img/lofty-logo.png (#3B5CDF) and the
// portal's own body background gradient (rgba(87,47,180) = #572FB4); good/bad match the exact
// status green/red already used throughout pto-public.html so a good/bad CSAT ticket reads the
// same color here as it does on the portal itself.
export const MBR_PALETTE = {
  darkBg: '0B142B',
  accent: '3B5CDF',
  accentSecondary: '572FB4',
  muted: '9AA4C2',
  lightBg: 'F2F4FA',
  navyMid: '152040',
  navyCard: '1B274A',
  navyDeep: '1F3864',
  good: '19AB63',
  goodLight: '8BC34A',
  bad: 'C2313A',
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
  // PTO is authorized leave, not a mark against attendance - `scheduled` above intentionally
  // still counts those days (it's what the table's own "Scheduled" column shows), but the
  // percentage itself needs to exclude them from the denominator the same way it's already
  // excluded from the numerator, or every PTO day silently drags the % down.
  const eligibleForPct = scheduled - pto;
  return {
    employeeEmail: member.employeeEmail,
    employeeName: member.employeeName,
    scheduled, present, absenceDays: absence, ptoDays: pto, lateCount, ncnsCount,
    attendancePct: eligibleForPct ? roundTo((present / eligibleForPct) * 100, 2) : null,
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
// The canonical kpiType values are 'Voice Jr TSR', 'Non-Voice Jr TSR', 'Senior TSR',
// 'Database Agent', 'Trainee', 'Excluded' (shared/kpi-config.js) - 'Voice Sr TSR'/'Non-Voice Sr
// TSR' never exist anywhere in this codebase and matched nothing here, and Database Agent
// wasn't handled at all, so a real Database Agent on the team appeared on the Team Overview
// slide (which iterates the full team) but silently had zero rows on this one.
export function productivityGroups(teamResults) {
  const voice = [], nonVoice = [], senior = [], database = [];
  for (const row of teamResults || []) {
    if (row.kpiType === 'Voice Jr TSR') {
      voice.push({employeeName: row.employeeName, accepted: row.calls?.accepted ?? null, dailyAverage: row.calls?.dailyAverage ?? null, longCalls: row.calls?.longCalls ?? null, lcrRate: row.lcr?.rate ?? null});
    } else if (row.kpiType === 'Non-Voice Jr TSR') {
      nonVoice.push({employeeName: row.employeeName, solved: row.tickets?.solved ?? null, excluded: row.tickets?.excluded ?? null});
    } else if (row.kpiType === 'Senior TSR') {
      senior.push({employeeName: row.employeeName, updated: row.tickets?.unique ?? null, publicCount: row.tickets?.publicCount ?? null, internalCount: row.tickets?.internalCount ?? null, teamAvgBaseKpi: row.team?.average ?? null});
    } else if (row.kpiType === 'Database Agent') {
      database.push({employeeName: row.employeeName, leadImportCount: row.jiraLeadImport?.count ?? null, csatRate: row.csat?.rate ?? null, callsAccepted: row.calls?.accepted ?? null, callsDailyAverage: row.calls?.dailyAverage ?? null});
    }
  }
  return {voice, nonVoice, senior, database};
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

export async function draftAttendanceInsight(token, rows) {
  const fallback = attendanceFactSummary(rows);
  const prompt = `You are drafting one short sentence (max 2 sentences) for a Monthly Business Review slide about team attendance. Be direct and factual, no fluff, plain text only, no markdown, no preamble. Attendance detail this period: ${JSON.stringify(rows.map(r => ({employeeName: r.employeeName, attendancePct: r.attendancePct, absenceDays: r.absenceDays, ptoDays: r.ptoDays, reason: r.absenceReason})))}.`;
  const context = {attendanceRows: rows};
  return draftText(token, prompt, fallback, context);
}

export async function draftProductivityInsight(token, {voice, nonVoice, senior, database}) {
  const totalCalls = sumBy(voice, v => v.accepted);
  const totalLongCalls = sumBy(voice, v => v.longCalls);
  const totalSolved = sumBy(nonVoice, v => v.solved);
  const outlier = lcrOutlierNote(voice);
  const fallback = [
    `The team handled ${totalCalls} call(s)${totalLongCalls ? ` (${totalLongCalls} running 30+ minutes)` : ''} and solved ${totalSolved} ticket(s) this period.`,
    outlier || ''
  ].filter(Boolean).join(' ');
  const prompt = `You are drafting one to two short sentences for a Monthly Business Review slide about team productivity and call/ticket volume. Be direct and factual, no fluff, plain text only, no markdown, no preamble. Voice call volume: ${JSON.stringify(voice)}. Non-Voice ticket volume: ${JSON.stringify(nonVoice)}. Senior TSR: ${JSON.stringify(senior)}. Database Agent: ${JSON.stringify(database)}.`;
  const context = {voice, nonVoice, senior, database};
  return draftText(token, prompt, fallback, context);
}

export async function draftCoachingInsight(token, {inPeriod, inProgress}) {
  const fallback = [
    inPeriod.length ? `${inPeriod.length} coaching session(s) logged this period.` : 'No coaching sessions were logged this period.',
    inProgress.length ? `${inProgress.length} follow-up(s) currently in progress.` : ''
  ].filter(Boolean).join(' ');
  const prompt = `You are drafting one short sentence (max 2 sentences) for a Monthly Business Review slide about coaching sessions. Be direct and factual, no fluff, plain text only, no markdown, no preamble. Coaching sessions logged this period: ${JSON.stringify(inPeriod.map(r => ({employeeName: r.employeeName, category: r.category, status: r.status})))}. Follow-ups in progress: ${JSON.stringify(inProgress.map(r => ({employeeName: r.employeeName, category: r.category})))}.`;
  const context = {inPeriod, inProgress};
  return draftText(token, prompt, fallback, context);
}

// Deterministic Service Recovery fact summary - also the fallback for the drafted insight below.
// "Contacted"/"customer responded" are both computed server-side from the ticket's own Zendesk
// audit trail (a public reply from a Team Lead or Senior TSR after the survey, then one from the customer
// after that), not TL-entered, so this is purely reporting on numbers already resolved upstream.
function serviceRecoveryFactSummary(tickets) {
  const total = tickets.length;
  if (!total) return 'No bad CSATs were logged for this team this period.';
  const within24h = tickets.filter(t => t.contactedWithin24h).length;
  const overdue = tickets.filter(t => !t.contactedAt).length;
  const recovered = tickets.filter(t => t.customerResponded).length;
  return `${within24h} of ${total} bad CSAT(s) were contacted within 24 hours this period.${overdue ? ` ${overdue} still have no recorded contact.` : ''}${recovered ? ` ${recovered} customer(s) responded back after being contacted.` : ''}`;
}
export async function draftServiceRecoveryInsight(token, tickets) {
  const fallback = serviceRecoveryFactSummary(tickets);
  if (!tickets.length) return fallback;
  const prompt = `You are drafting one to two short sentences for a Monthly Business Review slide about Service Recovery - following up on bad CSAT ratings within 24 hours. Be direct and factual, no fluff, plain text only, no markdown, no preamble. Bad CSAT follow-up detail this period: ${JSON.stringify(tickets.map(t => ({employeeName: t.employeeName, surveyDate: t.surveyDate, contactedAt: t.contactedAt, contactedWithin24h: t.contactedWithin24h, customerResponded: t.customerResponded})))}.`;
  const context = {serviceRecoveryTickets: tickets};
  return draftText(token, prompt, fallback, context);
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

// Performance tier -> chart color: mirrors the same good/bad semantic mapping dataTable() already
// uses for the statusCol text coloring elsewhere in this deck, so a tier reads the same color
// whether it's a table cell or a chart slice.
const TIER_CHART_COLORS = {Exceptional: '19AB63', Exceeds: '8BC34A', Meets: '3B5CDF', Intervention: 'C2313A'};

function teamSnapshotSlide(pres, {teamResults, attendanceRows, csatTable, coachingCount}, pageNum) {
  const slide = sectionHeaderSlide(pres, {title: 'Team Snapshot', subtitle: 'Performance and CSAT at a glance'});
  const stats = teamHeadlineStats(teamResults, attendanceRows, csatTable);
  dataTable(slide, {
    headRow: ['Team Avg KPI', 'Attendance %', 'CSAT Rate', 'Coaching Sessions'],
    rows: [[fmtStatNumber(stats.avgFinalKpi), fmtStatPct(stats.avgAttendancePct), fmtStatPct(stats.overallCsatRate), String(coachingCount)]],
    x: 0.6, y: 1.85, w: 12.1, colW: [3.025, 3.025, 3.025, 3.025]
  });

  const tierCounts = {};
  for (const r of teamResults) tierCounts[r.performanceStatus || 'Not Rated'] = (tierCounts[r.performanceStatus || 'Not Rated'] || 0) + 1;
  const tierLabels = Object.keys(tierCounts);
  slide.addText('PERFORMANCE TIER DISTRIBUTION', {x: 0.6, y: 2.65, w: 5.6, h: 0.3, fontFace: FONT, fontSize: 11, bold: true, color: P.accent});
  slide.addChart('pie', [{name: 'Team', labels: tierLabels, values: tierLabels.map(l => tierCounts[l])}], {
    x: 0.6, y: 3.0, w: 5.6, h: 3.6,
    chartColors: tierLabels.map(l => TIER_CHART_COLORS[l] || P.muted),
    showTitle: false, showLegend: true, legendPos: 'b', showValue: true,
    dataLabelColor: P.white, dataLabelFontSize: 11, dataLabelPosition: 'ctr', dataLabelFormatCode: '0'
  });

  slide.addText('CSAT — GOOD VS. BAD', {x: 6.9, y: 2.65, w: 5.6, h: 0.3, fontFace: FONT, fontSize: 11, bold: true, color: P.good});
  slide.addChart('doughnut', [{name: 'CSAT', labels: ['Good', 'Bad'], values: [stats.totalGood, stats.totalBad]}], {
    x: 6.9, y: 3.0, w: 5.6, h: 3.6,
    chartColors: [P.good, P.bad],
    showTitle: false, showLegend: true, legendPos: 'b', showValue: true,
    dataLabelColor: P.white, dataLabelFontSize: 11, dataLabelPosition: 'ctr', dataLabelFormatCode: '0'
  });
  addFooter(slide, pageNum);
}

function kpiBarChartSlide(pres, {teamResults}, pageNum) {
  const slide = sectionHeaderSlide(pres, {title: 'Final KPI by Employee', subtitle: 'Team performance this period'});
  const rows = teamResults.filter(r => r.finalKpi != null && Number.isFinite(+r.finalKpi));
  slide.addChart('bar', [{name: 'Final KPI', labels: rows.map(r => r.employeeName), values: rows.map(r => Number(r.finalKpi))}], {
    x: 0.6, y: 1.9, w: 12.1, h: 5.0, barDir: 'bar',
    chartColors: [P.accent],
    showTitle: false, showLegend: false, showValue: true, dataLabelPosition: 'outEnd', dataLabelColor: P.ink, dataLabelFontSize: 10,
    catAxisLabelColor: P.ink, catAxisLabelFontSize: 10, valAxisLabelColor: P.muted,
    valGridLine: {color: 'DFE2EA', size: 0.75}, catGridLine: {style: 'none'}
  });
  addFooter(slide, pageNum);
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

function productivitySlide(pres, {voice, nonVoice, senior, database, insight}, pageNum) {
  const slide = sectionHeaderSlide(pres, {eyebrow: 'Section 2', title: 'Productivity', subtitle: 'Volume handled by role type'});
  let y = 1.9;
  if (voice.length) {
    slide.addText('VOICE JR TSR', {x: 0.6, y, w: 6, h: 0.3, fontFace: FONT, fontSize: 11, bold: true, color: P.accent});
    dataTable(slide, {headRow: ['Employee', 'Accepted Calls', 'Daily Avg', 'Long Calls', 'LCR %'], rows: voice.map(v => [v.employeeName, v.accepted, v.dailyAverage == null ? '—' : roundTo(v.dailyAverage, 2), v.longCalls, v.lcrRate == null ? '—' : `${roundTo(v.lcrRate, 2)}%`]), x: 0.6, y: y + 0.3, w: 6, colW: [2, 1.2, 0.9, 1, 0.9]});
    y += 0.3 + 0.35 * (voice.length + 1) + 0.25;
  }
  if (nonVoice.length) {
    slide.addText('NON-VOICE JR TSR', {x: 0.6, y, w: 6, h: 0.3, fontFace: FONT, fontSize: 11, bold: true, color: P.accent});
    dataTable(slide, {headRow: ['Employee', 'Tickets Solved', 'Excluded'], rows: nonVoice.map(v => [v.employeeName, v.solved, v.excluded]), x: 0.6, y: y + 0.3, w: 6, colW: [2.8, 1.8, 1.4]});
  }
  let yRight = 1.9;
  if (senior.length) {
    slide.addText('SENIOR TSR', {x: 6.9, y: yRight, w: 5.8, h: 0.3, fontFace: FONT, fontSize: 11, bold: true, color: P.accent});
    dataTable(slide, {headRow: ['Employee', 'Updated', 'Public', 'Internal', 'Team Avg Base KPI'], rows: senior.map(v => [v.employeeName, v.updated, v.publicCount, v.internalCount, v.teamAvgBaseKpi == null ? '—' : roundTo(v.teamAvgBaseKpi, 2)]), x: 6.9, y: yRight + 0.3, w: 5.8, colW: [2, 0.9, 0.9, 0.9, 1.1]});
    yRight += 0.3 + 0.35 * (senior.length + 1) + 0.25;
  }
  if (database.length) {
    slide.addText('DATABASE AGENT', {x: 6.9, y: yRight, w: 5.8, h: 0.3, fontFace: FONT, fontSize: 11, bold: true, color: P.accent});
    dataTable(slide, {headRow: ['Employee', 'Lead Import', 'CSAT %', 'Calls', 'Daily Avg'], rows: database.map(v => [v.employeeName, v.leadImportCount, v.csatRate == null ? '—' : `${roundTo(v.csatRate, 2)}%`, v.callsAccepted, v.callsDailyAverage == null ? '—' : roundTo(v.callsDailyAverage, 2)]), x: 6.9, y: yRight + 0.3, w: 5.8, colW: [2, 1.1, 1, 0.9, 0.8]});
  }
  insightCallout(slide, insight, 6.15);
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

// "Contacted" and "customer responded" both come pre-computed from zendesk-proxy.js scanning
// each ticket's own Zendesk audit trail (a public reply from a Team Lead or Senior TSR after the survey, then
// one from the customer after that) - nothing here is TL-entered, so this slide is purely
// presentational over server-computed fields.
function serviceRecoverySlide(pres, {tickets, insight}, pageNum) {
  const total = tickets.length;
  const within24h = tickets.filter(t => t.contactedWithin24h).length;
  const recovered7d = tickets.filter(t => t.recoveredWithin7d).length;
  const responded = tickets.filter(t => t.customerResponded).length;
  const slide = sectionHeaderSlide(pres, {eyebrow: 'Section 3b', title: 'Service Recovery', subtitle: `${total} bad CSAT(s) needing follow-up this period`});
  dataTable(slide, {
    headRow: ['Bad CSATs', 'Contacted Within 24h', '7d Bad→Good', 'Customer Responded'],
    rows: [[total, `${within24h}/${total || 0}`, `${recovered7d}/${total || 0}`, `${responded}/${total || 0}`]],
    x: 0.6, y: 1.85, w: 12.1, colW: [3.025, 3.025, 3.025, 3.025]
  });
  if (total) {
    dataTable(slide, {
      headRow: ['Employee', 'Survey Date', 'Status', 'Ticket'],
      rows: tickets.slice(0, 8).map(t => [t.employeeName, shortDate(t.surveyDate), t.customerResponded ? 'Recovered' : t.contactedAt ? (t.contactedWithin24h ? 'Contacted On Time' : 'Contacted Late') : 'Awaiting Contact', `#${t.ticketId ?? '—'}`]),
      x: 0.6, y: 2.65, w: 12.1, colW: [3.5, 2, 4, 2.6], statusCol: 2
    });
  }
  insightCallout(slide, insight, 6.15);
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

function attendanceChartSlide(pres, {rows}, pageNum) {
  const slide = sectionHeaderSlide(pres, {eyebrow: 'Section 1', title: 'Attendance % by Employee', subtitle: 'Present days ÷ (Scheduled − PTO) this period'});
  const withPct = rows.filter(r => r.attendancePct != null);
  if (withPct.length) {
    slide.addChart('bar', [{name: 'Attendance %', labels: withPct.map(r => r.employeeName), values: withPct.map(r => r.attendancePct)}], {
      x: 0.6, y: 1.9, w: 12.1, h: 4.9, barDir: 'bar',
      chartColors: [P.accent],
      showTitle: false, showLegend: false, showValue: true, dataLabelPosition: 'outEnd', dataLabelColor: P.ink, dataLabelFontSize: 10, dataLabelFormatCode: '0"%"',
      catAxisLabelColor: P.ink, catAxisLabelFontSize: 10, valAxisLabelColor: P.muted, valAxisMaxVal: 100, valAxisMinVal: 0,
      valGridLine: {color: 'DFE2EA', size: 0.75}, catGridLine: {style: 'none'}
    });
  } else {
    slide.addText('No attendance percentages could be computed this period.', {x: 0.6, y: 2.5, w: 12.1, h: 0.5, fontFace: FONT, fontSize: 14, color: P.muted, italic: true});
  }
  addFooter(slide, pageNum);
}

function productivityChartSlide(pres, {voice, nonVoice}, pageNum) {
  const slide = sectionHeaderSlide(pres, {eyebrow: 'Section 2', title: 'Volume Handled by Employee', subtitle: 'Accepted calls and tickets solved this period'});
  const hasVoice = voice.length > 0, hasNonVoice = nonVoice.length > 0;
  if (hasVoice) {
    slide.addText('ACCEPTED CALLS — VOICE JR TSR', {x: 0.6, y: 1.85, w: 5.8, h: 0.3, fontFace: FONT, fontSize: 11, bold: true, color: P.accent});
    slide.addChart('bar', [{name: 'Accepted Calls', labels: voice.map(v => v.employeeName), values: voice.map(v => v.accepted ?? 0)}], {
      x: 0.6, y: 2.15, w: hasNonVoice ? 5.8 : 12.1, h: 4.6, barDir: 'bar',
      chartColors: [P.accent], showTitle: false, showLegend: false, showValue: true, dataLabelPosition: 'outEnd', dataLabelColor: P.ink, dataLabelFontSize: 10,
      catAxisLabelColor: P.ink, catAxisLabelFontSize: 10, valAxisLabelColor: P.muted,
      valGridLine: {color: 'DFE2EA', size: 0.75}, catGridLine: {style: 'none'}
    });
  }
  if (hasNonVoice) {
    const x = hasVoice ? 6.9 : 0.6, w = hasVoice ? 5.8 : 12.1;
    slide.addText('TICKETS SOLVED — NON-VOICE JR TSR', {x, y: 1.85, w, h: 0.3, fontFace: FONT, fontSize: 11, bold: true, color: P.accentSecondary});
    slide.addChart('bar', [{name: 'Tickets Solved', labels: nonVoice.map(v => v.employeeName), values: nonVoice.map(v => v.solved ?? 0)}], {
      x, y: 2.15, w, h: 4.6, barDir: 'bar',
      chartColors: [P.accentSecondary], showTitle: false, showLegend: false, showValue: true, dataLabelPosition: 'outEnd', dataLabelColor: P.ink, dataLabelFontSize: 10,
      catAxisLabelColor: P.ink, catAxisLabelFontSize: 10, valAxisLabelColor: P.muted,
      valGridLine: {color: 'DFE2EA', size: 0.75}, catGridLine: {style: 'none'}
    });
  }
  if (!hasVoice && !hasNonVoice) {
    slide.addText('No Voice or Non-Voice call/ticket volume to chart this period.', {x: 0.6, y: 2.5, w: 12.1, h: 0.5, fontFace: FONT, fontSize: 14, color: P.muted, italic: true});
  }
  addFooter(slide, pageNum);
}

function coachingChartSlide(pres, {inPeriod}, pageNum) {
  const slide = sectionHeaderSlide(pres, {eyebrow: 'Section 4', title: 'Coaching by Category', subtitle: inPeriod.length ? 'Distribution of coaching sessions logged this period' : 'No coaching sessions were logged this period.'});
  if (inPeriod.length) {
    const counts = {};
    for (const r of inPeriod) counts[r.category || 'Uncategorized'] = (counts[r.category || 'Uncategorized'] || 0) + 1;
    const labels = Object.keys(counts);
    const palette = [P.accent, P.accentSecondary, P.good, P.bad, P.goodLight, P.muted];
    slide.addChart('pie', [{name: 'Coaching Sessions', labels, values: labels.map(l => counts[l])}], {
      x: 3.67, y: 1.9, w: 6, h: 4.9,
      chartColors: labels.map((l, i) => palette[i % palette.length]),
      showTitle: false, showLegend: true, legendPos: 'b', showValue: true,
      dataLabelColor: P.white, dataLabelFontSize: 11, dataLabelPosition: 'ctr', dataLabelFormatCode: '0'
    });
  } else {
    slide.addText('No coaching sessions were logged this period.', {x: 0.6, y: 2.5, w: 12.1, h: 0.5, fontFace: FONT, fontSize: 14, color: P.muted, italic: true});
  }
  addFooter(slide, pageNum);
}

function definitionsSlide(pres, pageNum) {
  const slide = sectionHeaderSlide(pres, {eyebrow: 'Reference', title: 'Definitions & Methodology', subtitle: 'How the figures in this report are calculated'});
  const defs = [
    ['Final KPI', 'Weighted blend of an employee’s role-specific metrics (calls/tickets handled, CSAT, quality) into one score, per the KPI configuration for their role.'],
    ['Attendance %', 'Present days ÷ (Scheduled days − PTO days). PTO is authorized leave and is excluded from both the numerator and the denominator so it never counts against attendance.'],
    ['CSAT Rate', 'Good survey responses ÷ (Good + Bad survey responses) this period, per employee or team-wide.'],
    ['LCR (Long Call Rate)', 'Accepted calls running 30+ minutes ÷ total accepted calls, per employee.'],
    ['Performance Tier', 'Exceptional / Exceeds / Meets / Intervention, derived from Final KPI against the role’s tier thresholds.'],
    ['Coaching Session', 'A logged 1:1 coaching record tied to a specific category and date; "in progress" means a follow-up date beyond this reporting period.'],
    ['Service Recovery', 'A bad CSAT is "Contacted" once that employee\'s own Team Lead or assigned Senior TSR posts a public reply on the ticket after the survey (detected from Zendesk\'s own audit trail, not manually entered); "Recovered" means the customer replied back after that.']
  ];
  let y = 1.95;
  for (const [term, def] of defs) {
    slide.addText(term, {x: 0.6, y, w: 3.2, h: 0.6, fontFace: FONT, fontSize: 12, bold: true, color: P.accent, valign: 'top'});
    slide.addText(def, {x: 4, y, w: 8.7, h: 0.6, fontFace: FONT, fontSize: 11, color: P.ink, valign: 'top'});
    y += 0.7;
  }
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

// Shared by both the PPTX deck and the PDF executive report - the aggregation is identical
// either way, only the rendering (and which narrative gets drafted on top of it) differs.
// Computing this once and handing both renderers the same object keeps them from ever quietly
// drifting apart the way the two scheduleForDate() copies and the two attendance-% formulas did
// elsewhere in this codebase. Deliberately does NOT draft any AI narrative itself - the PPTX and
// PDF want different narrative shapes (a couple of slide captions vs. a full multi-section
// report), so each caller drafts only what it actually renders instead of paying for AI calls
// whose output would go unused.
function gatherMbrAggregates({teamResults, month, teamAttendanceMembers, coachingRecords, notifications}) {
  const attendanceRows = (teamAttendanceMembers || []).map(m => aggregateMemberAttendance(m, month));
  const {voice, nonVoice, senior, database} = productivityGroups(teamResults);
  const csatTable = csatRows(teamResults);
  const badDetail = csatBadDetail(teamResults);
  const goodHighlights = csatGoodHighlights(teamResults);
  const goodCounts = csatGoodCounts(teamResults);
  const totalGood = goodCounts.reduce((s, r) => s + r.good, 0);
  const {inPeriod, inProgress} = coachingSections(coachingRecords, month);
  const {evaluations, anniversaries} = pendingReminders(notifications);
  const coachingFactSummary = [
    inPeriod.length ? `${inPeriod.length} coaching session(s) logged this period.` : 'No coaching sessions were logged this period.',
    inProgress.length ? `${inProgress.length} of ${teamResults.length} team member(s) already have coaching sessions in progress.` : ''
  ].filter(Boolean).join(' ');

  return {
    attendanceRows, voice, nonVoice, senior, database, csatTable, badDetail, goodHighlights, goodCounts, totalGood,
    inPeriod, inProgress, evaluations, anniversaries, coachingFactSummary
  };
}

/**
 * Builds and downloads the MBR deck in the browser. All inputs are already-fetched API
 * responses / already-aggregated data - this function does not fetch anything itself.
 */
export async function generateMbrDeck({leaderName, month, teamResults, teamAttendanceMembers, coachingRecords, notifications, serviceRecoveryTickets, copilotToken}) {
  const d = gatherMbrAggregates({teamResults, month, teamAttendanceMembers, coachingRecords, notifications});
  const srTickets = serviceRecoveryTickets || [];
  const [teamInsight, csatInsight, wrapUp, attendanceInsight, productivityInsight, coachingInsight, serviceRecoveryInsight] = await Promise.all([
    draftTeamOverviewInsight(copilotToken, teamResults),
    draftCsatInsight(copilotToken, d.badDetail, teamResults.length),
    draftWrapUp(copilotToken, {teamResults, csatBad: d.badDetail, coachingInProgress: d.inProgress}),
    draftAttendanceInsight(copilotToken, d.attendanceRows),
    draftProductivityInsight(copilotToken, {voice: d.voice, nonVoice: d.nonVoice, senior: d.senior, database: d.database}),
    draftCoachingInsight(copilotToken, {inPeriod: d.inPeriod, inProgress: d.inProgress}),
    draftServiceRecoveryInsight(copilotToken, srTickets)
  ]);
  d.teamInsight = teamInsight; d.csatInsight = csatInsight; d.wrapUp = wrapUp;

  const pres = newDeck();
  const monthText = monthLabel(month);
  const sections = ['Team Snapshot', 'Attendance', 'Productivity', 'CSAT', 'Service Recovery', 'Coaching', 'Definitions', 'Pending & Reminders'];
  titleSlide(pres, {leaderName, monthText, sections});
  teamSnapshotSlide(pres, {teamResults, attendanceRows: d.attendanceRows, csatTable: d.csatTable, coachingCount: d.inPeriod.length}, 2);
  kpiBarChartSlide(pres, {teamResults}, 3);
  teamOverviewSlide(pres, {teamResults, insight: d.teamInsight}, 4);
  attendanceSlide(pres, {rows: d.attendanceRows, factSummary: attendanceInsight}, 5);
  attendanceChartSlide(pres, {rows: d.attendanceRows}, 6);
  productivitySlide(pres, {voice: d.voice, nonVoice: d.nonVoice, senior: d.senior, database: d.database, insight: productivityInsight}, 7);
  productivityChartSlide(pres, {voice: d.voice, nonVoice: d.nonVoice}, 8);
  csatBadSlide(pres, {rows: d.csatTable, badDetail: d.badDetail, insight: d.csatInsight}, 9);
  csatGoodSlide(pres, {goodCounts: d.goodCounts, highlights: d.goodHighlights, totalGood: d.totalGood}, 10);
  serviceRecoverySlide(pres, {tickets: srTickets, insight: serviceRecoveryInsight}, 11);
  coachingSlide(pres, {inPeriod: d.inPeriod, inProgress: d.inProgress, factSummary: coachingInsight}, 12);
  coachingChartSlide(pres, {inPeriod: d.inPeriod}, 13);
  definitionsSlide(pres, 14);
  remindersSlide(pres, {evaluations: d.evaluations, anniversaries: d.anniversaries}, 15);
  wrapUpSlide(pres, d.wrapUp, 16);

  const fileName = `MBR - Team ${leaderName} - ${monthText}.pptx`;
  await pres.writeFile({fileName});
  return fileName;
}

// --- Executive Summary (PDF) -------------------------------------------------------------
// A condensed 1-2 page brief for forwarding, not a print of the slide deck - headline numbers
// plus the same Copilot/Groq-drafted narrative the deck uses, rather than every detail table.
function hexToRgb(hex) {
  const n = parseInt(hex, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function fmtStatNumber(v, decimals = 1) { return v == null ? '—' : String(roundTo(v, decimals)); }
function fmtStatPct(v, decimals = 1) { return v == null ? '—' : `${roundTo(v, decimals)}%`; }

function teamHeadlineStats(teamResults, attendanceRows, csatTable) {
  const validKpi = (teamResults || []).filter(r => r.finalKpi != null && Number.isFinite(+r.finalKpi));
  const avgFinalKpi = validKpi.length ? validKpi.reduce((s, r) => s + Number(r.finalKpi), 0) / validKpi.length : null;
  const attendancePcts = (attendanceRows || []).filter(r => r.attendancePct != null).map(r => r.attendancePct);
  const avgAttendancePct = attendancePcts.length ? attendancePcts.reduce((s, v) => s + v, 0) / attendancePcts.length : null;
  const totalGood = (csatTable || []).reduce((s, r) => s + (r.good || 0), 0);
  const totalBad = (csatTable || []).reduce((s, r) => s + (r.bad || 0), 0);
  const overallCsatRate = (totalGood + totalBad) ? totalGood / (totalGood + totalBad) * 100 : null;
  return {avgFinalKpi, avgAttendancePct, overallCsatRate, totalGood, totalBad};
}

function loadImageAsDataUrl(url) {
  return fetch(url).then(res => {
    if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
    return res.blob();
  }).then(blob => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Could not read image.'));
    reader.readAsDataURL(blob);
  }));
}
// jsPDF's addImage() embeds a PNG as a raw, uncompressed bitmap (no Filter at all) rather than
// re-compressing it - the source logo file is 1368x448px for crisp on-screen use elsewhere in
// the portal, but embedded at that resolution for a logo that prints at 0.34in tall it alone
// blew the PDF up to ~2.4MB (1368*448*3 bytes of raw RGB, confirmed via the PDF's own XObject
// dict). Downscaling to a realistic print resolution first keeps the same crispness at actual
// output size while cutting the embedded bitmap down by roughly (targetHeightPx/448)^2.
function loadLogoDataUrl(url, targetHeightPx) {
  return loadImageAsDataUrl(url).then(dataUrl => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = targetHeightPx / img.naturalHeight;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = targetHeightPx;
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve({dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height});
    };
    img.onerror = () => reject(new Error('Could not resize the logo image.'));
    img.src = dataUrl;
  }));
}

// jsPDF has no native chart support, unlike pptxgenjs - these are hand-drawn on an offscreen
// <canvas> via the Canvas 2D API and embedded as PNG images via doc.addImage(), so the PDF gets
// the same chart set the PPTX deck renders natively. Each helper burns its own legend/labels
// directly into the bitmap (canvas text, not PDF text) so the caller only needs one addImage()
// call per chart instead of hand-laying-out a separate legend in PDF coordinates.
function drawPieChartDataUrl(segments, {size = 420, colors = []} = {}) {
  const rowH = 30, legendH = segments.length * rowH + 16;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size + legendH;
  const ctx = canvas.getContext('2d');
  const total = segments.reduce((s, seg) => s + seg.value, 0);
  const cx = size / 2, cy = size / 2, r = size / 2 - 10;
  let angle = -Math.PI / 2;
  segments.forEach((seg, i) => {
    const slice = total ? (seg.value / total) * Math.PI * 2 : Math.PI * 2 / segments.length;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, angle, angle + slice);
    ctx.closePath();
    ctx.fillStyle = `#${colors[i] || '999999'}`;
    ctx.fill();
    angle += slice;
  });
  ctx.font = '600 20px Arial, sans-serif';
  ctx.textBaseline = 'middle';
  segments.forEach((seg, i) => {
    const ly = size + 16 + i * rowH + rowH / 2;
    ctx.fillStyle = `#${colors[i] || '999999'}`;
    ctx.fillRect(0, ly - 9, 18, 18);
    ctx.fillStyle = '#1B1F2A';
    ctx.textAlign = 'left';
    ctx.fillText(`${seg.label} (${seg.value})`, 26, ly);
  });
  return {dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height};
}

function drawBarChartDataUrl(items, {color = '3B5CDF', width = 900, valueSuffix = ''} = {}) {
  const rowH = 46, padTop = 10, padBottom = 10, padRight = 80;
  const canvas = document.createElement('canvas');
  const measureCtx = canvas.getContext('2d');
  measureCtx.font = '600 22px Arial, sans-serif';
  const labelW = Math.max(20, ...items.map(it => measureCtx.measureText(it.label).width)) + 20;
  canvas.width = width;
  canvas.height = padTop + padBottom + rowH * Math.max(1, items.length);
  const ctx = canvas.getContext('2d');
  ctx.font = '600 22px Arial, sans-serif';
  ctx.textBaseline = 'middle';
  const max = Math.max(1, ...items.map(it => it.value || 0));
  const chartX = labelW, chartW = width - labelW - padRight;
  items.forEach((it, i) => {
    const y = padTop + i * rowH, barH = rowH * 0.55, by = y + (rowH - barH) / 2;
    ctx.fillStyle = '#1B1F2A';
    ctx.textAlign = 'right';
    ctx.fillText(it.label, chartX - 12, y + rowH / 2);
    const barW = chartW * ((it.value || 0) / max);
    ctx.fillStyle = `#${color}`;
    ctx.fillRect(chartX, by, Math.max(barW, 1), barH);
    ctx.fillStyle = '#1B1F2A';
    ctx.textAlign = 'left';
    ctx.fillText(`${it.value ?? '—'}${valueSuffix}`, chartX + barW + 10, y + rowH / 2);
  });
  return {dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height};
}

// No ticket in this data model carries a formal "escalated" flag or a call-reason/disposition
// code (confirmed by reading collectMetricSummaries in zendesk-proxy.js - it only ever counts
// accepted/long calls, never categorizes why a call happened or ran long). Rather than invent
// categories the underlying data can't support, this callout surfaces the one genuine, factual
// signal that IS available: which rep's Long Call Rate is the outlier, and by how much.
function lcrOutlierNote(voice) {
  const withLcr = (voice || []).filter(v => v.lcrRate != null);
  if (withLcr.length < 2) return null;
  const avg = withLcr.reduce((s, v) => s + v.lcrRate, 0) / withLcr.length;
  const top = [...withLcr].sort((a, b) => b.lcrRate - a.lcrRate)[0];
  if (top.lcrRate <= avg * 1.15) return null;
  return `${top.employeeName} has the team's highest Long Call Rate this period at ${roundTo(top.lcrRate, 1)}% (${top.longCalls} of ${top.accepted} accepted calls ran 30+ minutes), versus a team average of ${roundTo(avg, 1)}% - worth a coaching conversation on call efficiency.`;
}

function sumBy(arr, fn) { return (arr || []).reduce((s, x) => s + (Number(fn(x)) || 0), 0); }
function stringField(value, fallback) { return typeof value === 'string' && value.trim() ? value.trim() : fallback; }

// Deterministic, data-only version of every report section - used verbatim when Copilot isn't
// connected, and as the fallback for any individual section Copilot/Groq fails to produce. Every
// number here traces directly to an aggregate already computed above; nothing is inferred.
function executiveReportFallback({leaderName, teamResults, attendanceRows, stats, voice, nonVoice, badDetail, inPeriod, inProgress, evaluations}) {
  const teamSize = teamResults.length;
  const tierCounts = {};
  for (const r of teamResults) tierCounts[r.performanceStatus || 'Not Rated'] = (tierCounts[r.performanceStatus || 'Not Rated'] || 0) + 1;
  const tierText = Object.entries(tierCounts).map(([k, v]) => `${v} ${k}`).join(', ');
  const watchList = teamResults.filter(r => r.performanceStatus === 'Intervention').map(r => r.employeeName);
  const fullAttendanceCount = attendanceRows.filter(r => r.attendancePct != null && r.attendancePct >= 100).length;
  const withAbsence = attendanceRows.filter(r => r.absenceDays > 0);
  const totalCallsAccepted = sumBy(voice, v => v.accepted);
  const totalLongCalls = sumBy(voice, v => v.longCalls);
  const totalTicketsSolved = sumBy(nonVoice, v => v.solved);

  const risks = [
    watchList.length ? `${watchList.length} team member(s) are at Intervention-tier KPI and need continued coaching support: ${watchList.join(', ')}.` : '',
    badDetail.length ? `${badDetail.length} bad CSAT ticket(s) logged this period warrant follow-up.` : '',
    evaluations.length ? `${evaluations.length} evaluation(s) are due in the next 30 days.` : ''
  ].filter(Boolean).join(' ') || 'No significant risks were identified this period.';

  return {
    executiveSummary: `Team ${leaderName} closed the period with ${fmtStatPct(stats.avgAttendancePct)} average attendance and ${fmtStatPct(stats.overallCsatRate)} CSAT. The team handled ${totalCallsAccepted} call(s)${totalLongCalls ? ` (${totalLongCalls} running 30+ minutes)` : ' with no long calls'} and solved ${totalTicketsSolved} ticket(s) this period, with ${badDetail.length} bad CSAT ticket(s) logged team-wide.`,
    attendanceAndCoverage: `Average attendance was ${fmtStatPct(stats.avgAttendancePct)} across ${teamSize} team member(s), with ${fullAttendanceCount} at 100% attendance this period. ${withAbsence.length ? `${withAbsence.length} team member(s) had at least one absence day.` : 'No absences were recorded.'}`,
    teamMtdPerformance: `Team performance this period: ${tierText}.${watchList.length ? ` Needs attention: ${watchList.join(', ')}.` : ''} CSAT stands at ${fmtStatPct(stats.overallCsatRate)} (${stats.totalGood} Good, ${stats.totalBad} Bad).`,
    mtdOperations: `The team handled ${totalCallsAccepted} call(s) and solved ${totalTicketsSolved} ticket(s) this period.${totalLongCalls ? ` ${totalLongCalls} call(s) ran 30 minutes or longer.` : ''}`,
    keyRisksAndFollowUps: risks,
    leadershipActionsTaken: inPeriod.length ? `${inPeriod.length} coaching session(s) were logged this period${inProgress.length ? `, with ${inProgress.length} follow-up(s) currently in progress` : ''}.` : 'No additional manual leadership actions were logged this period beyond standard operational oversight.',
    nextPeriodPriorities: [
      badDetail.length ? `Follow up on the ${badDetail.length} bad CSAT ticket(s) logged this period.` : '',
      watchList.length ? `Continue coaching support for ${watchList.join(', ')}.` : '',
      evaluations.length ? `Complete the ${evaluations.length} evaluation(s) due in the next 30 days.` : '',
      'Maintain current CSAT and attendance performance.'
    ].filter(Boolean),
    overallAssessment: `Operations were ${watchList.length || badDetail.length ? 'broadly stable, with a few areas needing continued attention' : 'stable'} this period, with ${tierText} across the team and ${fmtStatPct(stats.overallCsatRate)} CSAT. ${risks === 'No significant risks were identified this period.' ? 'No significant risks were identified.' : 'Continued focus on the items above will help sustain service standards.'}`
  };
}

/**
 * Drafts the full 8-section Executive Report narrative in one Copilot call, then fact-checks the
 * whole thing in one Groq review pass against the full underlying dataset (same
 * draft-then-review pattern as the PPTX insights, just one combined document instead of three
 * separate lines - see /api/my/mbr-review-insight). Falls back to executiveReportFallback() at
 * both the "no Copilot" and "Copilot/Groq output didn't parse" points, so a report never ships
 * with a missing section.
 */
async function draftExecutiveReportSections(token, ctx) {
  const fallback = executiveReportFallback(ctx);
  if (!token) return fallback;
  const {leaderName, teamResults, attendanceRows, stats, voice, nonVoice, badDetail, goodHighlights, inPeriod, inProgress, evaluations, month} = ctx;
  const prompt = `You are drafting a Month-to-Date Executive Report for a BPO support team lead, in the style of a formal ops report (like a daily ops report, but summarizing the whole month so far). Reply with ONLY a JSON object, no other text and no markdown, in exactly this shape: {"executiveSummary":"...","attendanceAndCoverage":"...","teamMtdPerformance":"...","mtdOperations":"...","keyRisksAndFollowUps":"...","leadershipActionsTaken":"...","nextPeriodPriorities":["...","..."],"overallAssessment":"..."}. Each value except nextPeriodPriorities is a short paragraph (2-4 sentences), plain text, no markdown. nextPeriodPriorities is an array of 2-4 short bullet strings. Each value except nextPeriodPriorities should be 4-6 sentences of substantive, specific analysis (not 2-4) - name specific employees, specific numbers, and specific tickets/categories wherever the data supports it, the way a real ops leader writing for their own director would, not a generic summary. Base every claim strictly on the data below - never invent a number, a ticket topic, or an action the data doesn't support. This data has no ticket-escalation flag and no call-reason/disposition codes, so do not invent "escalated tickets" or "call driver categories" - if you reference call or ticket activity, stick to the actual counts given. If a category has nothing to report (e.g. no leadership actions, no risks), say so factually and plainly, the way a real ops report would ("No additional manual leadership actions were logged this period beyond standard oversight.") rather than inventing content.

DATA:
Team: ${leaderName}, ${teamResults.length} member(s), reporting month ${month}.
Team KPI results: ${JSON.stringify(teamResults.map(r => ({name: r.employeeName, kpiType: r.kpiType, tier: r.performanceStatus, finalKpi: r.finalKpi})))}.
Attendance: ${JSON.stringify(attendanceRows.map(r => ({name: r.employeeName, attendancePct: r.attendancePct, absenceDays: r.absenceDays, ptoDays: r.ptoDays, reason: r.absenceReason})))}.
CSAT: ${stats.totalGood} good, ${stats.totalBad} bad, overall rate ${stats.overallCsatRate}%.
Bad CSAT tickets: ${JSON.stringify(badDetail.map(t => ({employeeName: t.employeeName, subject: t.subject, comment: t.comment})))}.
Good CSAT highlights: ${JSON.stringify(goodHighlights.map(h => ({employeeName: h.employeeName, comment: h.comment})))}.
Voice call volume: ${JSON.stringify(voice.map(v => ({name: v.employeeName, accepted: v.accepted, longCalls: v.longCalls, lcrRate: v.lcrRate})))}.
Non-Voice ticket volume: ${JSON.stringify(nonVoice.map(v => ({name: v.employeeName, solved: v.solved, excluded: v.excluded})))}.
Coaching sessions logged this period: ${inPeriod.length}. Coaching follow-ups in progress: ${inProgress.length}.
Evaluations due in the next 30 days: ${evaluations.length}.`;
  let draft;
  try {
    const result = await copilotChat(token, prompt);
    const raw = copilotResponseText(result);
    const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw);
    draft = {
      executiveSummary: stringField(parsed.executiveSummary, fallback.executiveSummary),
      attendanceAndCoverage: stringField(parsed.attendanceAndCoverage, fallback.attendanceAndCoverage),
      teamMtdPerformance: stringField(parsed.teamMtdPerformance, fallback.teamMtdPerformance),
      mtdOperations: stringField(parsed.mtdOperations, fallback.mtdOperations),
      keyRisksAndFollowUps: stringField(parsed.keyRisksAndFollowUps, fallback.keyRisksAndFollowUps),
      leadershipActionsTaken: stringField(parsed.leadershipActionsTaken, fallback.leadershipActionsTaken),
      nextPeriodPriorities: stringBullets(parsed.nextPeriodPriorities, fallback.nextPeriodPriorities),
      overallAssessment: stringField(parsed.overallAssessment, fallback.overallAssessment)
    };
  } catch { return fallback; }

  const context = {
    teamPerformance: teamResults.map(r => ({name: r.employeeName, tier: r.performanceStatus, finalKpi: r.finalKpi})),
    attendanceRows, csat: {good: stats.totalGood, bad: stats.totalBad, rate: stats.overallCsatRate}, badDetail, voice, nonVoice,
    coachingSessionsLogged: inPeriod.length, coachingFollowUpsInProgress: inProgress.length, evaluationsDue: evaluations.length
  };
  const reviewedRaw = await reviewWithGroq(JSON.stringify(draft), context, 'json');
  try {
    const reviewedParsed = JSON.parse(reviewedRaw.match(/\{[\s\S]*\}/)?.[0] || reviewedRaw);
    return {
      executiveSummary: stringField(reviewedParsed.executiveSummary, draft.executiveSummary),
      attendanceAndCoverage: stringField(reviewedParsed.attendanceAndCoverage, draft.attendanceAndCoverage),
      teamMtdPerformance: stringField(reviewedParsed.teamMtdPerformance, draft.teamMtdPerformance),
      mtdOperations: stringField(reviewedParsed.mtdOperations, draft.mtdOperations),
      keyRisksAndFollowUps: stringField(reviewedParsed.keyRisksAndFollowUps, draft.keyRisksAndFollowUps),
      leadershipActionsTaken: stringField(reviewedParsed.leadershipActionsTaken, draft.leadershipActionsTaken),
      nextPeriodPriorities: stringBullets(reviewedParsed.nextPeriodPriorities, draft.nextPeriodPriorities),
      overallAssessment: stringField(reviewedParsed.overallAssessment, draft.overallAssessment)
    };
  } catch { return draft; }
}

/**
 * Builds and downloads a multi-page Executive Report PDF in the browser: a narrative
 * executive-report front section (headline stats + an 8-part Copilot/Groq-drafted MTD report,
 * modeled on a real daily-ops-report format) followed by the supporting per-employee detail
 * behind those numbers, rendered for print/forwarding instead of slides. All inputs are
 * already-fetched API responses / already-aggregated data - this function does not fetch
 * anything itself except the Lofty logo image.
 */
export async function generateExecutiveReportPdf({leaderName, month, teamResults, teamAttendanceMembers, coachingRecords, notifications, serviceRecoveryTickets, copilotToken}) {
  serviceRecoveryTickets = serviceRecoveryTickets || [];
  if (!window.jspdf?.jsPDF) throw new Error('jsPDF did not load - check shared/vendor/jspdf.umd.min.js.');
  const d = gatherMbrAggregates({teamResults, month, teamAttendanceMembers, coachingRecords, notifications});
  const stats = teamHeadlineStats(teamResults, d.attendanceRows, d.csatTable);
  const report = await draftExecutiveReportSections(copilotToken, {leaderName, month, teamResults, attendanceRows: d.attendanceRows, stats, voice: d.voice, nonVoice: d.nonVoice, badDetail: d.badDetail, goodHighlights: d.goodHighlights, inPeriod: d.inPeriod, inProgress: d.inProgress, evaluations: d.evaluations});
  const monthText = monthLabel(month);

  const doc = new window.jspdf.jsPDF({unit: 'in', format: 'letter'});
  const pageW = 8.5, pageH = 11, marginX = 0.65, marginBottom = 0.7, contentW = pageW - marginX * 2;
  let y = 0.6, pageNum = 1;

  function addFooter() {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...hexToRgb(P.muted));
    doc.text('Lofty Support · Executive Report', marginX, pageH - 0.4);
    doc.text(String(pageNum), pageW - marginX, pageH - 0.4, {align: 'right'});
  }
  // Returns true when a page break happened, so a table mid-render knows to redraw its header.
  function ensureRoom(height) {
    if (y + height > pageH - marginBottom) {
      addFooter();
      doc.addPage();
      pageNum++;
      y = 0.6;
      return true;
    }
    return false;
  }

  let logoH = 0;
  try {
    const logo = await loadLogoDataUrl('shared/img/lofty-logo.png', 120);
    logoH = 0.34;
    doc.addImage(logo.dataUrl, 'PNG', marginX, y, logoH * (logo.width / logo.height), logoH, undefined, 'MEDIUM');
  } catch { /* logo is a nice-to-have - a fetch hiccup shouldn't block the report */ }
  y += logoH ? logoH + 0.22 : 0;

  doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...hexToRgb(P.accent));
  doc.text('EXECUTIVE SUMMARY', marginX, y);
  y += 0.32;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(24); doc.setTextColor(...hexToRgb(P.ink));
  doc.text(`Team ${leaderName}`, marginX, y);
  y += 0.26;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(12); doc.setTextColor(...hexToRgb(P.muted));
  doc.text(`Performance Summary · ${monthText}`, marginX, y);
  y += 0.22;
  doc.setDrawColor(...hexToRgb('DFE2EA')); doc.setLineWidth(0.01);
  doc.line(marginX, y, pageW - marginX, y);
  y += 0.35;

  const tileGap = 0.25, tileW = (contentW - tileGap * 3) / 4, tileH = 1.0;
  const tiles = [
    {label: 'TEAM AVG KPI', value: fmtStatNumber(stats.avgFinalKpi)},
    {label: 'ATTENDANCE', value: fmtStatPct(stats.avgAttendancePct)},
    {label: 'CSAT RATE', value: fmtStatPct(stats.overallCsatRate)},
    {label: 'COACHING SESSIONS', value: String(d.inPeriod.length)}
  ];
  tiles.forEach((tile, i) => {
    const x = marginX + i * (tileW + tileGap), midX = x + tileW / 2;
    doc.setFillColor(...hexToRgb(P.lightBg));
    doc.roundedRect(x, y, tileW, tileH, 0.08, 0.08, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(22); doc.setTextColor(...hexToRgb(P.accent));
    doc.text(tile.value, midX, y + 0.55, {align: 'center'});
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(...hexToRgb(P.muted));
    doc.text(tile.label, midX, y + 0.82, {align: 'center'});
  });
  y += tileH + 0.4;

  function narrativeSection(title, body) {
    ensureRoom(0.55);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...hexToRgb(P.accent));
    doc.text(title, marginX, y);
    y += 0.24;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(11); doc.setTextColor(...hexToRgb(P.ink));
    const lines = doc.splitTextToSize(body, contentW);
    ensureRoom(lines.length * 0.2 + 0.1);
    doc.text(lines, marginX, y);
    y += lines.length * 0.2 + 0.3;
  }
  function bulletListSection(title, items, color) {
    ensureRoom(0.45);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...hexToRgb(color));
    doc.text(title, marginX, y);
    y += 0.26;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(11); doc.setTextColor(...hexToRgb(P.ink));
    for (const item of items) {
      const lines = doc.splitTextToSize(`•  ${item}`, contentW - 0.1);
      ensureRoom(lines.length * 0.2 + 0.08);
      doc.text(lines, marginX + 0.1, y);
      y += lines.length * 0.2 + 0.1;
    }
    y += 0.15;
  }
  // Mirrors a real daily/MTD ops report's structure: a lead paragraph, then attendance,
  // performance, operations, risks, leadership actions, forward priorities, and a closing
  // assessment - each grounded in the same aggregated data, drafted by Copilot and fact-checked
  // by Groq (or the deterministic fallback above if either is unavailable).
  narrativeSection('EXECUTIVE SUMMARY', report.executiveSummary);
  narrativeSection('ATTENDANCE AND COVERAGE', report.attendanceAndCoverage);
  narrativeSection('TEAM MTD PERFORMANCE', report.teamMtdPerformance);
  narrativeSection('MTD OPERATIONS', report.mtdOperations);
  narrativeSection('KEY RISKS AND FOLLOW-UPS', report.keyRisksAndFollowUps);
  narrativeSection('LEADERSHIP ACTIONS TAKEN', report.leadershipActionsTaken);
  bulletListSection('NEXT-PERIOD PRIORITIES', report.nextPeriodPriorities, P.accent);
  narrativeSection('OVERALL ASSESSMENT', report.overallAssessment);

  // --- Supporting detail: the per-employee evidence behind the headline numbers above ------
  ensureRoom(0.5);
  doc.setDrawColor(...hexToRgb('DFE2EA')); doc.setLineWidth(0.01);
  doc.line(marginX, y, pageW - marginX, y);
  y += 0.28;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...hexToRgb(P.accent));
  doc.text('SUPPORTING DETAIL', marginX, y);
  y += 0.32;

  function sectionHeading(title, subtitle) {
    ensureRoom(0.4);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.setTextColor(...hexToRgb(P.ink));
    doc.text(title, marginX, y);
    y += 0.24;
    if (subtitle) {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(...hexToRgb(P.muted));
      const lines = doc.splitTextToSize(subtitle, contentW);
      ensureRoom(lines.length * 0.16 + 0.1);
      doc.text(lines, marginX, y);
      y += lines.length * 0.16 + 0.14;
    } else y += 0.06;
  }
  // keepWithNext reserves room for the heading together with (an estimate of) whatever renders
  // right after it - without this, a heading can print as the last line on a page while its own
  // chart/table starts fresh on the next page, stranding it away from the content it labels.
  function subheading(title, color = P.accent, keepWithNext = 0) {
    ensureRoom(0.3 + keepWithNext);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...hexToRgb(color));
    doc.text(title, marginX, y);
    y += 0.22;
  }
  function pdfTable({colW, headRow, rows, fontSize = 9}) {
    const x = marginX, totalW = colW.reduce((a, b) => a + b, 0), lineH = fontSize / 72 * 1.15, cellPad = 0.06;
    function drawHeaderRow() {
      // A header label wider than its column (e.g. "Team Avg Base KPI" in 1.2in, "Absence
      // Reason" in 1.0in) used to just draw straight past the column - and since header text is
      // white-on-navy, whatever ran past the header bar's own right edge landed as white text on
      // the plain white page: invisible, not merely clipped. Wrapping headers the same way body
      // cells already wrap fixes it for any column width instead of hand-tuning each table.
      doc.setFont('helvetica', 'bold'); doc.setFontSize(fontSize);
      const headLines = headRow.map((label, i) => doc.splitTextToSize(String(label), colW[i] - cellPad * 2));
      const h = Math.max(1, ...headLines.map(l => l.length)) * lineH + cellPad * 2;
      doc.setFillColor(...hexToRgb(P.navyDeep));
      doc.rect(x, y, totalW, h, 'F');
      doc.setTextColor(...hexToRgb(P.white));
      let cx = x;
      headLines.forEach((lines, i) => { doc.text(lines, cx + cellPad, y + cellPad + lineH * 0.78); cx += colW[i]; });
      y += h;
    }
    ensureRoom(lineH + cellPad * 2 + 0.3);
    drawHeaderRow();
    rows.forEach((row, ri) => {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(fontSize);
      const cellLines = row.map((cell, i) => doc.splitTextToSize(cell == null ? '—' : String(cell), colW[i] - cellPad * 2));
      const rowH = Math.max(1, ...cellLines.map(l => l.length)) * lineH + cellPad * 2;
      if (ensureRoom(rowH)) drawHeaderRow();
      doc.setFillColor(...hexToRgb(ri % 2 ? P.lightBg : P.white));
      doc.rect(x, y, totalW, rowH, 'F');
      doc.setDrawColor(...hexToRgb('DFE2EA')); doc.setLineWidth(0.005);
      doc.rect(x, y, totalW, rowH, 'S');
      doc.setTextColor(...hexToRgb(P.ink));
      let cx = x;
      cellLines.forEach((lines, i) => { doc.text(lines, cx + cellPad, y + cellPad + lineH * 0.78); cx += colW[i]; });
      y += rowH;
    });
    y += 0.25;
  }
  // jsPDF has no native chart API - drawPieChartDataUrl()/drawBarChartDataUrl() hand-draw onto an
  // offscreen canvas and hand back a PNG plus its pixel dimensions, so this just scales to a
  // target width and preserves aspect ratio instead of guessing a height.
  function addChartImage(chart, targetW) {
    const h = targetW * (chart.height / chart.width);
    ensureRoom(h + 0.3);
    // jsPDF's addImage() writes PNGs as a raw, uncompressed bitmap by default (confirmed earlier
    // via the logo: 1368x448px raw RGB alone produced a 2.4MB PDF) - a compression argument
    // ('MEDIUM' here) makes it FlateEncode the pixel data instead, which is a huge win for these
    // chart PNGs specifically since they're mostly large flat-color regions (bars, pie slices).
    doc.addImage(chart.dataUrl, 'PNG', marginX, y, targetW, h, undefined, 'MEDIUM');
    y += h + 0.3;
  }

  sectionHeading('Team Overview', `${teamResults.length} active team member(s)`);
  pdfTable({
    colW: [2.2, 1.7, 1.5, 0.9, 0.9],
    headRow: ['Employee', 'KPI Type', 'Channel', 'Final KPI', 'Performance'],
    rows: teamResults.map(r => [r.employeeName, r.kpiType, r.primaryChannel, r.finalKpi == null ? '—' : r.finalKpi, r.performanceStatus || '—'])
  });
  {
    const tierCounts = {};
    for (const r of teamResults) tierCounts[r.performanceStatus || 'Not Rated'] = (tierCounts[r.performanceStatus || 'Not Rated'] || 0) + 1;
    const tierLabels = Object.keys(tierCounts);
    const tierPie = drawPieChartDataUrl(tierLabels.map(l => ({label: l, value: tierCounts[l]})), {colors: tierLabels.map(l => TIER_CHART_COLORS[l] || P.muted)});
    const csatPie = drawPieChartDataUrl([{label: 'Good', value: stats.totalGood}, {label: 'Bad', value: stats.totalBad}], {colors: [P.good, P.bad]});
    const chartW = (contentW - 0.4) / 2;
    const h = Math.max(chartW * (tierPie.height / tierPie.width), chartW * (csatPie.height / csatPie.width));
    subheading('PERFORMANCE & CSAT AT A GLANCE', P.accent, h);
    doc.addImage(tierPie.dataUrl, 'PNG', marginX, y, chartW, chartW * (tierPie.height / tierPie.width), undefined, 'MEDIUM');
    doc.addImage(csatPie.dataUrl, 'PNG', marginX + chartW + 0.4, y, chartW, chartW * (csatPie.height / csatPie.width), undefined, 'MEDIUM');
    y += h + 0.3;
  }

  sectionHeading('Productivity', 'Volume handled by role type - the detail behind each Final KPI above');
  if (d.voice.length || d.nonVoice.length) {
    if (d.voice.length) { const chart = drawBarChartDataUrl(d.voice.map(v => ({label: v.employeeName, value: v.accepted ?? 0})), {color: P.accent}); subheading('ACCEPTED CALLS — VOICE JR TSR', P.accent, contentW * (chart.height / chart.width)); addChartImage(chart, contentW); }
    if (d.nonVoice.length) { const chart = drawBarChartDataUrl(d.nonVoice.map(v => ({label: v.employeeName, value: v.solved ?? 0})), {color: P.accentSecondary}); subheading('TICKETS SOLVED — NON-VOICE JR TSR', P.accentSecondary, contentW * (chart.height / chart.width)); addChartImage(chart, contentW); }
  }
  if (d.voice.length) {
    subheading('VOICE JR TSR', P.accent, 0.35);
    pdfTable({colW: [2.4, 1.2, 1.1, 1.2, 1.3], headRow: ['Employee', 'Accepted Calls', 'Daily Avg', 'Long Calls', 'LCR %'],
      rows: d.voice.map(v => [v.employeeName, v.accepted, v.dailyAverage == null ? '—' : roundTo(v.dailyAverage, 2), v.longCalls, v.lcrRate == null ? '—' : `${roundTo(v.lcrRate, 2)}%`])});
    const note = lcrOutlierNote(d.voice);
    if (note) {
      doc.setFont('helvetica', 'italic'); doc.setFontSize(9.5); doc.setTextColor(...hexToRgb(P.bad));
      const lines = doc.splitTextToSize(note, contentW);
      ensureRoom(lines.length * 0.18 + 0.2);
      doc.text(lines, marginX, y);
      y += lines.length * 0.18 + 0.25;
    }
  }
  if (d.nonVoice.length) {
    subheading('NON-VOICE JR TSR', P.accent, 0.35);
    pdfTable({colW: [3.6, 2.0, 1.6], headRow: ['Employee', 'Tickets Solved', 'Excluded'], rows: d.nonVoice.map(v => [v.employeeName, v.solved, v.excluded])});
  }
  if (d.senior.length) {
    subheading('SENIOR TSR');
    pdfTable({colW: [2.4, 1.2, 1.2, 1.2, 1.2], headRow: ['Employee', 'Updated', 'Public', 'Internal', 'Team Avg Base KPI'],
      rows: d.senior.map(v => [v.employeeName, v.updated, v.publicCount, v.internalCount, v.teamAvgBaseKpi == null ? '—' : roundTo(v.teamAvgBaseKpi, 2)])});
  }
  if (d.database.length) {
    subheading('DATABASE AGENT');
    pdfTable({colW: [2.4, 1.4, 1.2, 1.1, 1.1], headRow: ['Employee', 'Lead Import', 'CSAT %', 'Calls', 'Daily Avg'],
      rows: d.database.map(v => [v.employeeName, v.leadImportCount, v.csatRate == null ? '—' : `${roundTo(v.csatRate, 2)}%`, v.callsAccepted, v.callsDailyAverage == null ? '—' : roundTo(v.callsDailyAverage, 2)])});
  }

  sectionHeading('CSAT — Investigation', `${d.badDetail.length} bad CSAT(s) logged team-wide this period`);
  if (d.badDetail.length) {
    subheading('BAD CSAT DETAIL — CUSTOMER COMMENTS', P.bad);
    pdfTable({colW: [1.6, 2.0, 0.8, 2.8], headRow: ['Employee', 'Ticket', 'Date', 'Customer Comment'],
      rows: d.badDetail.map(t => [t.employeeName, `#${t.ticketId ?? '—'} — ${truncate(t.subject, 45)}`, shortDate(t.surveyDate), truncate(t.comment, 260) || '—'])});
  }
  if (d.goodHighlights.length) {
    subheading('STANDOUT CUSTOMER COMMENTS', P.good);
    pdfTable({colW: [1.8, 0.9, 4.5], headRow: ['Employee', 'Date', 'Comment'],
      rows: d.goodHighlights.map(h => [h.employeeName, shortDate(h.surveyDate), `"${truncate(h.comment, 220)}"`])});
  }

  // "Contacted"/"customer responded" are both computed server-side from each ticket's own
  // Zendesk audit trail (a public reply from a Team Lead or Senior TSR after the survey, then one from the
  // customer after that) - nothing here is TL-entered, this section is purely reporting.
  sectionHeading('Service Recovery', serviceRecoveryFactSummary(serviceRecoveryTickets));
  if (serviceRecoveryTickets.length) {
    const srWithin24h = serviceRecoveryTickets.filter(t => t.contactedWithin24h).length;
    const srRecovered = serviceRecoveryTickets.filter(t => t.customerResponded).length;
    pdfTable({
      colW: [1.5, 1.5, 1.5, 1.5], headRow: ['Bad CSATs', 'Contacted Within 24h', '7d Bad→Good', 'Customer Responded'],
      rows: [[serviceRecoveryTickets.length, `${srWithin24h}/${serviceRecoveryTickets.length}`, `${serviceRecoveryTickets.filter(t => t.recoveredWithin7d).length}/${serviceRecoveryTickets.length}`, `${srRecovered}/${serviceRecoveryTickets.length}`]]
    });
    pdfTable({
      colW: [2.0, 1.3, 2.2, 1.7], headRow: ['Employee', 'Survey Date', 'Status', 'Ticket'],
      rows: serviceRecoveryTickets.map(t => [t.employeeName, shortDate(t.surveyDate), t.customerResponded ? 'Recovered' : t.contactedAt ? (t.contactedWithin24h ? 'Contacted On Time' : 'Contacted Late') : 'Awaiting Contact', `#${t.ticketId ?? '—'}`])
    });
  }

  sectionHeading('Attendance Detail', attendanceFactSummary(d.attendanceRows));
  {
    const withPct = d.attendanceRows.filter(r => r.attendancePct != null);
    if (withPct.length) {
      const chart = drawBarChartDataUrl(withPct.map(r => ({label: r.employeeName, value: r.attendancePct})), {color: P.accent, valueSuffix: '%'});
      subheading('ATTENDANCE % BY EMPLOYEE', P.accent, contentW * (chart.height / chart.width));
      addChartImage(chart, contentW);
    }
  }
  pdfTable({
    colW: [1.8, 0.8, 0.8, 1.0, 1.0, 0.8, 1.0],
    headRow: ['Employee', 'Scheduled', 'Present', 'Attendance %', 'Absence Days', 'PTO Days', 'Absence Reason'],
    rows: d.attendanceRows.map(r => [r.employeeName, r.scheduled, r.present, r.attendancePct == null ? '—' : `${r.attendancePct}%`, r.absenceDays, r.ptoDays, r.absenceReason])
  });

  sectionHeading('Coaching', d.coachingFactSummary);
  if (d.inPeriod.length) {
    pdfTable({colW: [2.4, 2.4, 1.2, 1.2], headRow: ['Employee', 'Category', 'Status', 'Coaching Date'], rows: d.inPeriod.map(r => [r.employeeName, r.category, r.status, shortDate(r.coachingDate)])});
  }
  if (d.inProgress.length) {
    subheading('IN PROGRESS');
    pdfTable({colW: [2.4, 2.4, 1.2, 1.2], headRow: ['Employee', 'Category', 'Status', 'Follow-up Date'], rows: d.inProgress.map(r => [r.employeeName, r.category, r.status, r.targetFollowUpDate ? shortDate(r.targetFollowUpDate) : '—'])});
  }

  sectionHeading('Definitions & Methodology', 'How the figures in this report are calculated');
  const definitions = [
    ['Final KPI', 'Weighted blend of an employee’s role-specific metrics (calls/tickets handled, CSAT, quality) into one score, per the KPI configuration for their role.'],
    // jsPDF's base "helvetica" font uses WinAnsiEncoding, which has no glyph for the U+2212 minus
    // sign the PPTX side uses freely (PowerPoint's Calibri renders it fine) - it silently prints
    // as a stray quote mark here instead, so the PDF copy of this line uses a plain hyphen.
    ['Attendance %', 'Present days ÷ (Scheduled days - PTO days). PTO is authorized leave and is excluded from both the numerator and the denominator so it never counts against attendance.'],
    ['CSAT Rate', 'Good survey responses ÷ (Good + Bad survey responses) this period, per employee or team-wide.'],
    ['LCR (Long Call Rate)', 'Accepted calls running 30+ minutes ÷ total accepted calls, per employee.'],
    ['Performance Tier', 'Exceptional / Exceeds / Meets / Intervention, derived from Final KPI against the role’s tier thresholds.'],
    ['Coaching Session', 'A logged 1:1 coaching record tied to a specific category and date; "in progress" means a follow-up date beyond this reporting period.'],
    ['Service Recovery', 'A bad CSAT is "Contacted" once that employee\'s own Team Lead or assigned Senior TSR posts a public reply on the ticket after the survey (detected from Zendesk\'s own audit trail, not manually entered); "Recovered" means the customer replied back after that.']
  ];
  for (const [term, def] of definitions) {
    ensureRoom(0.3);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...hexToRgb(P.accent));
    doc.text(term, marginX, y);
    y += 0.19;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(...hexToRgb(P.ink));
    const lines = doc.splitTextToSize(def, contentW);
    ensureRoom(lines.length * 0.16 + 0.1);
    doc.text(lines, marginX, y);
    y += lines.length * 0.16 + 0.2;
  }

  addFooter();

  const fileName = `Executive Report - Team ${leaderName} - ${monthText}.pdf`;
  doc.save(fileName);
  return fileName;
}
