#!/usr/bin/env python3
# Regenerates each rep's coaching session PDFs whenever coaching.json changes. Called
# automatically by zendesk-proxy.js after every coaching sync tick (send, acknowledge) -
# one-way mirror (portal -> PDF), same convention as export-attendance-xlsx.py. The
# portal (team lead's create/send flow, rep's sign flow) is authoritative; these PDFs are
# a read-only record of what happened.
#
# Layout: Lofty TSR/Reps/<Employee Name>/Coaching/<Year>/Coaching - <date> - <category>.pdf
# One PDF per coaching session. Draft records (not yet sent) are skipped - they're still
# being written and aren't a real record yet.
import json
import os
import re
import sys
from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, Image

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROSTER_PATH = os.path.join(SCRIPT_DIR, '..', 'data', 'roster.json')
COACHING_PATH = os.path.join(SCRIPT_DIR, '..', 'data', 'coaching.json')
REPS_ROOT = '/Users/mac/Library/CloudStorage/OneDrive-MoatableInc/Lofty PH Repository - Documents/Lofty TSR/Reps'
LOFTY_LOGO_PATH = os.path.join(SCRIPT_DIR, '..', 'shared', 'img', 'lofty-logo.png')
MOATABLE_LOGO_PATH = os.path.join(SCRIPT_DIR, '..', 'shared', 'img', 'moatable-logo.png')

NAVY = colors.HexColor('#2E46B8')
LINE = colors.HexColor('#DFE2EA')

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


def standing_summary(standing):
    if not standing:
        return 'No standing snapshot available.'
    parts = []
    if standing.get('kpiPeriod'):
        score = standing.get('finalKpi')
        score_text = f"{score:.1f}%" if isinstance(score, (int, float)) else 'N/A'
        parts.append(f"KPI {standing['kpiPeriod']}: {score_text} ({standing.get('performanceStatus', 'Not Rated')})")
    counts = standing.get('last30DayAttendanceCounts') or {}
    if counts:
        flags = ', '.join(f"{code} x{count}" for code, count in sorted(counts.items()))
        parts.append(f"Last 30 days: {flags}")
    return ' | '.join(parts) if parts else 'No attendance flags in the last 30 days.'


def build_styles():
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle('FormTitle', parent=styles['Title'], fontName='Helvetica-Bold', fontSize=18, spaceAfter=2))
    styles.add(ParagraphStyle('FormSubtitle', parent=styles['Normal'], fontName='Helvetica-Oblique', fontSize=9, textColor=colors.HexColor('#5B6274'), spaceAfter=14, alignment=1))
    styles.add(ParagraphStyle('SectionHeading', parent=styles['Heading2'], fontName='Helvetica-Bold', fontSize=11, textColor=NAVY, spaceBefore=14, spaceAfter=6))
    styles.add(ParagraphStyle('FieldLabel', parent=styles['Normal'], fontName='Helvetica-Bold', fontSize=9.5, spaceAfter=1))
    styles.add(ParagraphStyle('FieldValue', parent=styles['Normal'], fontName='Helvetica', fontSize=9.5, spaceAfter=8, leading=13))
    styles.add(ParagraphStyle('CellBody', parent=styles['Normal'], fontName='Helvetica', fontSize=9, leading=12))
    styles.add(ParagraphStyle('AckScript', parent=styles['Normal'], fontName='Helvetica-Oblique', fontSize=9, textColor=colors.HexColor('#444444'), leading=13, spaceBefore=4, spaceAfter=14))
    return styles


def field_block(styles, label, value):
    return [Paragraph(label, styles['FieldLabel']), Paragraph(value or '&nbsp;', styles['FieldValue'])]


