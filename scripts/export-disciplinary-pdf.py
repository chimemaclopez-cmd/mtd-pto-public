#!/usr/bin/env python3
# Regenerates each rep's disciplinary record PDFs whenever disciplinary.json changes.
# Called automatically by zendesk-proxy.js after every disciplinary sync tick (file,
# decide, acknowledge) - one-way mirror (portal -> PDF), same convention as
# export-coaching-pdf.py. The portal (team lead's file flow, HR's decide flow, rep's
# acknowledge flow) is authoritative; these PDFs are a read-only record of what happened.
#
# Layout: Lofty TSR/Reps/<Employee Name>/Disciplinary/<Year>/Disciplinary - <date> -
# <category>.pdf
# One PDF per case. Cases still FILED (not yet decided by HR) are skipped - the sanction
# isn't final yet, so there's nothing official to hand the employee.
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
DISCIPLINARY_PATH = os.path.join(SCRIPT_DIR, '..', 'data', 'disciplinary.json')
REPS_ROOT = '/Users/mac/Library/CloudStorage/OneDrive-MoatableInc/Lofty PH Repository - Documents/Lofty TSR/Reps'
LOFTY_LOGO_PATH = os.path.join(SCRIPT_DIR, '..', 'shared', 'img', 'lofty-logo.png')
MOATABLE_LOGO_PATH = os.path.join(SCRIPT_DIR, '..', 'shared', 'img', 'moatable-logo.png')

NAVY = colors.HexColor('#2E46B8')
LINE = colors.HexColor('#DFE2EA')
PAGE_WIDTH = 6.7 * inch
COL_GUTTER = 16  # points of breathing room between adjacent columns in 2-column grids

TIER_LABELS = {
    'Misdemeanor': 'Misdemeanor', 'MinorOffense': 'Minor Offense', 'MajorOffense': 'Major Offense',
    'GraveOffense': 'Grave Offense', 'Terminable': 'Terminable Offense',
}
# Colors chosen to read as an escalating severity scale, distinct from the coaching
# PDF's KPI-status palette (a different axis entirely).
TIER_COLORS = {
    'Misdemeanor': colors.HexColor('#2E46B8'), 'MinorOffense': colors.HexColor('#BA7517'),
    'MajorOffense': colors.HexColor('#C2761A'), 'GraveOffense': colors.HexColor('#C2313A'),
    'Terminable': colors.HexColor('#7A1620'),
}

INTRO_SCRIPT = (
    "This Disciplinary Notice documents an infraction of Moatable's Code of Conduct and "
    "Discipline, the sanction determined by HR, and the employee's acknowledgment of "
    "receipt. It is based on the Company's progressive system of sanctions and the "
    "prescriptive/cleansing period that applies to each tier of infraction."
)

ACKNOWLEDGMENT_SCRIPT = (
    "I acknowledge that I have received and reviewed this Disciplinary Notice. I "
    "understand the infraction cited, the sanction imposed, and my right to due process "
    "under the Company's Code of Conduct and Discipline. My electronic signature below "
    "confirms receipt of this notice; it does not necessarily indicate agreement with the "
    "decision."
)


def sanitize_folder_name(name, fallback):
    cleaned = re.sub(r'[/\\:*?"<>|]', '-', str(name or '')).strip()
    return cleaned or fallback


def sanitize_filename(name):
    return re.sub(r'[/\\:*?"<>|]', '-', str(name or '')).strip()


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
        header_widths = [PAGE_WIDTH - 1.9 * inch, 1.9 * inch]
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
    return KeepTogether([outer])


def tier_badge(styles, tier):
    color = TIER_COLORS.get(tier, colors.HexColor('#5B6274'))
    label = TIER_LABELS.get(tier, tier or 'Unknown')
    badge = Table([[Paragraph(f'<font color="white"><b>{xml_escape(label)}</b></font>', styles['CardHeader'])]], colWidths=[1.8 * inch])
    badge.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), color), ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
        ('TOPPADDING', (0, 0), (-1, -1), 3), ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
    ]))
    return badge


