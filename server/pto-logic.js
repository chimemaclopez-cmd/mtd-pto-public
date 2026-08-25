'use strict';
/*
  Pure PTO business logic for the public PTO server, ported from zendesk-proxy.js.
  Functions here take roster/schedule/attendance/settings data as plain arguments
  instead of reading local files directly, since the public server sources that
  data from Upstash snapshots rather than the local filesystem.

  Scope note: the forecast/capacity checks here are a trimmed-down version of the
  ones in zendesk-proxy.js - they return date-level Sufficient/Warning/Critical/
  Below Minimum status (the signal reps need before submitting a request) but
  skip the granular interval-by-time-of-day breakdown and per-channel capacity
  detail, which are admin/approver-only concerns handled on the local dashboard.
*/

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const PTO_ACTIVE_STATUSES = new Set(['SUBMITTED', 'PENDING', 'APPROVED', 'PARTIALLY_APPROVED']);
const PTO_KPI_GROUPS = { 'Voice Jr TSR': 'VOICE', 'Non-Voice Jr TSR': 'NON_VOICE', 'Senior TSR': 'SENIOR' };

function cleanEmail(value) { return String(value || '').trim().toLowerCase(); }
function validDate(date) { return /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')); }
function validTime(value) { return /^([01]\d|2[0-3]):[03]0$/.test(String(value || '')); }
function minutesOf(value) { const [h, m] = String(value).split(':').map(Number); return h * 60 + m; }
function plusDays(date, days) { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
function dateRange(start, end) { const out = []; if (!validDate(start) || !validDate(end) || start > end) return out; for (let d = start; d <= end; d = plusDays(d, 1)) out.push(d); return out; }
function weekdayForDate(date) { return WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()]; }

function rosterActiveOn(employee, date) {
  return Boolean(employee) && employee.active !== false &&
    !['Resigned', 'Terminated', 'Inactive'].includes(employee.employmentStatus) &&
    (!employee.hireDate || employee.hireDate <= date) &&
    (!employee.separationDate || employee.separationDate >= date);
}

function normalizeScheduleActivity(value) { return String(value ?? '').trim(); }

function scheduleForDate(scheduleData, email, date) {
  const all = (scheduleData.schedules || []).filter(x => cleanEmail(x.employeeEmail) === cleanEmail(email) && (x.active || Boolean(x.effectiveTo)));
  const records = all
    .filter(x => x.effectiveFrom <= date && (!x.effectiveTo || x.effectiveTo >= date))
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  // No schedule record explicitly covers this date yet (e.g. filing PTO for next month before
  // next month's schedule has been built) - fall back to the most recently defined schedule as
  // their current pattern instead of reporting the day as unknown, so weekend Rest Days still
  // get detected on unbuilt future schedules.
  const fallback = !records.length ? [...all].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0] : null;
  const record = records[0] || fallback || null;
  const weekday = weekdayForDate(date);
  const base = record?.weekly?.[weekday] || null;
  const override = (scheduleData.overrides || [])
    .filter(x => cleanEmail(x.employeeEmail) === cleanEmail(email) && x.date === date)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0] || null;
  return {
    record,
    weekday,
    template: override ? { ...(base || {}), ...override, assignments: override.assignments || base?.assignments || {} } : base,
    override,
    missingSchedule: !base && !override
  };
}

function calculatePtoWorkdays(candidate, scheduleData) {
  const approved = [], missing = [], rd = [];
  for (const date of dateRange(candidate.startDate, candidate.endDate)) {
    const resolved = scheduleForDate(scheduleData, candidate.employeeEmail, date);
    if (resolved.missingSchedule) missing.push(date);
    else if (resolved.template?.off) rd.push(date);
    else approved.push(date);
  }
  return { requestedWorkdays: approved.length, workDates: approved, missingScheduleDates: missing, rdDates: rd };
}

function ptoConflictsFor(candidate, requests, excludeId = '') {
  return (requests || []).filter(x =>
    x.requestId !== excludeId &&
    cleanEmail(x.employeeEmail) === cleanEmail(candidate.employeeEmail) &&
    PTO_ACTIVE_STATUSES.has(x.status) &&
    candidate.startDate <= x.endDate && x.startDate <= candidate.endDate
  );
}

