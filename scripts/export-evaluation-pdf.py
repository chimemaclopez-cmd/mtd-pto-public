#!/usr/bin/env python3
# Regenerates each rep's evaluation PDFs whenever evaluations.json changes. Called
# automatically by zendesk-proxy.js after every evaluation sync tick (send, acknowledge) -
# one-way mirror (portal -> PDF), same convention as export-coaching-pdf.py. The portal
# (team lead's create/send flow, rep's sign flow) is authoritative; these PDFs are a
# read-only record of what happened.
#
# Layout: Lofty TSR/Reps/<Employee Name>/Evaluations/<Year>/Evaluation - <period> - <date>.pdf
# One PDF per evaluation. Draft records (not yet sent) are skipped - they're still being
# written and aren't a real record yet. This reproduces the source Word doc's own plain
# layout verbatim (title, header fields, instructions, rating scale legend, attribute
# table, comments sections, acknowledgement paragraph, signature lines) rather than a
# redesigned look, keeping the wet-signature lines physically blank for HR filing - the
# online acknowledgment is a separate, faster digital record noted above the signature
# block, not a replacement for it.
import json
import os
import re
import sys
from xml.sax.saxutils import escape as xml_escape
from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, Image, PageBreak

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROSTER_PATH = os.path.join(SCRIPT_DIR, '..', 'data', 'roster.json')
EVALUATIONS_PATH = os.path.join(SCRIPT_DIR, '..', 'data', 'evaluations.json')
APPENDIX_PATH = os.path.join(SCRIPT_DIR, '..', 'data', 'evaluation-appendix.json')
REPS_ROOT = '/Users/mac/Library/CloudStorage/OneDrive-MoatableInc/Lofty PH Repository - Documents/Lofty TSR/Reps'
LOFTY_LOGO_PATH = os.path.join(SCRIPT_DIR, '..', 'shared', 'img', 'lofty-logo.png')
MOATABLE_LOGO_PATH = os.path.join(SCRIPT_DIR, '..', 'shared', 'img', 'moatable-logo.png')

LINE = colors.black
PAGE_WIDTH = 7.1 * inch
COL_GUTTER = 18  # points of breathing room between adjacent columns in 2-column grids

PERIOD_WORD = {'Month 2': 'second', 'Month 3': 'third', 'Month 4': 'fourth'}
PERIOD_ORDINAL = {'Month 2': '2ND', 'Month 3': '3RD', 'Month 4': '4TH'}

# Verbatim from the source Word form.
RATING_SCALE_ITEMS = [
    ('1 - Poor.', 'Rarely achieves/displays the requirement, attitude or behavior; shows a lack of ability which requires significant and immediate improvement; many major problems or lapses are present; employee may need strict supervision or a coaching or mentoring plan is required.'),
    ('2 - Below Average.', 'Achieves/displays some but not all requirements, attitude or behavior in a number of key results areas; inconsistent and needs improvements; some major problem or lapses are present; employee may need a coaching or mentoring plan.'),
    ('3 - Average.', 'Consistently achieves/displays requirements, attitude, or behavior in all key results areas; some lapses exist but not a major concern as solution is made speedily most employees fall on this scale.'),
    ('4 - Above Average.', 'Consistently achieves and often displays requirements, attitude or behavior in a number of key results areas; no lapses exist; employee is one of the keys.'),
    ('5 - Excellent.', 'Significantly and consistently exceeds requirements, attitude, or behavior in all key results areas; exceptional; has championed initiatives and continuous improvements; employee excelled among peers and serves as a role model and mentor to other colleagues.'),
]

COMMENTS_INTRO = (
    "Comments to Evaluator and Employee. Evaluators should discuss the evaluation results with the employee. "
    "At a minimum, employees must be given a copy of the evaluation for their own records. Both the evaluator "
    "and the employee should sign the evaluation form. The employee signature indicates only that the employee "
    "received a copy of the evaluation. It does not necessarily signify employee concurrence. Both employees "
    "and evaluators are strongly encouraged to include written comments."
)

