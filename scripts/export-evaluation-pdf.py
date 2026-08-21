#!/usr/bin/env python3
# Regenerates each rep's evaluation PDFs whenever evaluations.json changes. Called
# automatically by zendesk-proxy.js after every evaluation sync tick (send, acknowledge) -
# one-way mirror (portal -> PDF), same convention as export-coaching-pdf.py. The portal
# (team lead's create/send flow, rep's sign flow) is authoritative; these PDFs are a
# read-only record of what happened.
#
# Layout: Lofty TSR/Reps/<Employee Name>/Evaluations/<Year>/Evaluation - <period> - <date>.pdf
# One PDF per evaluation. Draft records (not yet sent) are skipped - they're still being
# written and aren't a real record yet. Reproduces the source Word doc's own layout
# (header fields, 8-attribute rating table with the 1-5 scale, comments, acknowledgement
# paragraph) as closely as reportlab allows, keeping the wet-signature lines physically
# blank for HR filing - the online acknowledgment is a separate, faster digital record
# noted above the signature block, not a replacement for it.
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
EVALUATIONS_PATH = os.path.join(SCRIPT_DIR, '..', 'data', 'evaluations.json')
REPS_ROOT = '/Users/mac/Library/CloudStorage/OneDrive-MoatableInc/Lofty PH Repository - Documents/Lofty TSR/Reps'
LOFTY_LOGO_PATH = os.path.join(SCRIPT_DIR, '..', 'shared', 'img', 'lofty-logo.png')
MOATABLE_LOGO_PATH = os.path.join(SCRIPT_DIR, '..', 'shared', 'img', 'moatable-logo.png')

NAVY = colors.HexColor('#2E46B8')
LINE = colors.HexColor('#DFE2EA')
PAGE_WIDTH = 6.7 * inch
COL_GUTTER = 16  # points of breathing room between adjacent columns in 2-column grids

RATING_SCALE_TEXT = (
    "1 - Poor. 2 - Below Average. 3 - Average. 4 - Above Average. 5 - Excellent. See the "
    "source evaluation form for the full description of each level."
)

ACKNOWLEDGMENT_SCRIPT = (
    "I have reviewed and discussed the contents with my supervisor. My signature means "
    "that I have been advised of my performance and that I agree with this evaluation "
    "with my own comments indicated above."
)

ATTRIBUTE_LABELS = [
    ('quantityOfWork', 'Quantity of Work'),
    ('qualityOfWork', 'Quality of Work'),
    ('jobKnowledge', 'Job Knowledge'),
    ('dependabilityAccountabilityProfessionalism', 'Dependability / Accountability / Professionalism'),
    ('attendanceAndReliability', 'Attendance and Reliability'),
    ('speedAndExecutiveAbility', 'Speed and Executive Ability'),
    ('capacityToDevelop', 'Capacity to Develop'),
    ('leadershipManagement', 'Leadership / Management (supervisor or manager level)'),
]


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


def build_styles():
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle('FormTitle', parent=styles['Title'], fontName='Helvetica-Bold', fontSize=16, leading=22, spaceAfter=6))
    styles.add(ParagraphStyle('FormSubtitle', parent=styles['Normal'], fontName='Helvetica-Oblique', fontSize=9, textColor=colors.HexColor('#5B6274'), spaceAfter=10, alignment=1))
    styles.add(ParagraphStyle('CardHeader', parent=styles['Normal'], fontName='Helvetica-Bold', fontSize=10.5, textColor=colors.white))
    styles.add(ParagraphStyle('FieldLabel', parent=styles['Normal'], fontName='Helvetica-Bold', fontSize=9, textColor=colors.HexColor('#5B6274'), spaceAfter=1))
    styles.add(ParagraphStyle('FieldValue', parent=styles['Normal'], fontName='Helvetica', fontSize=9.5, leading=13))
    styles.add(ParagraphStyle('CellBody', parent=styles['Normal'], fontName='Helvetica', fontSize=9.5, leading=13))
    styles.add(ParagraphStyle('CellBodyCenter', parent=styles['Normal'], fontName='Helvetica-Bold', fontSize=9.5, leading=13, alignment=1))
    styles.add(ParagraphStyle('AckScript', parent=styles['Normal'], fontName='Helvetica-Oblique', fontSize=8.5, textColor=colors.HexColor('#444444'), leading=12, spaceAfter=8))
    styles.add(ParagraphStyle('ScaleNote', parent=styles['Normal'], fontName='Helvetica', fontSize=8, textColor=colors.HexColor('#444444'), leading=11))
    return styles


