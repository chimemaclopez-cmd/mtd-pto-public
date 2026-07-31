#!/usr/bin/env python3
# Regenerates each rep's coaching session PDFs whenever coaching.json changes. Called
# automatically by zendesk-proxy.js after every coaching sync tick (send, acknowledge) -
# one-way mirror (portal -> PDF), same convention as export-attendance-xlsx.py. The
# portal (team lead's create/send flow, rep's sign flow) is authoritative; these PDFs are
# a read-only record of what happened.
#
# Layout: Lofty TSR/Reps/<Employee Name>/Coaching/<Year>/Coaching - <date> - <category>.pdf
# One PDF per coaching session. Draft records (not yet sent) are skipped - they're still
# being written and aren't a real record yet. Each section renders as its own bordered,
# color-headed card (common convention on BPO coaching/QA forms), rather than plain
# running text, so the printed record reads cleanly section-by-section.
import json
import os
import re
import sys
from xml.sax.saxutils import escape as xml_escape
from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, Image, KeepTogether

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROSTER_PATH = os.path.join(SCRIPT_DIR, '..', 'data', 'roster.json')
COACHING_PATH = os.path.join(SCRIPT_DIR, '..', 'data', 'coaching.json')
REPS_ROOT = '/Users/mac/Library/CloudStorage/OneDrive-MoatableInc/Lofty PH Repository - Documents/Lofty TSR/Reps'
LOFTY_LOGO_PATH = os.path.join(SCRIPT_DIR, '..', 'shared', 'img', 'lofty-logo.png')
MOATABLE_LOGO_PATH = os.path.join(SCRIPT_DIR, '..', 'shared', 'img', 'moatable-logo.png')

NAVY = colors.HexColor('#2E46B8')
LINE = colors.HexColor('#DFE2EA')
PAGE_WIDTH = 6.7 * inch
COL_GUTTER = 16  # points of breathing room between adjacent columns in 2-column grids

# Mirrors shared/scoring.js's performanceStatus() tiering - color-coded the same way a
# BPO QA scorecard would flag a rep's standing at a glance.
STATUS_COLORS = {
    'Exceptional': colors.HexColor('#0F7A49'), 'Exceeds': colors.HexColor('#19AB63'),
    'Meets': colors.HexColor('#2E46B8'), 'Watch': colors.HexColor('#BA7517'),
    'Intervention': colors.HexColor('#C2313A'), 'Not Rated': colors.HexColor('#5B6274'),
}

INTRO_SCRIPT = (
    "This Employee Coaching Form documents a coaching conversation between a team lead and "
    "a team member. It records the employee's standing at the time of the session, the "
    "specific behavior or performance discussed, the plan agreed on to address it, and the "
    "employee's acknowledgment that the conversation took place."
)

ACKNOWLEDGMENT_SCRIPT = (
    "I acknowledge that I have reviewed and discussed the coaching session detailed above "
    "with my Team Lead. I understand the observations, expectations, and any action items "
    "outlined, and I have had the opportunity to share my feedback on this session. My "
    "electronic signature below confirms that this discussion took place."
)


def sanitize_folder_name(name, fallback):
    cleaned = re.sub(r'[/\\:*?"<>|]', '-', str(name or '')).strip()
    return cleaned or fallback


def sanitize_filename(name):
    return re.sub(r'[/\\:*?"<>|]', '-', str(name or '')).strip()


def format_timestamp(iso_value):
    if not iso_value:
        return ''
    try:
        from datetime import datetime
        dt = datetime.fromisoformat(str(iso_value).replace('Z', '+00:00'))
        return dt.strftime('%b %d, %Y at %I:%M %p UTC')
    except ValueError:
        return str(iso_value)


def standing_line(standing):
    if not standing or not standing.get('kpiPeriod'):
        return None, 'No KPI result on file yet for this period.'
    score = standing.get('finalKpi')
    score_text = f"{score:.1f}%" if isinstance(score, (int, float)) else 'N/A'
    status = standing.get('performanceStatus', 'Not Rated')
    return status, f"KPI {standing['kpiPeriod']}: <b>{score_text}</b> &mdash; "


def attendance_flags_line(standing):
    counts = (standing or {}).get('last30DayAttendanceCounts') or {}
    if not counts:
        return 'No attendance flags in the last 30 days.'
    flags = ', '.join(f"{code} x{count}" for code, count in sorted(counts.items()))
    return f"Last 30 days: {flags}"