# Verbatim from the source Word form, including its own grammatical quirk ("comments
# indicate on the above section") - not cleaned up, per explicit instruction to reproduce
# the form exactly as-is.
ACKNOWLEDGMENT_SCRIPT = (
    "I have reviewed and discussed the contents with my supervisor. My signature means that I have been "
    "advised of my performance and that I agree with this evaluation with my own comments indicate on the above section."
)

# (key, label, description) - description text is verbatim from the source Word form, so the
# printed HR copy shows exactly what each rating means, not just a bare attribute name.
ATTRIBUTE_LABELS = [
    ('quantityOfWork', 'Quantity of Work', 'The extent to which the employee accomplishes assigned work of a specified quality within a specified time period'),
    ('qualityOfWork', 'Quality of Work', "The extent to which the employee's work is well executed, thorough, effective, accurate."),
    ('jobKnowledge', 'Job Knowledge', 'Possesses and continually updates requisite knowledge and understanding of assigned duties, responsibilities, policies, procedures and compliance requirements to perform the position. Demonstrates technical skills required for the position. Understands business needs and desired outcomes.'),
    ('dependabilityAccountabilityProfessionalism', 'Dependability / Accountability / Professionalism', 'Follows through on assignments. Takes ownership of work. Is reliable, professional and responsible. Adheres to procedures, practices, and work schedule. Work is completed in a timely manner and within established deadlines effectively using resources. Demonstrates commitment to professional development.'),
    ('attendanceAndReliability', 'Attendance and Reliability', 'The extent to which employee arrives on time and demonstrates consistent attendance; the extent to which the employee contacts supervisor on a timely basis when employee will be late or absent.'),
    ('speedAndExecutiveAbility', 'Speed and Executive Ability', 'The extent to which the employee is self-directed, and reacts quickly in meeting job objectives; consider how fast the employee follows through on assignments.'),
    ('capacityToDevelop', 'Capacity to Develop', 'The extent to which the employee demonstrates the ability and willingness to accept new/more complex duties/responsibilities.'),
    ('leadershipManagement', 'Leadership / Management (supervisor or manager level)', 'Establishes clear vision for staff and motivates employees to achieve their best performance. Engages and motivates staff, coaching for peak performance. Makes outreach efforts and uses resources to create a diverse workforce. Leads and manages change. Builds and manages relationships across the department. Participate company projects or programs to motivate staff to improve their performance.'),
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
    styles.add(ParagraphStyle('FormTitle', parent=styles['Title'], fontName='Helvetica-Bold', fontSize=14, leading=18, spaceAfter=10, alignment=1))
    styles.add(ParagraphStyle('SectionHeading', parent=styles['Normal'], fontName='Helvetica-Bold', fontSize=10.5, spaceBefore=10, spaceAfter=4))
    styles.add(ParagraphStyle('CenterHeading', parent=styles['Normal'], fontName='Helvetica-Bold', fontSize=11, spaceBefore=10, spaceAfter=4, alignment=1))
    styles.add(ParagraphStyle('FieldLine', parent=styles['Normal'], fontName='Helvetica', fontSize=9.5, leading=14))
    styles.add(ParagraphStyle('BodyText9', parent=styles['Normal'], fontName='Helvetica', fontSize=9, leading=12.5, spaceAfter=6))
    styles.add(ParagraphStyle('ScaleItem', parent=styles['Normal'], fontName='Helvetica', fontSize=8.3, leading=11.5, spaceAfter=4))
    styles.add(ParagraphStyle('TableHeader', parent=styles['Normal'], fontName='Helvetica-Bold', fontSize=9, alignment=1))
    styles.add(ParagraphStyle('AppendixTableHeader', parent=styles['Normal'], fontName='Helvetica-Bold', fontSize=7.5, leading=9, alignment=1))
    styles.add(ParagraphStyle('CellBody', parent=styles['Normal'], fontName='Helvetica', fontSize=9, leading=12.5))
    styles.add(ParagraphStyle('CellBodyCenter', parent=styles['Normal'], fontName='Helvetica-Bold', fontSize=10.5, leading=13, alignment=1))
    styles.add(ParagraphStyle('AckScript', parent=styles['Normal'], fontName='Helvetica', fontSize=9, leading=13, spaceAfter=8))
    styles.add(ParagraphStyle('OnlineNote', parent=styles['Normal'], fontName='Helvetica-Oblique', fontSize=8.5, textColor=colors.HexColor('#444444'), leading=12, spaceAfter=14))
    return styles


def logo_header():
    lofty_img = Image(LOFTY_LOGO_PATH, width=1.1 * inch, height=1.1 * inch * (448 / 1368))
    moatable_img = Image(MOATABLE_LOGO_PATH, width=1.5 * inch, height=1.5 * inch * (819 / 1556))
    table = Table([[lofty_img, moatable_img]], colWidths=[PAGE_WIDTH / 2, PAGE_WIDTH / 2])
    table.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'MIDDLE'), ('ALIGN', (0, 0), (0, 0), 'LEFT'), ('ALIGN', (1, 0), (1, 0), 'RIGHT')]))
    return table


