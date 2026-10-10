'use strict';
// Renders the daily EOD report (data gathered by eod-report.js on the local proxy) in the same look as
// the Weekly Performance Report - same gradient header, section cards, uppercase table heads and
// .huddle-* classes, so the portal's existing print stylesheet and "Print / Save PDF" flow apply as-is.

function eodReportHtml(data, h) {
  const { HUDDLE_BRAND: B, huddleSectionCard, huddleTableHead, escapeHtml: esc } = h;
  const prettyDate = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const etTime = iso => iso ? new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) : '';
  const hourLabel = n => `${n % 12 === 0 ? 12 : n % 12} ${n < 12 ? 'AM' : 'PM'}`;
  const td = 'padding:10px 12px;border-top:1px solid #eef0f5;vertical-align:top';
  const tdc = `${td};text-align:center`;
  const th = labels => huddleTableHead(...labels);
  const table = (head, rows) => `<table style="width:100%;border-collapse:collapse;font-size:13px">${th(head)}<tbody>${rows}</tbody></table>`;
  const note = text => `<div style="font-size:11px;color:${B.muted};margin-top:10px;line-height:1.5">${text}</div>`;
  const lead = text => `<div style="background:${B.bg};border-radius:8px;padding:10px 14px;margin-bottom:14px;font-size:13px;line-height:1.5">${text}</div>`;
  const sub = text => `<div style="font-size:11px;font-weight:800;color:${B.muted};text-transform:uppercase;letter-spacing:.3px;margin:16px 0 8px">${text}</div>`;
  const pct = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : '—';
  const ul = items => `<ul style="margin:4px 0 0;padding-left:18px">${items.map(i => `<li style="margin-bottom:5px">${i}</li>`).join('')}</ul>`;
  const nl = t => esc(t).replace(/\n/g, '<br>');

  const header = `
    <div class="huddle-report-header" style="background:${B.gradient};border-radius:16px;padding:26px 28px;color:#fff;margin-bottom:18px">
      <div style="display:flex;align-items:center;gap:9px;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.6px;opacity:.85">
        <img src="shared/img/lofty-logo.png" alt="Lofty" style="height:18px;width:auto;background:#fff;border-radius:5px;padding:4px 9px;display:block">
        <span>Support</span>
      </div>
      <div style="font-size:25px;font-weight:850;margin-top:5px">Daily EOD Report</div>
      <div style="font-size:14px;margin-top:7px;opacity:.95">Lofty Support &middot; ${esc(prettyDate(data.date))} &middot; Shift ${esc(data.window)}</div>
      <div style="font-size:12px;margin-top:5px;opacity:.9">Prepared by: Mac Lopez</div>
    </div>`;

  const att = data.attendance, prod = data.productivity, calls = data.calls, left = data.leftover;
  const connectedTotal = prod ? prod.totals.connected + (calls?.completedNoRep || 0) : null;
  const completion = calls ? pct(calls.totals.completed, calls.totals.total) : null;

  // ---- executive summary
  const parts = [];
  if (att) parts.push(`${att.total.present} of ${att.total.total} TSRs were present.`);
  if (prod) parts.push(`The site connected ${connectedTotal} calls, was assigned ${prod.totals.newTickets} new tickets and solved ${prod.totals.solved}.`);
  if (calls) {
    const worst = calls.hourly.filter(r => r.total >= 5).sort((a, b) => a.completed / a.total - b.completed / b.total)[0];
    parts.push(`Call completion finished at ${completion}${worst && worst.completed / worst.total < 0.9 ? `, lowest at ${hourLabel(worst.hour)} (${pct(worst.completed, worst.total)})` : ''}.`);
  }
  if (data.notes?.inbox) parts.push(esc(data.notes.inbox) + (/[.!]$/.test(data.notes.inbox) ? '' : '.'));
  if (left) parts.push(`${left.count} tickets are left for tomorrow's shift${left.pastSla ? `, ${left.pastSla} already past SLA` : ''}.`);
  const execSection = parts.length ? huddleSectionCard('📌 Executive Summary', `<div style="font-size:14px;line-height:1.6">${parts.join(' ')}</div>`, B.blue) : '';

  // ---- attendance
  let attSection = '';
  if (att) {
    const t = att.total;
    const outBits = [t.rd && `${t.rd} Rest Day`, t.sl && `${t.sl} Sick Leave`, t.el && `${t.el} Emergency Leave`, t.suspended && `${t.suspended} Suspended`, t.other && `${t.other} other / not logged`].filter(Boolean);
    const row = (r, bold) => `<tr${bold ? ` style="font-weight:800;background:${B.bg}"` : ''}><td style="${td}">${esc(r.team)}</td>${[r.onsite, r.wfh, r.present, r.rd, r.sl, r.el, r.suspended, r.other, r.total].map(v => `<td style="${tdc}">${v}</td>`).join('')}</tr>`;
    const lead1 = lead(`<b>${t.present} of ${t.total}</b> present (${t.onsite} onsite, ${t.wfh} WFH).${outBits.length ? ` ${t.total - t.present} were out: ${outBits.join(', ')}.` : ''}${att.leadership?.length ? ` ${att.leadership.filter(l => ['WFH', 'ONSITE'].includes(l.status)).length} of ${att.leadership.length} Team Leaders reported present.` : ''}`);
    const main = table(['Team', 'Onsite', 'WFH', 'Present', 'Rest Day', 'Sick Leave', 'Emergency Leave', 'Suspended', 'Other', 'Total'], att.teams.map(r => row(r)).join('') + row({ team: 'Lofty Support', ...t }, true));
    const leaders = att.leadership?.length ? sub('Leadership attendance') + table(['Team Leader', 'Immediate Lead', 'Status'], att.leadership.map(l => `<tr><td style="${td}">${esc(l.name)}</td><td style="${td}">${esc(l.lead)}</td><td style="${tdc}">${esc(l.status || 'Not logged')}</td></tr>`).join('')) : '';
    attSection = huddleSectionCard('🗓️ Attendance', lead1 + main + leaders + note('Source: Lofty TSR Attendance workbook. Late counts as present.'), '#572fb4');
  }

  // ---- productivity
  let prodSection = '';
  if (prod) {
    const pt = prod.totals;
    const rows = prod.teams.map(r => `<tr><td style="${td}">${esc(r.team)}</td><td style="${tdc}">${r.connected}</td><td style="${tdc}">${r.newTickets}</td><td style="${tdc}">${r.sunshine}</td><td style="${tdc}">${r.solved}</td><td style="${tdc}">${r.touched}</td></tr>`).join('')
      + (calls?.completedNoRep ? `<tr><td style="${td}">IVR-forwarded calls (no rep)</td><td style="${tdc}">${calls.completedNoRep}</td><td style="${tdc}">-</td><td style="${tdc}">-</td><td style="${tdc}">-</td><td style="${tdc}">-</td></tr>` : '')
      + `<tr style="font-weight:800;background:${B.bg}"><td style="${td}">Lofty Support</td><td style="${tdc}">${connectedTotal}</td><td style="${tdc}">${pt.newTickets}</td><td style="${tdc}">${pt.sunshine}</td><td style="${tdc}">${pt.solved}</td><td style="${tdc}">${pt.touched}</td></tr>`;
    const top = [...prod.teams].sort((a, b) => b.newTickets - a.newTickets)[0];
    const lead1 = lead(`${connectedTotal} connected calls, ${pt.newTickets} new tickets (${pt.sunshine} Sunshine API), ${pt.solved} solved and ${pt.touched} touched.${top && top.newTickets ? ` ${esc(top.team)}'s team took the most new tickets (${top.newTickets}).` : ''}`);
    let spot = '';
    if (data.spotlight?.length) {
      const v = x => x == null ? '—' : x;
      spot = sub('Senior TSR and Lead Import Specialist') + table(['Rep', 'Role', 'Tickets Handled', 'Abandoned-Call Tickets', 'Lead Import Tickets', 'JIRA Tickets Handled', 'Inbound Calls', 'Callbacks (outbound)'],
        data.spotlight.map(s => `<tr><td style="${td}">${esc(s.name)}</td><td style="${td}">${esc(s.role)}</td>${[s.ticketsHandled, s.abandonedTickets, s.leadImport, s.jira, s.inbound, s.callbacks].map(x => `<td style="${tdc}">${v(x)}</td>`).join('')}</tr>`).join(''))
;
    }
    prodSection = huddleSectionCard('📊 Productivity', lead1 + table(['Team', 'Connected Calls', 'New Tickets Assigned', 'of which Sunshine API', 'Solved', 'Touched'], rows)
 + spot, B.blue);
  }

  // ---- call completion
  let callSection = '';
  if (calls) {
    const T = calls.totals;
    const band = r => r >= 92 ? B.green : r >= 85 ? '#d99a1e' : B.red;
    const bar = (a, b) => { const r = b ? 100 * a / b : 0; return `<span style="display:inline-block;vertical-align:middle;width:90px;height:8px;background:#eceef4;border-radius:4px;overflow:hidden"><span style="display:block;width:${r.toFixed(1)}%;height:100%;background:${band(r)}"></span></span> <b style="font-size:12px">${b ? r.toFixed(1) + '%' : '—'}</b>`; };
    const z = v => v ? `<b>${v}</b>` : `<span style="color:#b4b9c6">0</span>`;
    const hrows = calls.hourly.filter(r => r.total || r.hour >= 8).map(r => `<tr><td style="${td}">${hourLabel(r.hour)}</td><td style="${tdc}">${r.total}</td><td style="${tdc}">${r.completed}</td><td style="${tdc}">${z(r.ivr)}</td><td style="${tdc}">${z(r.queue)}</td><td style="${tdc}">${z(r.hold)}</td><td style="${td}">${bar(r.completed, r.total)}</td></tr>`).join('')
      + `<tr style="font-weight:800;background:${B.bg}"><td style="${td}">Total</td><td style="${tdc}">${T.total}</td><td style="${tdc}">${T.completed}</td><td style="${tdc}">${T.ivr}</td><td style="${tdc}">${T.queue}</td><td style="${tdc}">${T.hold}</td><td style="${td}">${bar(T.completed, T.total)}</td></tr>`;
    const lost = T.total - T.completed;
    const low = calls.hourly.filter(r => r.total >= 5 && r.completed / r.total < 0.85);
    const lowLost = low.reduce((s, r) => s + (r.total - r.completed), 0);
    const lead1 = lead(`Completion was <b>${completion}</b> (${T.completed} of ${T.total} inbound calls).${low.length ? ` The lowest hours were ${low.map(r => `${hourLabel(r.hour)} (${pct(r.completed, r.total)})`).join(', ')}, where ${lowLost} of the ${lost} lost calls happened.` : ''} ${T.ivr} of the ${lost} lost calls were IVR hang-ups.${data.notes?.inbox ? ' ' + esc(data.notes.inbox) + (/[.!]$/.test(data.notes.inbox) ? '' : '.') : ''}`);
    const causes = [`<b>Hung up in the IVR (${T.ivr}):</b> callers left the menu before reaching a rep${calls.ivrWithin5s ? `; ${calls.ivrWithin5s} within 5 seconds` : ''}.`];
    if (T.queue) causes.push(`<b>Left the queue (${T.queue}):</b> see the call details below.`);
    if (T.hold) causes.push(`<b>Dropped on hold (${T.hold}):</b> a rep had answered but the caller hung up while on hold.`);
    const legsTbl = calls.lostDetails.length ? sub('Calls lost in the queue or on hold - what the call legs show') + table(['Time (ET)', 'Result', 'What the call legs show'], calls.lostDetails.map(l => `<tr><td style="${td};white-space:nowrap">${esc(l.time)}</td><td style="${td};white-space:nowrap">${esc(l.result)}</td><td style="${td}">${esc(l.detail)}</td></tr>`).join('')) : '';
    const resolution = data.notes?.resolution ? sub('What we did to resolve it') + `<div>${nl(data.notes.resolution)}</div>` : '';
    const chat = data.notes?.chat ? sub('Chat completion') + `<div>${nl(data.notes.chat)}</div>` : '';
    const dash = data.notes?.dashboard ? note(`Current Queue Activity dashboard: ${esc(data.notes.dashboard)}. The figures above are calculated from Zendesk Talk call records for the shift and can differ slightly.`) : note('Figures are calculated from Zendesk Talk call records for the 8 AM - 8 PM EST shift (voicemail excluded).');
    callSection = huddleSectionCard('📞 Call Completion', lead1 + table(['Hour (EST)', 'Inbound', 'Completed', 'Lost in IVR', 'Lost in Queue', 'Lost on Hold', 'Completion'], hrows) + dash + chat + sub('What caused the drop') + ul(causes) + legsTbl + resolution, '#ba7517');
  }

  // ---- leftover tickets
  let leftSection = '';
  if (left) {
    const crow = c => `<tr><td style="${td}">${esc(c.channel)}${c.noSla ? ' (no SLA)' : ''}</td><td style="${tdc}">${c.count}</td><td style="${tdc}">${c.noSla ? '-' : c.pastSla}</td></tr>`;
    const ctotal = `<tr style="font-weight:800;background:${B.bg}"><td style="${td}">Total</td><td style="${tdc}">${left.count}</td><td style="${tdc}">${left.pastSla}</td></tr>`;
    const lead1 = lead(`<b>${left.count}</b> tickets are still waiting (${left.unassigned} unassigned)${left.oldestCreated ? `, created between ${esc(etTime(left.oldestCreated))} and ${esc(etTime(left.newestCreated))} EST` : ''}. ${left.pastSla} are already past SLA${left.nextDue ? `; the first of the remaining ${left.upcomingCount} comes due at ${esc(etTime(left.nextDue))} EST${new Date(left.nextDue).getTime() > Date.now() ? '' : ''}` : ''}.`);
    const flags = left.flags.length ? sub("Flag for tomorrow's shift - handle first") + table(['Priority', 'Tickets', 'Why'], left.flags.map(f => `<tr><td style="${td};font-weight:700;white-space:nowrap">${esc(f.priority)}</td><td style="${td}">${f.tickets.map(id => '#' + esc(id)).join(', ')}${f.more ? ` + ${f.more} more` : ''} <span style="color:${B.muted}">(${f.count})</span></td><td style="${td}">${esc(f.why)}</td></tr>`).join('')) : '';
    leftSection = huddleSectionCard("🎟️ Leftover Tickets for Tomorrow's Shift", lead1 + table(['Channel', 'Tickets', 'Past SLA'], left.byChannel.map(crow).join('') + ctotal) + flags
      + note(`Priority Tickets :: All Tickets view, pulled ${esc(etTime(left.asOf))} EST when the report was generated. Priorities are suggested from priority, SLA, tags, sentiment and subject - confirm before acting.`), B.red);
  }

  // ---- reminders
  const rem = data.reminders || [];
  const remSection = huddleSectionCard('📣 Reminders, Announcements and SOPs Cascaded',
    rem.length ? rem.map(r => `<div style="margin-bottom:10px;line-height:1.55">${nl(r.text)}</div>`).join('<div style="border-top:1px solid #eef0f5;margin:10px 0"></div>') + note('From the Huddle Log entries for this date.')
      : `<div style="color:${B.muted}">No huddle entry was logged for this date, so no reminders or announcements are listed.</div>`, B.green);

  const warn = (data.warnings || []).length ? `<div style="font-size:11px;color:${B.red};margin-top:4px">Some data could not be refreshed: ${data.warnings.map(esc).join('; ')}</div>` : '';
  const foot = `<div style="font-size:11px;color:${B.muted};margin-top:6px">Generated ${esc(new Date(data.generatedAt).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))} ET</div>${warn}`;
  return `${header}${execSection}${attSection}${prodSection}${callSection}${leftSection}${remSection}${foot}`;
}

module.exports = { eodReportHtml };