def late_occurrence_text(o):
    date = xml_escape(o.get('date', ''))
    bits = []
    if o.get('minutesLate') is not None:
        bits.append(f"{o['minutesLate']} min")
    if o.get('reason'):
        bits.append(xml_escape(o['reason']))
    return f"{date} ({', '.join(bits)})" if bits else date


def sl_occurrence_text(o):
    date = xml_escape(o.get('date', ''))
    return f"{date} ({xml_escape(o['reason'])})" if o.get('reason') else date


def occurrence_paragraph(styles, label, items, detail_fn):
    if not items:
        return None
    parts = '; '.join(detail_fn(o) for o in items)
    return Paragraph(f"<b>{label}:</b> {parts}", styles['CellBody'])


def metrics_table(styles, standing):
    metrics = (standing or {}).get('metrics') or []
    if not metrics:
        return None
    header = [Paragraph('<b>Metric</b>', styles['FieldLabel']), Paragraph('<b>Value</b>', styles['FieldLabel']), Paragraph('<b>Points</b>', styles['FieldLabel'])]
    rows = [header]
    for m in metrics:
        points = m.get('points')
        points_text = f"{points} pts" if isinstance(points, (int, float)) else (m.get('status') or '—')
        rows.append([
            Paragraph(xml_escape(m.get('label', '')), styles['CellBody']),
            Paragraph(xml_escape(str(m.get('value') or '—')), styles['CellBody']),
            Paragraph(xml_escape(str(points_text)), styles['CellBody']),
        ])
    t = Table(rows, colWidths=[PAGE_WIDTH * 0.45, PAGE_WIDTH * 0.30, PAGE_WIDTH * 0.25])
    t.setStyle(TableStyle([
        ('LINEBELOW', (0, 0), (-1, 0), 0.75, LINE),
        ('LINEBELOW', (0, 1), (-1, -2), 0.5, LINE),
        ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (-1, -1), 6),
        ('TOPPADDING', (0, 0), (-1, -1), 3), ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
    ]))
    return t


def build_styles():
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle('FormTitle', parent=styles['Title'], fontName='Helvetica-Bold', fontSize=18, leading=24, spaceAfter=6))
    styles.add(ParagraphStyle('FormSubtitle', parent=styles['Normal'], fontName='Helvetica-Oblique', fontSize=9, textColor=colors.HexColor('#5B6274'), spaceAfter=10, alignment=1))
    styles.add(ParagraphStyle('IntroScript', parent=styles['Normal'], fontName='Helvetica', fontSize=9, textColor=colors.HexColor('#333333'), leading=13, alignment=1, spaceAfter=16))
    styles.add(ParagraphStyle('CardHeader', parent=styles['Normal'], fontName='Helvetica-Bold', fontSize=10.5, textColor=colors.white))
    styles.add(ParagraphStyle('FieldLabel', parent=styles['Normal'], fontName='Helvetica-Bold', fontSize=9, textColor=colors.HexColor('#5B6274'), spaceAfter=1))
    styles.add(ParagraphStyle('FieldValue', parent=styles['Normal'], fontName='Helvetica', fontSize=9.5, leading=13))
    styles.add(ParagraphStyle('CellBody', parent=styles['Normal'], fontName='Helvetica', fontSize=9.5, leading=13))
    styles.add(ParagraphStyle('AckScript', parent=styles['Normal'], fontName='Helvetica-Oblique', fontSize=8.5, textColor=colors.HexColor('#444444'), leading=12, spaceAfter=8))
    return styles