def identification_block(styles, record):
    def cell(label, value):
        return Paragraph(f"<b>{xml_escape(label)}:</b> {xml_escape(str(value or ''))}", styles['FieldLine'])
    employee_label = record.get('employeeName', '')
    if record.get('employeeId'):
        employee_label = f"{employee_label} ({record['employeeId']})"
    grid = Table([
        [cell('Employee Name', employee_label), cell('Immediate Manager', record.get('teamLeadName', ''))],
        [cell('Business Unit', record.get('businessUnit', '')), cell('Hire Date', record.get('hireDate', ''))],
        [cell('Position', record.get('position', '')), cell('Evaluation Period', record.get('evaluationPeriod', ''))],
    ], colWidths=[PAGE_WIDTH / 2, PAGE_WIDTH / 2])
    grid.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (-1, -1), 0),
        ('RIGHTPADDING', (0, 0), (0, -1), COL_GUTTER), ('LEFTPADDING', (1, 0), (1, -1), COL_GUTTER),
        ('TOPPADDING', (0, 0), (-1, -1), 0), ('BOTTOMPADDING', (0, 0), (-1, -1), 8),
    ]))
    return grid


def instructions_and_scale(styles, period_label):
    # Verbatim from the source Word form (the 3rd Month template) - only the month word
    # itself is swapped in for the Month 2/4 periods, since Lofty only has one physical
    # template (3rd Month) and the other two periods' real forms aren't available to copy
    # from directly; every other word is unchanged from the source.
    period_word = PERIOD_WORD.get(period_label, 'third')
    instructions = (
        "Instructions to Evaluator:  Evaluators should refer to the employee's job description when completing "
        "this form; the evaluation should focus on the employee's ability to perform the job duties listed in "
        f"the job description.  Employees should be evaluated at {period_word} month. Indicate the evaluation "
        "of the employee's job performance by writing a number between 1 to 5 on the blank line to the right "
        "of each attribute, in the appropriate column. Use the following scale:"
    )
    flow = [Paragraph(instructions, styles['BodyText9']), Paragraph('Rating Scale:', styles['SectionHeading'])]
    for bold_prefix, rest in RATING_SCALE_ITEMS:
        flow.append(Paragraph(f"<b>{xml_escape(bold_prefix)}</b> {xml_escape(rest)}", styles['ScaleItem']))
    flow.append(Paragraph('See the reverse side of this form for additional comments to the evaluator and the employee.', styles['BodyText9']))
    return flow


def evaluation_average_score(ratings):
    # Average of whichever attributes actually have a 1-5 rating - N/A ones (normally just
    # Leadership/Management) are excluded from both the sum and the count, not treated as 0.
    # Matches the source form's own convention: the header cell above the attribute rows
    # holds the date and this average together.
    values = [v for v in (ratings or {}).values() if isinstance(v, (int, float))]
    if not values:
        return None
    return round(sum(values) / len(values), 2)