def card(styles, title, body_flowables):
    if not isinstance(body_flowables, list):
        body_flowables = [body_flowables]
    header = Table([[Paragraph(title, styles['CardHeader'])]], colWidths=[PAGE_WIDTH])
    header.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), NAVY), ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('LEFTPADDING', (0, 0), (0, 0), 10), ('TOPPADDING', (0, 0), (-1, -1), 6), ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
    ]))
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
    return KeepTogether([outer])


def identification_card(styles, record):
    def cell(label, value):
        return [Paragraph(label.upper(), styles['FieldLabel']), Paragraph(value or '&nbsp;', styles['CellBody'])]
    employee_label = record.get('employeeName', '')
    if record.get('employeeId'):
        employee_label = f"{employee_label} ({record['employeeId']})"
    grid = Table([
        [cell('Employee Name', employee_label), cell('Immediate Manager', record.get('teamLeadName', ''))],
        [cell('Business Unit', record.get('businessUnit', '')), cell('Hire Date', record.get('hireDate', ''))],
        [cell('Position', record.get('position', '')), cell('Evaluation Period', f"{record.get('evaluationPeriod', '')} ({record.get('evaluationDate', '')})")],
    ], colWidths=[PAGE_WIDTH / 2, PAGE_WIDTH / 2])
    grid.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (-1, -1), 0),
        ('RIGHTPADDING', (0, 0), (0, -1), COL_GUTTER), ('LEFTPADDING', (1, 0), (1, -1), COL_GUTTER),
        ('TOPPADDING', (0, 0), (-1, -1), 0), ('BOTTOMPADDING', (0, 0), (-1, -1), 8),
    ]))
    return card(styles, 'EMPLOYEE INFORMATION', grid)


def ratings_card(styles, record):
    ratings = record.get('ratings') or {}
    rows = [[Paragraph('<b>ATTRIBUTE</b>', styles['FieldLabel']), Paragraph('<b>RATING</b>', styles['FieldLabel'])]]
    for key, label in ATTRIBUTE_LABELS:
        value = ratings.get(key)
        value_text = 'N/A' if value is None else str(value)
        rows.append([Paragraph(xml_escape(label), styles['CellBody']), Paragraph(value_text, styles['CellBodyCenter'])])
    table = Table(rows, colWidths=[PAGE_WIDTH * 0.78, PAGE_WIDTH * 0.22])
    table.setStyle(TableStyle([
        ('LINEBELOW', (0, 0), (-1, 0), 0.75, LINE),
        ('LINEBELOW', (0, 1), (-1, -2), 0.5, LINE),
        ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (-1, -1), 6),
        ('TOPPADDING', (0, 0), (-1, -1), 4), ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
    ]))
    return card(styles, 'RATINGS', [Paragraph(RATING_SCALE_TEXT, styles['ScaleNote']), Spacer(1, 6), table])


def wet_signature_block(styles):
    # For the printed copy submitted to HR: an actual pen-and-paper signature line per
    # person, each paired with its own Date line - separate from, and in addition to, the
    # online acknowledgment noted above. Never auto-filled with the typed e-signature name.
    def person_block(name_label):
        col_widths = [1.55 * inch, 0.85 * inch]
        lines = Table([['', '']], colWidths=col_widths)
        lines.setStyle(TableStyle([
            ('LINEBELOW', (0, 0), (0, 0), 0.75, colors.black), ('LINEBELOW', (1, 0), (1, 0), 0.75, colors.black),
            ('TOPPADDING', (0, 0), (-1, -1), 22), ('BOTTOMPADDING', (0, 0), (-1, -1), 2),
            ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (0, -1), 10), ('LEFTPADDING', (1, 0), (1, -1), 10),
        ]))
        labels = Table([[Paragraph(f'{name_label} Signature', styles['FieldLabel']), Paragraph('Date', styles['FieldLabel'])]], colWidths=col_widths)
        labels.setStyle(TableStyle([
            ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (0, -1), 10), ('LEFTPADDING', (1, 0), (1, -1), 10),
            ('TOPPADDING', (0, 0), (-1, -1), 3), ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
        ]))
        return [lines, labels]
    grid = Table([
        [person_block('Employee'), person_block('Manager/Supervisor')],
    ], colWidths=[PAGE_WIDTH / 2, PAGE_WIDTH / 2])
    grid.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (-1, -1), 0),
        ('RIGHTPADDING', (0, 0), (0, -1), COL_GUTTER), ('LEFTPADDING', (1, 0), (1, -1), COL_GUTTER),
        ('TOPPADDING', (0, 0), (-1, -1), 0), ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
    ]))
    return [
        Paragraph('For the HR file copy, sign below in ink:', styles['FieldLabel']),
        Spacer(1, 4),
        grid,
    ]