def card(styles, title, body_flowables, title_extra=None):
    # One bordered "card" per section: a solid navy header bar (title, optionally a
    # right-aligned badge like a color-coded status) over a white body - the standard
    # boxed-section look used on most BPO coaching/QA forms instead of running text.
    if not isinstance(body_flowables, list):
        body_flowables = [body_flowables]
    header_cells = [Paragraph(title, styles['CardHeader'])]
    header_widths = [PAGE_WIDTH]
    header_style = [
        ('BACKGROUND', (0, 0), (-1, -1), NAVY),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('LEFTPADDING', (0, 0), (0, 0), 10), ('TOPPADDING', (0, 0), (-1, -1), 6), ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
    ]
    if title_extra:
        header_cells.append(title_extra)
        header_widths = [PAGE_WIDTH - 1.6 * inch, 1.6 * inch]
        header_style.append(('ALIGN', (1, 0), (1, 0), 'RIGHT'))
        header_style.append(('RIGHTPADDING', (1, 0), (1, 0), 10))
    header = Table([header_cells], colWidths=header_widths)
    header.setStyle(TableStyle(header_style))
    body = Table([[f] for f in body_flowables], colWidths=[PAGE_WIDTH])
    body.setStyle(TableStyle([
        ('LEFTPADDING', (0, 0), (-1, -1), 12), ('RIGHTPADDING', (0, 0), (-1, -1), 12),
        ('TOPPADDING', (0, 0), (-1, 0), 10), ('BOTTOMPADDING', (0, -1), (-1, -1), 10),
        ('TOPPADDING', (0, 1), (-1, -1), 4), ('BOTTOMPADDING', (0, 0), (-1, -2), 4),
    ]))
    outer = Table([[header], [body]], colWidths=[PAGE_WIDTH])
    outer.setStyle(TableStyle([
        ('BOX', (0, 0), (-1, -1), 0.75, LINE),
        ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (-1, -1), 0),
        ('TOPPADDING', (0, 0), (-1, -1), 0), ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
    ]))
    # Keep the header bar and its body on the same page - without this, a card that
    # lands right at a page break can split with the colored header stranded alone.
    return KeepTogether([outer])


def status_badge(styles, status):
    color = STATUS_COLORS.get(status, colors.HexColor('#5B6274'))
    badge = Table([[Paragraph(f'<font color="white"><b>{status}</b></font>', styles['CardHeader'])]], colWidths=[1.3 * inch])
    badge.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), color), ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
        ('TOPPADDING', (0, 0), (-1, -1), 3), ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
    ]))
    return badge


def identification_card(styles, record):
    def cell(label, value):
        return [Paragraph(label.upper(), styles['FieldLabel']), Paragraph(value or '&nbsp;', styles['CellBody'])]
    employee_label = record.get('employeeName', '')
    if record.get('employeeId'):
        employee_label = f"{employee_label} ({record['employeeId']})"
    grid = Table([
        [cell('Date', record.get('coachingDate', '')), cell('Team Lead', record.get('teamLeadName', ''))],
        [cell('Employee', employee_label), cell('Category', record.get('category', ''))],
    ], colWidths=[PAGE_WIDTH / 2, PAGE_WIDTH / 2])
    grid.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (-1, -1), 0),
        ('RIGHTPADDING', (0, 0), (0, -1), COL_GUTTER), ('LEFTPADDING', (1, 0), (1, -1), COL_GUTTER),
        ('TOPPADDING', (0, 0), (-1, -1), 0), ('BOTTOMPADDING', (0, 0), (-1, -1), 8),
    ]))
    return card(styles, 'EMPLOYEE INFORMATION', grid)


def standing_card(styles, record):
    standing = record.get('currentStanding')
    status, kpi_prefix = standing_line(standing)
    lines = []
    if status:
        row = Table([[Paragraph(kpi_prefix, styles['CellBody']), status_badge(styles, status)]], colWidths=[PAGE_WIDTH - 1.4 * inch, 1.4 * inch])
        row.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'MIDDLE'), ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (0, -1), COL_GUTTER), ('RIGHTPADDING', (1, 0), (1, -1), 0), ('TOPPADDING', (0, 0), (-1, -1), 0), ('BOTTOMPADDING', (0, 0), (-1, -1), 6)]))
        lines.append(row)
    else:
        lines.append(Paragraph(kpi_prefix, styles['CellBody']))
    mt = metrics_table(styles, standing)
    if mt:
        lines.append(Spacer(1, 4))
        lines.append(mt)
        lines.append(Spacer(1, 6))
    lines.append(Paragraph(attendance_flags_line(standing), styles['CellBody']))
    late_p = occurrence_paragraph(styles, 'Late Arrivals', (standing or {}).get('last30DayLateOccurrences'), late_occurrence_text)
    if late_p:
        lines.append(Spacer(1, 3))
        lines.append(late_p)
    sl_p = occurrence_paragraph(styles, 'Sick Leave', (standing or {}).get('last30DaySlOccurrences'), sl_occurrence_text)
    if sl_p:
        lines.append(Spacer(1, 3))
        lines.append(sl_p)
    return card(styles, 'CURRENT STANDING', lines)