def ratings_table(styles, record):
    ratings = record.get('ratings') or {}
    avg = evaluation_average_score(ratings)
    avg_text = '&mdash;' if avg is None else f'{avg:.2f}'
    period = xml_escape((record.get('evaluationPeriod') or '').upper())
    date_text = xml_escape(record.get('evaluationDate') or '')
    rows = [[
        Paragraph('ATTRIBUTE', styles['TableHeader']),
        Paragraph(f'DATE<br/>{date_text}', styles['TableHeader']),
        Paragraph(f'{period}<br/>Avg: {avg_text}', styles['TableHeader']),
    ]]
    for key, label, description in ATTRIBUTE_LABELS:
        value = ratings.get(key)
        value_text = 'N/A' if value is None else str(value)
        cell_text = f"<b>{xml_escape(label)}</b><br/><font size=8 color='#444444'>{xml_escape(description)}</font>"
        rows.append([
            Paragraph(cell_text, styles['CellBody']),
            Paragraph('', styles['CellBody']),
            Paragraph(value_text, styles['CellBodyCenter']),
        ])
    table = Table(rows, colWidths=[PAGE_WIDTH * 0.66, PAGE_WIDTH * 0.15, PAGE_WIDTH * 0.19])
    table.setStyle(TableStyle([
        ('GRID', (0, 0), (-1, -1), 0.75, LINE),
        ('LEFTPADDING', (0, 0), (-1, -1), 6), ('RIGHTPADDING', (0, 0), (-1, -1), 6),
        ('TOPPADDING', (0, 0), (-1, -1), 5), ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'), ('VALIGN', (0, 0), (-1, 0), 'MIDDLE'),
    ]))
    return table


def comments_section(styles, record):
    def comment_box(heading, text):
        box = Table([[Paragraph(xml_escape(text) if text else '&nbsp;', styles['CellBody'])]], colWidths=[PAGE_WIDTH])
        box.setStyle(TableStyle([
            ('BOX', (0, 0), (-1, -1), 0.75, LINE),
            ('LEFTPADDING', (0, 0), (-1, -1), 8), ('RIGHTPADDING', (0, 0), (-1, -1), 8),
            ('TOPPADDING', (0, 0), (-1, -1), 8), ('BOTTOMPADDING', (0, 0), (-1, -1), 24),
        ]))
        return [Paragraph(heading, styles['SectionHeading']), box]

    flow = [Paragraph(COMMENTS_INTRO, styles['BodyText9'])]
    flow.extend(comment_box('Employee Comments (please include date; attach additional paper if necessary):', record.get('employeeComments')))
    flow.append(Spacer(1, 8))
    flow.extend(comment_box('Evaluator Comments (please include date; attach additional paper if necessary):', record.get('evaluatorComments')))
    return flow


def wet_signature_line(styles, name_label):
    # For the printed copy submitted to HR: an actual pen-and-paper signature line per
    # person, paired with its own Date line on the same row - matching the source form's
    # layout exactly. Never auto-filled with the typed e-signature name.
    row = Table([['', '', '']], colWidths=[3.9 * inch, 0.35 * inch, 1.6 * inch])
    row.setStyle(TableStyle([
        ('LINEBELOW', (0, 0), (0, 0), 0.75, colors.black), ('LINEBELOW', (2, 0), (2, 0), 0.75, colors.black),
        ('TOPPADDING', (0, 0), (-1, -1), 20), ('BOTTOMPADDING', (0, 0), (-1, -1), 2),
        ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (-1, -1), 0),
    ]))
    labels = Table([[
        Paragraph(f'{name_label} Signature', styles['CellBody']),
        Paragraph('', styles['CellBody']),
        Paragraph('Date', styles['CellBody']),
    ]], colWidths=[3.9 * inch, 0.35 * inch, 1.6 * inch])
    labels.setStyle(TableStyle([
        ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (-1, -1), 0),
        ('TOPPADDING', (0, 0), (-1, -1), 2), ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
    ]))
    return [row, labels]


def pct_text(value):
    return '&mdash;' if value is None else f'{value:.1f}%'