function normalizePtoRequest(body, { roster, schedules }, current = null) {
  const email = cleanEmail(body.employeeEmail ?? current?.employeeEmail);
  const employee = (roster || []).find(x => cleanEmail(x.employeeEmail) === email);
  if (!employee) throw Object.assign(new Error('Employee must exist in the roster.'), { statusCode: 400 });
  const startDate = String(body.startDate ?? current?.startDate ?? '');
  const endDate = String(body.endDate ?? current?.endDate ?? '');
  if (!validDate(startDate) || !validDate(endDate) || startDate > endDate) throw Object.assign(new Error('A valid PTO start and end date are required, and start cannot follow end.'), { statusCode: 400 });
  for (const date of dateRange(startDate, endDate)) if (!rosterActiveOn(employee, date)) throw Object.assign(new Error(`Employee is not active on ${date}; dates before hire or after separation are not allowed.`), { statusCode: 400 });
  const requestType = String(body.requestType ?? current?.requestType ?? 'FULL_DAY');
  const partialStartTime = body.partialStartTime ?? current?.partialStartTime ?? null;
  const partialEndTime = body.partialEndTime ?? current?.partialEndTime ?? null;
  if (!['FULL_DAY', 'PARTIAL_DAY'].includes(requestType)) throw Object.assign(new Error('Request type must be FULL_DAY or PARTIAL_DAY.'), { statusCode: 400 });
  if (requestType === 'PARTIAL_DAY') {
    if (startDate !== endDate) throw Object.assign(new Error('A partial-day PTO request must use one date.'), { statusCode: 400 });
    if (!validTime(partialStartTime) || !validTime(partialEndTime) || minutesOf(partialEndTime) <= minutesOf(partialStartTime)) throw Object.assign(new Error('Partial-day start and end times are required, must use 30-minute intervals, and end must follow start.'), { statusCode: 400 });
  }
  const reason = String(body.reason ?? current?.reason ?? '').trim();
  if (!reason) throw Object.assign(new Error('Reason is required.'), { statusCode: 400 });
  const calculation = calculatePtoWorkdays({ employeeEmail: email, startDate, endDate }, schedules);
  // A missing schedule is a warning, not a rejection: Workforce may not have built it yet,
  // but the employee must still be able to file. Fall back to the raw calendar range for
  // workDates/requestedWorkdays, skip the schedule-dependent partial-day shift check, and
  // flag forecastStatus so the approver sees "Schedule Missing" instead of the request
  // silently vanishing. When the schedule IS resolved, behavior is unchanged (0 workdays
  // because every date is a rest day is still rejected - that's a real "nothing to request").
  const scheduleMissing = calculation.missingScheduleDates.length > 0;
  if (!scheduleMissing && !calculation.requestedWorkdays) throw Object.assign(new Error(`The requested range contains only scheduled rest days: ${calculation.rdDates.join(', ')}.`), { statusCode: 409, details: calculation });
  if (requestType === 'PARTIAL_DAY' && !scheduleMissing) {
    const resolved = scheduleForDate(schedules, email, startDate);
    const shiftStart = minutesOf(resolved.template.shiftStartEastern);
    const shiftEndRaw = minutesOf(resolved.template.shiftEndEastern);
    const shiftEnd = shiftEndRaw + (resolved.template.overnight && shiftEndRaw <= shiftStart ? 1440 : 0);
    let partialStart = minutesOf(partialStartTime), partialEnd = minutesOf(partialEndTime);
    if (resolved.template.overnight && partialStart < shiftStart) { partialStart += 1440; partialEnd += 1440; }
    if (partialStart < shiftStart || partialEnd > shiftEnd) throw Object.assign(new Error(`Partial-day PTO must fall inside the scheduled shift ${resolved.template.shiftStartEastern}–${resolved.template.shiftEndEastern} ET.`), { statusCode: 400 });
  }
  const workDates = scheduleMissing ? dateRange(startDate, endDate) : calculation.workDates;
  const now = new Date().toISOString();
  return {
    ...current, ...body,
    employeeEmail: email,
    employeeName: employee.employeeName,
    teamLeadName: employee.teamLeadName,
    teamLeadEmail: employee.teamLeadEmail || '',
    kpiType: employee.kpiType,
    primaryChannel: employee.primaryChannel,
    dateRequested: String(body.dateRequested ?? current?.dateRequested ?? now.slice(0, 10)),
    startDate, endDate, requestType,
    partialStartTime: requestType === 'PARTIAL_DAY' ? partialStartTime : null,
    partialEndTime: requestType === 'PARTIAL_DAY' ? partialEndTime : null,
    requestedWorkdays: workDates.length,
    workDates,
    rdDates: calculation.rdDates,
    forecastStatus: scheduleMissing ? 'SCHEDULE_MISSING' : 'CALCULATED',
    reason,
    employeeNotes: String(body.employeeNotes ?? current?.employeeNotes ?? ''),
    supportingDocumentReference: String(body.supportingDocumentReference ?? current?.supportingDocumentReference ?? ''),
    createdBy: String(body.createdBy ?? current?.createdBy ?? email),
    updatedAt: now
  };
}