def logo_header():
    # Lofty logo (left) + Moatable logo (right), scaled to a consistent height so the two
    # different source aspect ratios sit level with each other.
    lofty_img = Image(LOFTY_LOGO_PATH, width=1.1 * inch, height=1.1 * inch * (448 / 1368))
    moatable_img = Image(MOATABLE_LOGO_PATH, width=1.5 * inch, height=1.5 * inch * (819 / 1556))
    table = Table([[lofty_img, moatable_img]], colWidths=[PAGE_WIDTH / 2, PAGE_WIDTH / 2])
    table.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'MIDDLE'), ('ALIGN', (0, 0), (0, 0), 'LEFT'), ('ALIGN', (1, 0), (1, 0), 'RIGHT')]))
    return table


def wet_signature_block(styles):
    # For a printed copy submitted to HR: an actual pen-and-paper signature line per
    # person (bottom-border-only cells with generous top padding to leave room for ink),
    # each paired with its own Date line - separate from, and in addition to, the
    # electronic acknowledgment above.
    def person_block(name_label):
        col_widths = [1.55 * inch, 0.85 * inch]
        lines = Table([['', '']], colWidths=col_widths)
        lines.setStyle(TableStyle([
            ('LINEBELOW', (0, 0), (0, 0), 0.75, colors.black), ('LINEBELOW', (1, 0), (1, 0), 0.75, colors.black),
            ('TOPPADDING', (0, 0), (-1, -1), 22), ('BOTTOMPADDING', (0, 0), (-1, -1), 2),
            ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (0, -1), 10), ('LEFTPADDING', (1, 0), (1, -1), 10),
        ]))
        labels = Table([[Paragraph(f'{name_label} Signature over Printed Name', styles['FieldLabel']), Paragraph('Date', styles['FieldLabel'])]], colWidths=col_widths)
        labels.setStyle(TableStyle([
            ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (0, -1), 10), ('LEFTPADDING', (1, 0), (1, -1), 10),
            ('TOPPADDING', (0, 0), (-1, -1), 3), ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
        ]))
        return [lines, labels]
    grid = Table([
        [person_block('Employee'), person_block('Team Lead')],
    ], colWidths=[PAGE_WIDTH / 2, PAGE_WIDTH / 2])
    grid.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (-1, -1), 0),
        ('RIGHTPADDING', (0, 0), (0, -1), COL_GUTTER), ('LEFTPADDING', (1, 0), (1, -1), COL_GUTTER),
        ('TOPPADDING', (0, 0), (-1, -1), 0), ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
    ]))
    return [
        Paragraph('For a printed copy submitted to HR, sign below:', styles['FieldLabel']),
        Spacer(1, 4),
        grid,
    ]


def signature_card(styles, record):
    ack = record.get('acknowledgment') or {}
    employee_cell = (
        f"<b>{ack.get('signedName', '')}</b><br/>Electronically acknowledged on {format_timestamp(ack.get('signedAt'))}."
        if ack.get('signedName') else '<i>Awaiting electronic acknowledgment.</i>'
    )
    lead_cell = f"<b>{record.get('teamLeadName', '')}</b>"
    if record.get('sentAt'):
        lead_cell += f"<br/>Session shared on {format_timestamp(record.get('sentAt'))}."
    grid = Table([
        [Paragraph('EMPLOYEE', styles['FieldLabel']), Paragraph('TEAM LEAD', styles['FieldLabel'])],
        [Paragraph(employee_cell, styles['CellBody']), Paragraph(lead_cell, styles['CellBody'])],
    ], colWidths=[PAGE_WIDTH / 2, PAGE_WIDTH / 2])
    grid.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'TOP'), ('LINEABOVE', (0, 1), (-1, 1), 0.75, LINE), ('TOPPADDING', (0, 1), (-1, 1), 8),
        ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (-1, -1), 0),
        ('RIGHTPADDING', (0, 0), (0, -1), COL_GUTTER), ('LEFTPADDING', (1, 0), (1, -1), COL_GUTTER),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
    ]))
    body = [Paragraph(ACKNOWLEDGMENT_SCRIPT, styles['AckScript']), grid, Spacer(1, 16)]
    body.extend(wet_signature_block(styles))
    return card(styles, 'ACKNOWLEDGMENT', body)