def acknowledgment_card(styles, record):
    ack = record.get('acknowledgment') or {}
    online_note = (
        f"Reviewed online by <b>{xml_escape(ack.get('signedName', ''))}</b> on {format_timestamp(ack.get('signedAt'))}. "
        "A wet signature below is still required for the HR file copy."
        if ack.get('signedName') else '<i>Awaiting the employee&#8217;s online review.</i>'
    )
    body = [
        Paragraph(ACKNOWLEDGMENT_SCRIPT, styles['AckScript']),
        Paragraph(online_note, styles['CellBody']),
        Spacer(1, 16),
    ]
    body.extend(wet_signature_block(styles))
    return card(styles, 'ACKNOWLEDGEMENT', body)


def logo_header():
    lofty_img = Image(LOFTY_LOGO_PATH, width=1.1 * inch, height=1.1 * inch * (448 / 1368))
    moatable_img = Image(MOATABLE_LOGO_PATH, width=1.5 * inch, height=1.5 * inch * (819 / 1556))
    table = Table([[lofty_img, moatable_img]], colWidths=[PAGE_WIDTH / 2, PAGE_WIDTH / 2])
    table.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'MIDDLE'), ('ALIGN', (0, 0), (0, 0), 'LEFT'), ('ALIGN', (1, 0), (1, 0), 'RIGHT')]))
    return table


def build_pdf(out_path, record):
    styles = build_styles()
    doc = SimpleDocTemplate(out_path, pagesize=letter, topMargin=0.55 * inch, bottomMargin=0.55 * inch, leftMargin=0.7 * inch, rightMargin=0.7 * inch)
    period = (record.get('evaluationPeriod') or '').upper()
    story = [
        logo_header(),
        Spacer(1, 10),
        Paragraph(f'EMPLOYEE PERFORMANCE EVALUATION FOR {period}', styles['FormTitle']),
        identification_card(styles, record),
        Spacer(1, 12),
        ratings_card(styles, record),
        Spacer(1, 12),
        card(styles, 'EVALUATOR COMMENTS', Paragraph(record.get('evaluatorComments') or '&nbsp;', styles['FieldValue'])),
        Spacer(1, 12),
        card(styles, 'EMPLOYEE COMMENTS', Paragraph(record.get('employeeComments') or '&nbsp;', styles['FieldValue'])),
        Spacer(1, 12),
        acknowledgment_card(styles, record),
    ]
    doc.build(story)


def main():
    # Optional CLI args: specific employee emails to regenerate (the common case - only
    # the rep(s) affected by a sync). With no args, regenerates everyone.
    target_emails = {e.strip().lower() for e in sys.argv[1:] if e.strip()}

    with open(ROSTER_PATH) as f:
        roster = json.load(f)
    with open(EVALUATIONS_PATH) as f:
        evaluations = json.load(f)

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
    for record in evaluations.get('records', []):
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
            year = (record.get('evaluationDate') or '')[:4]
            if not year:
                continue
            year_dir = os.path.join(REPS_ROOT, folder_name, 'Evaluations', year)
            os.makedirs(year_dir, exist_ok=True)
            filename = sanitize_filename(f"Evaluation - {record.get('evaluationPeriod', '')} - {record.get('evaluationDate', '')}") + '.pdf'
            build_pdf(os.path.join(year_dir, filename), record)
        written += 1

    print(f'Exported evaluation PDFs for {written} rep(s) under {REPS_ROOT}')


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(f'evaluation export failed: {e}', file=sys.stderr)
        sys.exit(1)