function ptoThreshold(settings, group, date, time = '') {
  const weekday = weekdayForDate(date);
  const groupConfig = settings.minimums?.[group] || {};
  const weekdayConfig = groupConfig[weekday];
  if (weekdayConfig == null) return null;
  if (typeof weekdayConfig === 'number') return weekdayConfig;
  if (time && Number.isFinite(Number(weekdayConfig[time]))) return Number(weekdayConfig[time]);
  if (Number.isFinite(Number(weekdayConfig.default))) return Number(weekdayConfig.default);
  return null;
}

function forecastStatus(remaining, minimum, settings) {
  if (minimum == null) return { status: 'Unknown', label: 'Threshold Not Configured', variance: null };
  const variance = remaining - minimum;
  if (variance < 0) return { status: 'Below Minimum', label: 'Below Minimum', variance };
  const warning = settings.warningThreshold == null ? NaN : Number(settings.warningThreshold);
  const critical = settings.criticalThreshold == null ? NaN : Number(settings.criticalThreshold);
  if (Number.isFinite(critical) && variance <= critical) return { status: 'Critical', label: 'Critical', variance };
  if (Number.isFinite(warning) && variance <= warning) return { status: 'Warning', label: 'Warning', variance };
  return { status: 'Sufficient', label: 'Sufficient', variance };
}

function attendanceCodeOnDate(attendance, email, date) {
  const auto = attendance.autoEntries?.[email]?.[date];
  if (auto) return auto.status;
  const matches = Object.entries(attendance.periods || {})
    .filter(([key]) => key.startsWith(date.slice(0, 7) + '|') && key.split('|')[1] >= date)
    .sort(([a], [b]) => b.localeCompare(a));
  for (const [, period] of matches) {
    const value = period?.[email]?.[date];
    if (value) return typeof value === 'object' ? value.status : value;
  }
  return '';
}

// Reads the extra `minutesLate` field a manual "Late" entry can carry (stored as
// {status:'LATE', minutesLate:N} instead of a bare string) - mirrors
// attendanceCodeOnDate's exact same auto-entry-first-else-period-lookup priority so the
// two never disagree about which record wins.
function attendanceMinutesLateOnDate(attendance, email, date) {
  const auto = attendance.autoEntries?.[email]?.[date];
  if (auto) return typeof auto === 'object' && Number.isFinite(auto.minutesLate) ? auto.minutesLate : null;
  const matches = Object.entries(attendance.periods || {})
    .filter(([key]) => key.startsWith(date.slice(0, 7) + '|') && key.split('|')[1] >= date)
    .sort(([a], [b]) => b.localeCompare(a));
  for (const [, period] of matches) {
    const value = period?.[email]?.[date];
    if (value) return typeof value === 'object' && Number.isFinite(value.minutesLate) ? value.minutesLate : null;
  }
  return null;
}

// Reads the extra `reason` field a manual entry can carry (stored as
// {status:CODE, reason:'...'} instead of a bare string) - same lookup priority as
// attendanceCodeOnDate/attendanceMinutesLateOnDate. Not restricted to any one code; the
// caller decides which codes it cares about (currently LATE and SL/SL-HD).
function attendanceReasonOnDate(attendance, email, date) {
  const auto = attendance.autoEntries?.[email]?.[date];
  if (auto) return typeof auto === 'object' && typeof auto.reason === 'string' ? auto.reason : '';
  const matches = Object.entries(attendance.periods || {})
    .filter(([key]) => key.startsWith(date.slice(0, 7) + '|') && key.split('|')[1] >= date)
    .sort(([a], [b]) => b.localeCompare(a));
  for (const [, period] of matches) {
    const value = period?.[email]?.[date];
    if (value) return typeof value === 'object' && typeof value.reason === 'string' ? value.reason : '';
  }
  return '';
}

// Reads the extra `location` field a manual "Late" entry can carry (stored as
// {status:'LATE', location:'ONSITE'|'WFH'}) - same lookup priority as attendanceCodeOnDate.
function attendanceLocationOnDate(attendance, email, date) {
  const auto = attendance.autoEntries?.[email]?.[date];
  if (auto) return typeof auto === 'object' && typeof auto.location === 'string' ? auto.location : '';
  const matches = Object.entries(attendance.periods || {})
    .filter(([key]) => key.startsWith(date.slice(0, 7) + '|') && key.split('|')[1] >= date)
    .sort(([a], [b]) => b.localeCompare(a));
  for (const [, period] of matches) {
    const value = period?.[email]?.[date];
    if (value) return typeof value === 'object' && typeof value.location === 'string' ? value.location : '';
  }
  return '';
}