def build_pdf(out_path, record):
    styles = build_styles()
    doc = SimpleDocTemplate(out_path, pagesize=letter, topMargin=0.55 * inch, bottomMargin=0.55 * inch, leftMargin=0.7 * inch, rightMargin=0.7 * inch)
    story = [
        logo_header(),
        Spacer(1, 10),
        Paragraph('EMPLOYEE COACHING FORM', styles['FormTitle']),
        Paragraph('A record of a coaching conversation between a Lofty team lead and team member.', styles['FormSubtitle']),
        Paragraph(INTRO_SCRIPT, styles['IntroScript']),
        identification_card(styles, record),
        Spacer(1, 12),
        standing_card(styles, record),
        Spacer(1, 12),
        card(styles, 'SPECIFIC OBSERVATION', Paragraph(record.get('observation') or '&nbsp;', styles['FieldValue'])),
        Spacer(1, 12),
    ]
    plan_body = [Paragraph(record.get('discussionSummary') or '&nbsp;', styles['FieldValue'])]
    plan_grid = Table([
        [Paragraph('ACTION PLAN', styles['FieldLabel']), Paragraph('FOLLOW-UP DATE', styles['FieldLabel'])],
        [Paragraph(record.get('actionPlan') or '&nbsp;', styles['CellBody']), Paragraph(record.get('targetFollowUpDate') or '&nbsp;', styles['CellBody'])],
    ], colWidths=[PAGE_WIDTH * 0.68, PAGE_WIDTH * 0.32])
    plan_grid.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'TOP'), ('LINEABOVE', (0, 1), (-1, 1), 0.75, LINE), ('TOPPADDING', (0, 1), (-1, 1), 8),
        ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (-1, -1), 0),
        ('RIGHTPADDING', (0, 0), (0, -1), COL_GUTTER), ('LEFTPADDING', (1, 0), (1, -1), COL_GUTTER),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
        ('TOPPADDING', (0, 0), (-1, 0), 6),
    ]))
    plan_body.append(plan_grid)
    story.append(card(styles, 'DISCUSSION &amp; DEVELOPMENT PLAN', plan_body))
    story.append(Spacer(1, 12))

    ack = record.get('acknowledgment') or {}
    if ack.get('repComments'):
        story.append(card(styles, 'EMPLOYEE COMMENTS', Paragraph(ack.get('repComments'), styles['FieldValue'])))
        story.append(Spacer(1, 12))

    story.append(signature_card(styles, record))
    doc.build(story)


def main():
    # Optional CLI args: specific employee emails to regenerate (the common case - only
    # the rep(s) affected by a sync). With no args, regenerates everyone.
    target_emails = {e.strip().lower() for e in sys.argv[1:] if e.strip()}

    with open(ROSTER_PATH) as f:
        roster = json.load(f)
    with open(COACHING_PATH) as f:
        coaching = json.load(f)

    used_names = {}
    folder_by_email = {}
    for r in roster['records']:
        email = r.get('employeeEmail')
        if not email:
            continue
        name = r.get('employeeName') or email
        folder_name = sanitize_folder_name(name, email)
        if folder_name in used_names and used_names[folder_name] != email:
            folder_name = f"{folder_name} ({email})"
        used_names[folder_name] = email
        folder_by_email[email] = folder_name

    records_by_email = {}
    for record in coaching.get('records', []):
        if record.get('status') == 'DRAFT':
            continue  # not final yet - no PDF until sent
        email = (record.get('employeeEmail') or '').lower()
        if email:
            records_by_email.setdefault(email, []).append(record)

    written = 0
    for r in roster['records']:
        email = r.get('employeeEmail')
        if not email:
            continue
        if target_emails and email.lower() not in target_emails:
            continue
        employee_records = records_by_email.get(email.lower(), [])
        if not employee_records:
            continue
        folder_name = folder_by_email[email]
        for record in employee_records:
            year = (record.get('coachingDate') or '')[:4]
            if not year:
                continue
            year_dir = os.path.join(REPS_ROOT, folder_name, 'Coaching', year)
            os.makedirs(year_dir, exist_ok=True)
            filename = sanitize_filename(f"Coaching - {record.get('coachingDate', '')} - {record.get('category', '')}") + '.pdf'
            build_pdf(os.path.join(year_dir, filename), record)
        written += 1

    print(f'Exported coaching PDFs for {written} rep(s) under {REPS_ROOT}')


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(f'coaching export failed: {e}', file=sys.stderr)
        sys.exit(1)