def identification_card(styles, record):
    def cell(label, value):
        return [Paragraph(label.upper(), styles['FieldLabel']), Paragraph(xml_escape(str(value or '')) or '&nbsp;', styles['CellBody'])]
    employee_label = record.get('employeeName', '')
    if record.get('employeeId'):
        employee_label = f"{employee_label} ({record['employeeId']})"
    grid = Table([
        [cell('Infraction Date', record.get('infractionDate', '')), cell('Team Lead', record.get('teamLeadName', ''))],
        [cell('Employee', employee_label), cell('Category', record.get('category', ''))],
    ], colWidths=[PAGE_WIDTH / 2, PAGE_WIDTH / 2])
    grid.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (-1, -1), 0),
        ('RIGHTPADDING', (0, 0), (0, -1), COL_GUTTER), ('LEFTPADDING', (1, 0), (1, -1), COL_GUTTER),
        ('TOPPADDING', (0, 0), (-1, -1), 0), ('BOTTOMPADDING', (0, 0), (-1, -1), 8),
    ]))
    return card(styles, 'EMPLOYEE INFORMATION', grid)


def infraction_card(styles, record):
    filed_tier = record.get('tier')
    row = Table([[
        Paragraph(f"Filed as: <b>{xml_escape(TIER_LABELS.get(filed_tier, filed_tier or 'Unknown'))}</b> &mdash; Instance #{xml_escape(str(record.get('instanceNumber', '')))}, suggested sanction: {xml_escape(str(record.get('suggestedSanction') or '—'))}", styles['CellBody']),
    ]], colWidths=[PAGE_WIDTH])
    row.setStyle(TableStyle([('LEFTPADDING', (0, 0), (-1, -1), 0), ('BOTTOMPADDING', (0, 0), (-1, -1), 8), ('TOPPADDING', (0, 0), (-1, -1), 0)]))
    lines = [row, Paragraph('DESCRIPTION', styles['FieldLabel']), Paragraph(xml_escape(record.get('infractionDescription') or '') or '&nbsp;', styles['CellBody'])]
    return card(styles, 'INFRACTION DETAILS', lines)


def pre_review_card(styles, record):
    pre_tier = record.get('preTier')
    row = Table([[Paragraph(f"Reviewed by: <b>{xml_escape(record.get('preDecidedByName') or '')}</b>", styles['CellBody']), tier_badge(styles, pre_tier)]], colWidths=[PAGE_WIDTH - 1.9 * inch, 1.9 * inch])
    row.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'MIDDLE'), ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (0, -1), COL_GUTTER), ('RIGHTPADDING', (1, 0), (1, -1), 0), ('TOPPADDING', (0, 0), (-1, -1), 0), ('BOTTOMPADDING', (0, 0), (-1, -1), 6)]))
    lines = [row, Paragraph(f"Recommended Sanction: <b>{xml_escape(record.get('preSanction') or '')}</b>", styles['CellBody'])]
    if record.get('preNotes'):
        lines.append(Spacer(1, 4))
        lines.append(Paragraph('NOTES FOR HR', styles['FieldLabel']))
        lines.append(Paragraph(xml_escape(record['preNotes']), styles['CellBody']))
    return card(styles, 'PRE-REVIEW (SENIOR OPERATIONS MANAGER)', lines)


def decision_card(styles, record):
    final_tier = record.get('finalTier')
    row = Table([[Paragraph(f"Sanction Date: <b>{xml_escape(record.get('sanctionDate') or '')}</b>", styles['CellBody']), tier_badge(styles, final_tier)]], colWidths=[PAGE_WIDTH - 1.9 * inch, 1.9 * inch])
    row.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'MIDDLE'), ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (0, -1), COL_GUTTER), ('RIGHTPADDING', (1, 0), (1, -1), 0), ('TOPPADDING', (0, 0), (-1, -1), 0), ('BOTTOMPADDING', (0, 0), (-1, -1), 6)]))
    lines = [
        row,
        Paragraph(f"Final Sanction: <b>{xml_escape(record.get('finalSanction') or '')}</b>", styles['CellBody']),
        Paragraph(f"Cleansing Expiry: <b>{xml_escape(record.get('cleansingExpiryDate') or 'Never (Terminable)')}</b>", styles['CellBody']),
    ]
    if record.get('circumstanceNotes'):
        lines.append(Spacer(1, 4))
        lines.append(Paragraph('MITIGATING / AGGRAVATING CIRCUMSTANCE NOTES', styles['FieldLabel']))
        lines.append(Paragraph(xml_escape(record['circumstanceNotes']), styles['CellBody']))
    lines.append(Spacer(1, 4))
    lines.append(Paragraph(f"Decided by: <b>{xml_escape(record.get('decidedByName') or '')}</b>", styles['CellBody']))
    return card(styles, 'HR DECISION', lines)