// Date-level forecast only (Sufficient / Warning / Critical / Below Minimum per date).
// See module scope note above re: what's intentionally left out vs. zendesk-proxy.js.
function buildPtoForecast(input, { pto, settings, roster, schedules, attendance }) {
  const request = input.requestId ? (pto.requests || []).find(x => x.requestId === input.requestId) : input;
  if (!request) throw Object.assign(new Error('PTO request not found.'), { statusCode: 404 });
  const dates = request.workDates?.length ? request.workDates : dateRange(request.startDate, request.endDate);
  const employeeScheduleResolved = dates.length > 0 && dates.every(date => !scheduleForDate(schedules, request.employeeEmail, date).missingSchedule);
  if (!employeeScheduleResolved) {
    return { success: true, ok: true, forecastStatus: 'SCHEDULE_MISSING', staffing: null, dates: [], conflicts: ptoConflictsFor(request, pto.requests || [], request.requestId), warning: 'Schedule has not yet been created.' };
  }
  const groups = ['VOICE', 'NON_VOICE', 'SENIOR'];
  const dateRows = [];
  for (const date of dates) {
    const scheduledByGroup = { VOICE: [], NON_VOICE: [], SENIOR: [] };
    for (const employee of roster) {
      const group = PTO_KPI_GROUPS[employee.kpiType];
      if (!group || !rosterActiveOn(employee, date)) continue;
      const resolved = scheduleForDate(schedules, employee.employeeEmail, date);
      if (!resolved.missingSchedule && !resolved.template?.off) scheduledByGroup[group].push({ employee, resolved });
    }
    const existing = (pto.overlays || []).filter(x => x.active !== false && x.date === date && x.requestId !== request.requestId);
    const dateResult = { date, groups: {}, status: 'Unknown' };
    for (const group of groups) {
      const scheduled = scheduledByGroup[group];
      const alreadyOut = new Set(existing.filter(x => x.requestType === 'FULL_DAY' && scheduled.some(s => s.employee.employeeEmail === x.employeeEmail)).map(x => x.employeeEmail));
      for (const item of scheduled) {
        const ids = Object.values(item.resolved.template?.assignments || {}).map(normalizeScheduleActivity).filter(Boolean);
        const attendanceCode = attendanceCodeOnDate(attendance, item.employee.employeeEmail, date);
        if ((ids.length && ids.every(id => ['PTO', 'RD', 'OFFLINE'].includes(id))) || ['PTO', 'SL', 'EL', 'BL', 'SUSPENDED'].includes(attendanceCode)) alreadyOut.add(item.employee.employeeEmail);
      }
      const proposed = PTO_KPI_GROUPS[request.kpiType] === group && scheduled.some(s => s.employee.employeeEmail === request.employeeEmail) ? 1 : 0;
      const remaining = Math.max(0, scheduled.length - alreadyOut.size - proposed);
      const minimum = ptoThreshold(settings, group, date);
      const state = forecastStatus(remaining, minimum, settings);
      dateResult.groups[group] = { scheduled: scheduled.length, alreadyUnavailable: alreadyOut.size, proposedPto: proposed, remaining, minimum, status: state.status, statusLabel: state.label, variance: state.variance };
    }
    const states = Object.values(dateResult.groups).map(x => x.status);
    dateResult.status = states.includes('Below Minimum') ? 'Below Minimum'
      : states.includes('Critical') ? 'Critical'
      : states.includes('Warning') ? 'Warning'
      : states.every(x => x === 'Sufficient') ? 'Sufficient' : 'Unknown';
    dateRows.push(dateResult);
  }
  const conflicts = ptoConflictsFor(request, pto.requests || [], request.requestId);
  return {
    ok: true,
    requestId: request.requestId || '',
    dataStatus: 'Live',
    calculatedAt: new Date().toISOString(),
    lastScheduleRefresh: schedules.lastUpdated || '',
    lastRosterRefresh: '',
    lastPtoRefresh: pto.lastUpdated || '',
    dates: dateRows,
    intervals: {},
    conflicts,
    settingsConfigured: Object.values(settings.minimums || {}).some(group => Object.keys(group || {}).length > 0)
  };
}