def kpi_appendix_table(styles, kpi_rows):
    header = ['PERIOD', 'DAYS\nWORKED', 'PRODUCTIVITY', 'CSAT', 'PROCESS\nCOMPLIANCE', 'ATTENDANCE', 'TOTAL\nSCORE']
    rows = [[Paragraph(h.replace('\n', '<br/>'), styles['AppendixTableHeader']) for h in header]]
    for row in kpi_rows:
        kind_label = 'calls' if row.get('productivityKind') == 'calls' else 'tickets'
        productivity_raw = row.get('productivityRaw')
        productivity_text = '&mdash;' if productivity_raw is None else f"{productivity_raw} {kind_label}/day<br/><font size=7.5 color='#444444'>{row.get('productivityTotal') or 0} total &middot; Tier {pct_text(row.get('productivityTier'))}</font>"
        csat_text = '&mdash;' if row.get('csatRaw') is None else f"{pct_text(row.get('csatRaw'))}<br/><font size=7.5 color='#444444'>Tier {pct_text(row.get('csatTier'))}</font>"
        total = row.get('totalScore')
        total_text = '&mdash;' if total is None else f"<b>{total:.2f}%</b>" + (' <font size=7.5 color=\'#444444\'>(partial)</font>' if row.get('totalScoreProvisional') else '')
        rows.append([
            Paragraph(f"Month {row['periodNumber']}<br/><font size=7.5 color='#444444'>{xml_escape(row.get('periodStart',''))} &ndash; {xml_escape(row.get('periodEnd',''))}</font>", styles['CellBody']),
            Paragraph(str(row.get('workedDays') if row.get('workedDays') is not None else '&mdash;'), styles['CellBody']),
            Paragraph(productivity_text, styles['CellBody']),
            Paragraph(csat_text, styles['CellBody']),
            Paragraph(pct_text(row.get('complianceRaw')), styles['CellBody']),
            Paragraph(pct_text(row.get('attendanceRaw')), styles['CellBody']),
            Paragraph(total_text, styles['CellBody']),
        ])
    widths = [PAGE_WIDTH * w for w in (0.16, 0.09, 0.21, 0.14, 0.15, 0.12, 0.13)]
    table = Table(rows, colWidths=widths)
    table.setStyle(TableStyle([
        ('GRID', (0, 0), (-1, -1), 0.75, LINE),
        ('LEFTPADDING', (0, 0), (-1, -1), 5), ('RIGHTPADDING', (0, 0), (-1, -1), 5),
        ('TOPPADDING', (0, 0), (-1, -1), 5), ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
    ]))
    return table


def coaching_appendix_table(styles, coaching_logs):
    if not coaching_logs:
        return Paragraph('No coaching sessions on file for this period.', styles['BodyText9'])
    rows = [[Paragraph(h, styles['TableHeader']) for h in ['DATE', 'CATEGORY', 'STANDING', 'DISCUSSION SUMMARY', 'STATUS']]]
    for log in coaching_logs:
        rows.append([
            Paragraph(xml_escape(log.get('coachingDate') or ''), styles['CellBody']),
            Paragraph(xml_escape(log.get('category') or ''), styles['CellBody']),
            Paragraph(xml_escape(log.get('standingSummary') or ''), styles['CellBody']),
            Paragraph(xml_escape((log.get('discussionSummary') or '')[:400]), styles['CellBody']),
            Paragraph(xml_escape(log.get('status') or ''), styles['CellBody']),
        ])
    widths = [PAGE_WIDTH * w for w in (0.11, 0.14, 0.13, 0.5, 0.12)]
    table = Table(rows, colWidths=widths)
    table.setStyle(TableStyle([
        ('GRID', (0, 0), (-1, -1), 0.75, LINE),
        ('LEFTPADDING', (0, 0), (-1, -1), 5), ('RIGHTPADDING', (0, 0), (-1, -1), 5),
        ('TOPPADDING', (0, 0), (-1, -1), 5), ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
    ]))
    return table


def appendix_section(styles, appendix_data):
    kpi_rows = appendix_data.get('kpiRows') or []
    coaching_logs = appendix_data.get('coachingLogs') or []
    flow = [Paragraph('Appendix: Probationary KPI Metrics &amp; Coaching Logs', styles['FormTitle'])]
    flow.append(Paragraph(
        'Running KPI scores and coaching history for this employee through the period covered by this evaluation, '
        'pulled from the portal at the time this evaluation was generated - not a live/updating record.',
        styles['BodyText9']
    ))
    flow.append(Spacer(1, 6))
    flow.append(Paragraph('KPI Score History', styles['SectionHeading']))
    if kpi_rows:
        flow.append(kpi_appendix_table(styles, kpi_rows))
    else:
        flow.append(Paragraph('No KPI data available for this employee/period.', styles['BodyText9']))
    flow.append(Spacer(1, 12))
    flow.append(Paragraph('Coaching Logs', styles['SectionHeading']))
    flow.append(coaching_appendix_table(styles, coaching_logs))
    return flow