def logo_header():
    lofty_img = Image(LOFTY_LOGO_PATH, width=1.1 * inch, height=1.1 * inch * (448 / 1368))
    moatable_img = Image(MOATABLE_LOGO_PATH, width=1.5 * inch, height=1.5 * inch * (819 / 1556))
    table = Table([[lofty_img, moatable_img]], colWidths=[PAGE_WIDTH / 2, PAGE_WIDTH / 2])
    table.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'MIDDLE'), ('ALIGN', (0, 0), (0, 0), 'LEFT'), ('ALIGN', (1, 0), (1, 0), 'RIGHT')]))
    return table


def wet_signature_block(styles):
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
    grid = Table([[person_block('Employee'), person_block('HR')]], colWidths=[PAGE_WIDTH / 2, PAGE_WIDTH / 2])
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
    employee_cell = f"<b>{xml_escape(ack.get('signedName', ''))}</b>" if ack else '<i>Awaiting electronic acknowledgment.</i>'
    if ack.get('signedAt'):
        employee_cell += f"<br/>Signed on {xml_escape(str(ack.get('signedAt'))[:16].replace('T', ' '))}."
    hr_cell = f"<b>{xml_escape(record.get('decidedByName', ''))}</b>"
    if record.get('sanctionDate'):
        hr_cell += f"<br/>Decision made on {xml_escape(record.get('sanctionDate'))}."
    grid = Table([
        [Paragraph('EMPLOYEE', styles['FieldLabel']), Paragraph('HR', styles['FieldLabel'])],
        [Paragraph(employee_cell, styles['CellBody']), Paragraph(hr_cell, styles['CellBody'])],
    ], colWidths=[PAGE_WIDTH / 2, PAGE_WIDTH / 2])
    grid.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'TOP'), ('LINEABOVE', (0, 1), (-1, 1), 0.75, LINE), ('TOPPADDING', (0, 1), (-1, 1), 8),
        ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (-1, -1), 0),
        ('RIGHTPADDING', (0, 0), (0, -1), COL_GUTTER), ('LEFTPADDING', (1, 0), (1, -1), COL_GUTTER),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
    ]))
    body = [Paragraph(ACKNOWLEDGMENT_SCRIPT, styles['AckScript']), grid, Spacer(1, 16)]
    body.extend(wet_signature_block(styles))
    if ack.get('employeeComments'):
        body.append(Spacer(1, 10))
        body.append(Paragraph('EMPLOYEE COMMENTS', styles['FieldLabel']))
        body.append(Paragraph(xml_escape(ack['employeeComments']), styles['CellBody']))
    return card(styles, 'ACKNOWLEDGMENT', body)


def build_pdf(out_path, record):
    styles = build_styles()
    doc = SimpleDocTemplate(out_path, pagesize=letter, topMargin=0.55 * inch, bottomMargin=0.55 * inch, leftMargin=0.7 * inch, rightMargin=0.7 * inch)
    story = [
        logo_header(),
        Spacer(1, 10),
        Paragraph('DISCIPLINARY NOTICE', styles['FormTitle']),
        Paragraph("Based on Moatable's Code of Conduct and Discipline.", styles['FormSubtitle']),
        Paragraph(INTRO_SCRIPT, styles['IntroScript']),
        identification_card(styles, record),
        Spacer(1, 12),
        infraction_card(styles, record),
        Spacer(1, 12),
    ]
    if record.get('preDecidedAt'):
        story.append(pre_review_card(styles, record))
        story.append(Spacer(1, 12))
    story += [
        decision_card(styles, record),
        Spacer(1, 12),
        signature_card(styles, record),
    ]
    doc.build(story)


def main():
    # Optional CLI args: specific employee emails to regenerate (the common case - only
    # the rep(s) affected by a sync). With no args, regenerates everyone.
    target_emails = {e.strip().lower() for e in sys.argv[1:] if e.strip()}

    with open(ROSTER_PATH) as f:
        roster = json.load(f)
    with open(DISCIPLINARY_PATH) as f:
        disciplinary = json.load(f)

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
    for record in disciplinary.get('records', []):
        if record.get('status') not in ('DECIDED', 'ACKNOWLEDGED'):
            continue  # not yet decided by HR - no final sanction to print
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
            year = (record.get('infractionDate') or '')[:4]
            if not year:
                continue
            year_dir = os.path.join(REPS_ROOT, folder_name, 'Disciplinary', year)
            os.makedirs(year_dir, exist_ok=True)
            filename = sanitize_filename(f"Disciplinary - {record.get('infractionDate', '')} - {record.get('category', '')}") + '.pdf'
            build_pdf(os.path.join(year_dir, filename), record)
        written += 1

    print(f'Exported disciplinary PDFs for {written} rep(s) under {REPS_ROOT}')


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(f'disciplinary export failed: {e}', file=sys.stderr)
        sys.exit(1)