def header_table(styles, record):
    def cell(label, value):
        return Paragraph(f"<b>{label}:</b> {value or ''}", styles['CellBody'])
    rows = [
        [cell('Date', record.get('coachingDate', '')), cell('Team Lead', record.get('teamLeadName', ''))],
        [cell('Employee', record.get('employeeName', '')), cell('Category', record.get('category', ''))],
    ]
    table = Table(rows, colWidths=[3.15 * inch, 3.15 * inch])
    table.setStyle(TableStyle([
        ('BOX', (0, 0), (-1, -1), 0.75, LINE), ('INNERGRID', (0, 0), (-1, -1), 0.75, LINE),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'), ('LEFTPADDING', (0, 0), (-1, -1), 8), ('TOPPADDING', (0, 0), (-1, -1), 6), ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
    ]))
    return table


def signature_table(styles, record):
    ack = record.get('acknowledgment') or {}
    employee_cell = (
        f"{ack.get('signedName', '')}<br/>Electronically acknowledged on {format_timestamp(ack.get('signedAt'))}."
        if ack.get('signedName') else 'Awaiting electronic acknowledgment.'
    )
    lead_cell = f"{record.get('teamLeadName', '')}"
    if record.get('sentAt'):
        lead_cell += f"<br/>Session shared on {format_timestamp(record.get('sentAt'))}."
    data = [
        [Paragraph('Employee', styles['FieldLabel']), Paragraph('Team Lead', styles['FieldLabel'])],
        [Paragraph(employee_cell, styles['CellBody']), Paragraph(lead_cell, styles['CellBody'])],
    ]
    table = Table(data, colWidths=[3.15 * inch, 3.15 * inch])
    table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), NAVY), ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
        ('BOX', (0, 0), (-1, -1), 0.75, LINE), ('INNERGRID', (0, 0), (-1, -1), 0.75, LINE),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'), ('LEFTPADDING', (0, 0), (-1, -1), 8), ('TOPPADDING', (0, 0), (-1, -1), 6), ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
    ]))
    return table


def logo_header():
    # Lofty logo (left) + Moatable logo (right), scaled to a consistent height so the two
    # different source aspect ratios sit level with each other.
    lofty_img = Image(LOFTY_LOGO_PATH, width=1.1 * inch, height=1.1 * inch * (448 / 1368))
    moatable_img = Image(MOATABLE_LOGO_PATH, width=1.5 * inch, height=1.5 * inch * (819 / 1556))
    table = Table([[lofty_img, moatable_img]], colWidths=[3.15 * inch, 3.15 * inch])
    table.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'MIDDLE'), ('ALIGN', (0, 0), (0, 0), 'LEFT'), ('ALIGN', (1, 0), (1, 0), 'RIGHT')]))
    return table


def build_pdf(out_path, record):
    styles = build_styles()
    doc = SimpleDocTemplate(out_path, pagesize=letter, topMargin=0.6 * inch, bottomMargin=0.6 * inch, leftMargin=0.65 * inch, rightMargin=0.65 * inch)
    story = [
        logo_header(),
        Spacer(1, 10),
        Paragraph('COACHING FORM', styles['FormTitle']),
        Paragraph('A record of a coaching conversation between a Lofty team lead and team member.', styles['FormSubtitle']),
        header_table(styles, record),
        Paragraph('Current Standing', styles['SectionHeading']),
        Paragraph(standing_summary(record.get('currentStanding')), styles['FieldValue']),
        Paragraph('Specific Observation', styles['SectionHeading']),
        Paragraph(record.get('observation') or '&nbsp;', styles['FieldValue']),
        Paragraph('Discussion &amp; Development Plan', styles['SectionHeading']),
        *field_block(styles, 'Discussion Summary', record.get('discussionSummary')),
        *field_block(styles, 'Action Plan', record.get('actionPlan')),
        *field_block(styles, 'Follow-Up Date', record.get('targetFollowUpDate')),
    ]
    ack = record.get('acknowledgment') or {}
    if ack.get('repComments'):
        story += [
            Paragraph('Employee Comments', styles['SectionHeading']),
            Paragraph(ack.get('repComments'), styles['FieldValue']),
        ]
    story += [
        Spacer(1, 6),
        Paragraph(ACKNOWLEDGMENT_SCRIPT, styles['AckScript']),
        Paragraph('Signatures', styles['SectionHeading']),
        signature_table(styles, record),
    ]
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