def acknowledgement_section(styles, record):
    ack = record.get('acknowledgment') or {}
    online_note = (
        f"Reviewed online by <b>{xml_escape(ack.get('signedName', ''))}</b> on {format_timestamp(ack.get('signedAt'))}. "
        "A wet signature below is still required for the HR file copy."
        if ack.get('signedName') else '<i>Awaiting the employee&#8217;s online review.</i>'
    )
    flow = [
        Paragraph('Acknowledgement', styles['CenterHeading']),
        Paragraph(ACKNOWLEDGMENT_SCRIPT, styles['AckScript']),
        Paragraph(online_note, styles['OnlineNote']),
    ]
    flow.extend(wet_signature_line(styles, 'Employee'))
    flow.append(Spacer(1, 10))
    flow.extend(wet_signature_line(styles, 'Manager/Supervisor'))
    return flow


def build_pdf(out_path, record, appendix_data=None):
    styles = build_styles()
    doc = SimpleDocTemplate(out_path, pagesize=letter, topMargin=0.55 * inch, bottomMargin=0.55 * inch, leftMargin=0.7 * inch, rightMargin=0.7 * inch)
    evaluation_period = record.get('evaluationPeriod') or ''
    ordinal = PERIOD_ORDINAL.get(evaluation_period, '3RD')
    story = [
        logo_header(),
        Spacer(1, 10),
        # Verbatim source title: "EMPLOYEE PERFORMANCE EVALUATION FOR 3RD MONTH" (with the
        # ordinal suffix superscripted, matching the Word doc's own auto-formatting), not
        # "FOR MONTH 3" - the word order and the ordinal form both matter for an exact copy.
        Paragraph(f'EMPLOYEE PERFORMANCE EVALUATION FOR {ordinal[:-2]}<super>{ordinal[-2:]}</super> MONTH', styles['FormTitle']),
        identification_block(styles, record),
        Spacer(1, 4),
    ]
    story.extend(instructions_and_scale(styles, record.get('evaluationPeriod') or ''))
    story.append(Spacer(1, 8))
    story.append(ratings_table(styles, record))
    story.append(Spacer(1, 10))
    story.extend(comments_section(styles, record))
    story.append(Spacer(1, 10))
    story.extend(acknowledgement_section(styles, record))
    # KPI/coaching appendix is a second page, added only when data was available at export
    # time - a rep with no probation-KPI or coaching history yet still gets a clean one-page
    # evaluation, not an empty appendix page.
    if appendix_data:
        story.append(PageBreak())
        story.extend(appendix_section(styles, appendix_data))
    doc.build(story)


def main():
    # Optional CLI args: specific employee emails to regenerate (the common case - only
    # the rep(s) affected by a sync). With no args, regenerates everyone.
    target_emails = {e.strip().lower() for e in sys.argv[1:] if e.strip()}

    with open(ROSTER_PATH) as f:
        roster = json.load(f)
    with open(EVALUATIONS_PATH) as f:
        evaluations = json.load(f)
    # Built by zendesk-proxy.js's buildEvaluationAppendixData() right before this script runs -
    # may not exist yet on a fresh checkout, or may simply have nothing for a given
    # employee/period (e.g. no probation-KPI/coaching data at all), so a missing file or a
    # missing lookup key are both normal, not errors - just no appendix page for that record.
    appendix_by_email = {}
    if os.path.exists(APPENDIX_PATH):
        try:
            with open(APPENDIX_PATH) as f:
                appendix_by_email = json.load(f)
        except (json.JSONDecodeError, OSError):
            appendix_by_email = {}

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
            period_digits = re.sub(r'\D', '', record.get('evaluationPeriod') or '')
            appendix_data = appendix_by_email.get(email.lower(), {}).get(period_digits) if period_digits else None
            build_pdf(os.path.join(year_dir, filename), record, appendix_data)
        written += 1

    print(f'Exported evaluation PDFs for {written} rep(s) under {REPS_ROOT}')


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(f'evaluation export failed: {e}', file=sys.stderr)
        sys.exit(1)