// Simplified capacity check: simultaneous-PTO-by-KPI-type / by-team-lead maximums only.
// Skips the per-channel staffing breakdown (admin/approver-only concern).
function applyPtoCapacityLimits(forecast, request, { settings, pto, roster }) {
  const warnings = [];
  for (const row of forecast.dates || []) {
    const active = (pto.overlays || []).filter(x => x.active !== false && x.date === row.date && x.requestId !== request.requestId);
    const sameKpi = active.filter(x => roster.find(r => cleanEmail(r.employeeEmail) === cleanEmail(x.employeeEmail))?.kpiType === request.kpiType).length;
    const sameLead = active.filter(x => roster.find(r => cleanEmail(r.employeeEmail) === cleanEmail(x.employeeEmail))?.teamLeadName === request.teamLeadName).length;
    const maxKpi = Number(settings.maximumSimultaneousByKpi?.[request.kpiType]);
    const maxLead = Number(settings.maximumSimultaneousByTeamLead?.[request.teamLeadName]);
    if (Number.isFinite(maxKpi) && sameKpi + 1 > maxKpi) warnings.push(`${row.date}: proposed PTO exceeds the configured ${request.kpiType} simultaneous PTO maximum of ${maxKpi}.`);
    if (Number.isFinite(maxLead) && sameLead + 1 > maxLead) warnings.push(`${row.date}: proposed PTO exceeds the configured ${request.teamLeadName} simultaneous PTO maximum of ${maxLead}.`);
  }
  if (warnings.length) for (const row of forecast.dates || []) if (row.status === 'Sufficient' || row.status === 'Unknown') row.status = 'Warning';
  forecast.staffingWarnings = warnings;
  return forecast;
}

// Attendance % over an ARBITRARY date range (not a calendar month) - built for the
// probationary KPI feature, whose evaluation periods are anchored to each employee's own
// hire date rather than a calendar month. Mirrors the bucketing logic in
// zendesk-proxy.js's recalculateAttendanceForEmail() line for line, just parameterized by
// (startDate, endDate) instead of `${month}-01`..endDate, and reads attendance codes via
// attendanceCodeOnDate() above (which already resolves the right period key per date) so
// there's no need to separately merge same-month snapshot keys the way that function does.
function computeAttendanceForRange(roster, schedules, attendance, email, startDate, endDate) {
  const employee = roster.find(x => cleanEmail(x.employeeEmail) === cleanEmail(email));
  if (!employee) return null;
  let scheduled = 0, present = 0, presentEquivalent = 0, eligible = 0, absence = 0, pto = 0, partialPto = 0, rd = 0, missing = 0, missingSchedule = 0;
  for (const date of dateRange(startDate, endDate)) {
    if (!rosterActiveOn(employee, date)) continue;
    const resolved = scheduleForDate(schedules, email, date);
    if (resolved.missingSchedule) { missingSchedule++; continue; }
    if (resolved.template?.off) { rd++; continue; }
    scheduled++;
    const code = attendanceCodeOnDate(attendance, email, date);
    if (code === 'PTO') { pto++; continue; }
    eligible++;
    if (code === 'PARTIAL_PTO') { partialPto++; continue; }
    if (!code) { missing++; continue; }
    if (['ONSITE', 'WFH', 'LATE'].includes(code)) { present++; presentEquivalent++; }
    else if (['SL-HD', 'EL-HD'].includes(code)) { presentEquivalent += 0.5; absence += 0.5; }
    else absence++;
  }
  return {
    employeeEmail: email, startDate, endDate,
    scheduledWorkdays: scheduled, present, presentDayEquivalent: presentEquivalent,
    attendancePercentage: eligible ? present / eligible * 100 : null,
    eligibleWorkdays: eligible, absenceDays: absence, ptoDays: pto, partialPtoDays: partialPto,
    rdDays: rd, missingEntries: missing, missingScheduleDays: missingSchedule,
    status: missingSchedule ? 'Missing Schedule' : missing ? 'Missing Attendance' : 'Ready'
  };
}

module.exports = {
  PTO_ACTIVE_STATUSES, PTO_KPI_GROUPS,
  cleanEmail, validDate, validTime, minutesOf, dateRange, weekdayForDate,
  rosterActiveOn, scheduleForDate, calculatePtoWorkdays, ptoConflictsFor,
  normalizePtoRequest, ptoThreshold, forecastStatus, attendanceCodeOnDate, attendanceMinutesLateOnDate, attendanceReasonOnDate, attendanceLocationOnDate,
  buildPtoForecast, applyPtoCapacityLimits, computeAttendanceForRange
};
