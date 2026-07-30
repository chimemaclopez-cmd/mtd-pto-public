#!/usr/bin/env python3
# Regenerates each rep's coaching session PDFs whenever coaching.json changes. Called
# automatically by zendesk-proxy.js after every coaching sync tick (send, acknowledge) -
# one-way mirror (portal -> PDF), same convention as export-attendance-xlsx.py. The
# portal (team lead's create/send flow, rep's sign flow) is authoritative; these PDFs are
# a read-only record of what happened, matching the layout of HR's own
# Coaching_Form_Lofty_Truckerpath.docx template (scripts/templates/).
#
# Layout: Lofty TSR/Reps/<Employee Name>/Coaching/<Year>/Coaching Session <N> - <date>.pdf
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
    styles.add(ParagraphStyle('FormTitle', parent=styles['Title'], fontName='Helvetica-Bold', fontSize=18, spaceAfter=2))
    styles.add(ParagraphStyle('FormSubtitle', parent=styles['Normal'], fontName='Helvetica-Oblique', fontSize=9, textColor=colors.HexColor('#5B6274'), spaceAfter=14, alignment=1))
    styles.add(ParagraphStyle('SectionHeading', parent=styles['Heading2'], fontName='Helvetica-Bold', fontSize=11, textColor=NAVY, spaceBefore=14, spaceAfter=6))
    styles.add(ParagraphStyle('FieldLabel', parent=styles['Normal'], fontName='Helvetica-Bold', fontSize=9.5, spaceAfter=1))
    styles.add(ParagraphStyle('FieldValue', parent=styles['Normal'], fontName='Helvetica', fontSize=9.5, spaceAfter=8, leading=13))
    styles.add(ParagraphStyle('CellHeader', parent=styles['Normal'], fontName='Helvetica-Bold', fontSize=9, textColor=colors.white))
    styles.add(ParagraphStyle('CellBody', parent=styles['Normal'], fontName='Helvetica', fontSize=9, leading=12))
    return styles


def field_block(styles, label, value):
    return [Paragraph(label, styles['FieldLabel']), Paragraph(value or '&nbsp;', styles['FieldValue'])]


def header_table(styles, record):
    def cell(label, value):
        return Paragraph(f"<b>{label}:</b> {value or ''}", styles['CellBody'])
    rows = [
        [cell('Date', record.get('coachingDate', '')), cell('Coach', record.get('teamLeadName', ''))],
        [cell('Employee Name', record.get('employeeName', '')), cell('Session No.', str(record.get('sessionNumber', '')))],
        [cell('Entity', record.get('entity', 'Lofty')), cell('Role / Department', record.get('roleDepartment', ''))],
    ]
    table = Table(rows, colWidths=[3.15 * inch, 3.15 * inch])
    table.setStyle(TableStyle([
        ('BOX', (0, 0), (-1, -1), 0.75, LINE), ('INNERGRID', (0, 0), (-1, -1), 0.75, LINE),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'), ('LEFTPADDING', (0, 0), (-1, -1), 8), ('TOPPADDING', (0, 0), (-1, -1), 6), ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
    ]))
    return table


def grid_table(styles, headers, rows, col_widths):
    data = [[Paragraph(h, styles['CellHeader']) for h in headers]]
    for row in rows:
        data.append([Paragraph(str(v) if v else '&nbsp;', styles['CellBody']) for v in row])
    table = Table(data, colWidths=col_widths, repeatRows=1)
    table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), NAVY), ('BOX', (0, 0), (-1, -1), 0.75, LINE), ('INNERGRID', (0, 0), (-1, -1), 0.75, LINE),
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
        Paragraph('I. PRELIMINARIES', styles['SectionHeading']),
        *field_block(styles, 'Goal for today', record.get('goalForToday')),
        *field_block(styles, 'Specific Issues', record.get('specificIssues')),
        Paragraph('II. REFLECTION FROM LAST SESSION', styles['SectionHeading']),
        *field_block(styles, 'Wins and Successes', record.get('winsAndSuccesses')),
        *field_block(styles, 'Challenges', record.get('challenges')),
        Paragraph("III. TODAY'S AGENDA", styles['SectionHeading']),
        grid_table(styles, ['Review of Action Items from Last Session', 'New Topics or Concerns'],
                   [[record.get('reviewActionItems', ''), record.get('newTopicsOrConcerns', '')]], [3.15 * inch, 3.15 * inch]),
        Spacer(1, 12),
        Paragraph('IV. COACHING DISCUSSION', styles['SectionHeading']),
        grid_table(styles, ['Discussion Point', 'Insight / Learning', 'Action Plan', 'Resources or Support'],
                   [[r.get('discussionPoint', ''), r.get('insightLearning', ''), r.get('actionPlan', ''), r.get('resourcesSupport', '')] for r in (record.get('discussionRows') or [{}])],
                   [1.65 * inch, 1.65 * inch, 1.65 * inch, 1.35 * inch]),
        Spacer(1, 12),
        Paragraph("V. COACHEE'S FEEDBACK ON THE SESSION", styles['SectionHeading']),
    ]
    ack = record.get('acknowledgment') or {}
    if ack:
        story += [
            *field_block(styles, 'What is most valuable', ack.get('coacheeValuable')),
            *field_block(styles, 'What could be improved', ack.get('coacheeImprove')),
        ]
    else:
        story.append(Paragraph('(Not yet completed by the coachee)', styles['FieldValue']))
    story += [
        Paragraph("VI. COACH'S NOTES", styles['SectionHeading']),
        grid_table(styles, ['Coach Reflections', 'Next Session Focus', 'Next Session Date'],
                   [[record.get('coachReflections', ''), record.get('nextSessionFocus', ''), record.get('nextSessionDate', '')]],
                   [2.3 * inch, 2.3 * inch, 1.7 * inch]),
        Spacer(1, 18),
        Paragraph('Acknowledgment', styles['SectionHeading']),
        grid_table(styles, ['Coachee', 'Coach'], [[
            f"{ack.get('signedName', '')}<br/>Electronically acknowledged via the Lofty Support Portal on {format_timestamp(ack.get('signedAt'))}."
            if ack.get('signedName') else 'Awaiting electronic acknowledgment by the coachee.',
            f"{record.get('teamLeadName', '')}<br/>Session shared with the coachee via the Lofty Support Portal on {format_timestamp(record.get('sentAt'))}."
            if record.get('sentAt') else record.get('teamLeadName', ''),
        ]], [3.15 * inch, 3.15 * inch]),
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
            filename = sanitize_filename(f"Coaching Session {record.get('sessionNumber', '?')} - {record.get('coachingDate', '')}") + '.pdf'
            build_pdf(os.path.join(year_dir, filename), record)
        written += 1

    print(f'Exported coaching PDFs for {written} rep(s) under {REPS_ROOT}')


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(f'coaching export failed: {e}', file=sys.stderr)
        sys.exit(1)
