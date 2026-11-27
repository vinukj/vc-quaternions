import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.formatting.rule import CellIsRule, FormulaRule
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.utils import get_column_letter
import datetime

# Load original workbook
wb = openpyxl.load_workbook('/Users/vinayjagtap/Downloads/WT-plan.xlsx')

# Clean existing generated sheets
for name in ['Master Gantt Plan', 'Gantt Plan']:
    if name in wb.sheetnames:
        del wb[name]

ws_orig = wb['checklist']
ws = wb.create_sheet(title='Master Gantt Plan')
ws.views.sheetView[0].showGridLines = True

# Parse original data into structured categories
cat_map = {
    'MARKETING': ('1. Marketing & Communications', 'High'),
    'FOUNDATION AND CRITICAL DECISION': ('2. Foundation & Critical Decisions', 'High'),
    'REGISTRATION AND PARTICIPATION': ('3. Registration & Participation', 'High'),
    'Invites (iDENTIFY AND INVITE)': ('4. Invites & Outreach', 'Medium'),
    'TECHNICAL AND STREAMING': ('5. Technical & Streaming', 'High'),
    'ACADEMIC & POSTER': ('6. Academic & Poster Presentations', 'Medium'),
    'HACKATHON': ('7. Hackathon Operations', 'Medium'),
    'LOGISTICS': ('8. Venue & Logistics', 'High'),
    'MEDIA AND DOCUMENTATION': ('9. Media & Documentation', 'Medium'),
    'FINAL AGENDA- LAST WEEK': ('10. Final Agenda & Pre-Event Week', 'High'),
    'CONFERENCE DAY': ('11. Conference Day Execution', 'High'),
    'POST CONFERENCE DAY': ('12. Post Conference Wrap-up', 'Medium'),
    'SPEAKER': ('13. Speaker Management', 'High'),
    'SPONSOR': ('14. Sponsor Management', 'High'),
    'GIFTS AND MOMENTOS': ('15. Gifts & Mementos', 'Medium')
}

sections = []
current_sec = "1. Marketing & Communications"
current_priority = "High"
current_tasks = []

for r in range(1, ws_orig.max_row + 1):
    vals = [ws_orig.cell(row=r, column=c).value for c in range(1, 10)]
    if not any(vals):
        continue
    
    b_val = str(vals[1]).strip() if vals[1] is not None else ""
    c_val = str(vals[2]).strip() if vals[2] is not None else ""
    d_val = str(vals[3]).strip() if vals[3] is not None else ""
    e_val = str(vals[4]).strip() if vals[4] is not None else ""
    f_val = str(vals[5]).strip() if vals[5] is not None else ""
    g_val = str(vals[6]).strip() if vals[6] is not None else ""
    h_val = str(vals[7]).strip() if vals[7] is not None else ""
    i_val = str(vals[8]).strip() if vals[8] is not None else ""

    if b_val in cat_map:
        if current_tasks and current_sec:
            sections.append((current_sec, current_priority, current_tasks))
            current_tasks = []
        current_sec, current_priority = cat_map[b_val]
        continue

    # Skip table header lines
    if b_val in ['Category'] or c_val in ['DETAILS'] or d_val in ['STATUS', 'REMARK']:
        continue

    if not b_val:
        continue

    # Clean status
    status = h_val if h_val and h_val != 'Status' else 'Not Done'
    if status in ['Done', 'DONE']:
        norm_status = 'Done'
    elif status in ['In Progress', 'IN PROGRESS', 'In progress']:
        norm_status = 'In Progress'
    else:
        norm_status = 'Not Done'

    scope_parts = []
    if c_val: scope_parts.append(c_val)
    if e_val: scope_parts.append(f"Remark: {e_val}")
    scope = " | ".join(scope_parts)

    owner = f_val if f_val else "Unassigned"

    notes_parts = []
    if d_val and d_val not in ['DONE', 'Done', 'STATUS', 'Template Done']:
        notes_parts.append(d_val)
    if i_val:
        notes_parts.append(i_val)
    notes = " | ".join(notes_parts)

    current_tasks.append({
        'task': b_val,
        'scope': scope,
        'owner': owner,
        'timeline_raw': g_val,
        'status': norm_status,
        'notes': notes
    })

if current_tasks:
    sections.append((current_sec, current_priority, current_tasks))

# Define Styles
FONT_TITLE = Font(name="Calibri", size=16, bold=True, color="1F4E78")
FONT_SUBTITLE = Font(name="Calibri", size=10, italic=True, color="595959")
FONT_TBL_HDR = Font(name="Calibri", size=11, bold=True, color="FFFFFF")
FONT_SEC_HDR = Font(name="Calibri", size=11, bold=True, color="1F4E78")
FONT_KPI_LBL = Font(name="Calibri", size=9, bold=True, color="595959")
FONT_KPI_VAL = Font(name="Calibri", size=14, bold=True, color="1F4E78")

FILL_TBL_HDR = PatternFill(start_color="1F4E78", end_color="1F4E78", fill_type="solid")
FILL_GANTT_HDR = PatternFill(start_color="2F5597", end_color="2F5597", fill_type="solid")
FILL_SEC_HDR = PatternFill(start_color="D9E1F2", end_color="D9E1F2", fill_type="solid")
FILL_KPI = PatternFill(start_color="F2F2F2", end_color="F2F2F2", fill_type="solid")

BORDER_THIN = Border(
    left=Side(style='thin', color='D9D9D9'),
    right=Side(style='thin', color='D9D9D9'),
    top=Side(style='thin', color='D9D9D9'),
    bottom=Side(style='thin', color='D9D9D9')
)

BORDER_CARD = Border(
    left=Side(style='medium', color='1F4E78'),
    right=Side(style='thin', color='D9D9D9'),
    top=Side(style='thin', color='D9D9D9'),
    bottom=Side(style='thin', color='D9D9D9')
)

ALIGN_CENTER = Alignment(horizontal='center', vertical='center', wrap_text=True)
ALIGN_LEFT = Alignment(horizontal='left', vertical='center', wrap_text=True)

# 1. Header Banner
ws['A1'] = "WORLD TRANSFORMATION (WT) CONFERENCE - MASTER PROJECT PLAN & DYNAMIC GANTT TRACKER"
ws['A1'].font = FONT_TITLE

ws['A2'] = "Automated Event Management Plan | Dynamic Gantt Timeline, Real-time Status Formatting & Resource Allocation"
ws['A2'].font = FONT_SUBTITLE

# 2. KPI Summary Dashboard Cards
cards = [
    ("B4", "C4", "B5", "C5", "TOTAL TASKS", "=COUNTA(C8:C200)"),
    ("D4", "E4", "D5", "E5", "COMPLETED (DONE)", '=COUNTIF(F8:F200, "Done")'),
    ("F4", "G4", "F5", "G5", "IN PROGRESS", '=COUNTIF(F8:F200, "In Progress")'),
    ("H4", "I4", "H5", "I5", "NOT DONE / PENDING", '=COUNTIF(F8:F200, "Not Done") + COUNTIF(F8:F200, "Not Started")'),
    ("J4", "K4", "J5", "K5", "OVERALL PROGRESS %", '=COUNTIF(F8:F200, "Done") / COUNTA(C8:C200)')
]

for l_m1, l_m2, v_m1, v_m2, title, formula in cards:
    ws.merge_cells(f"{l_m1}:{l_m2}")
    ws.merge_cells(f"{v_m1}:{v_m2}")
    
    lbl_cell = ws[l_m1]
    lbl_cell.value = title
    lbl_cell.font = FONT_KPI_LBL
    lbl_cell.fill = FILL_KPI
    lbl_cell.alignment = ALIGN_CENTER
    
    val_cell = ws[v_m1]
    val_cell.value = formula
    val_cell.font = FONT_KPI_VAL
    val_cell.fill = FILL_KPI
    val_cell.alignment = ALIGN_CENTER
    if "%" in title:
        val_cell.number_format = '0.0%'
    else:
        val_cell.number_format = '#,##0'

    # Apply borders
    for row in ws[f"{l_m1}:{v_m2}"]:
        for c in row:
            c.border = BORDER_CARD

# 3. Table Column Headers
headers_left = [
    ("WBS #", 8),
    ("Phase / Category", 24),
    ("Task Name", 32),
    ("Task Scope & Deliverables", 40),
    ("Owner / Lead", 26),
    ("Status", 14),
    ("Progress %", 12),
    ("Priority", 10),
    ("Start Date", 13),
    ("End Date", 13),
    ("Duration", 10),
    ("Status Notes / Next Steps", 30)
]

for col_idx, (hdr_text, col_w) in enumerate(headers_left, start=1):
    ws.merge_cells(start_row=6, start_column=col_idx, end_row=7, end_column=col_idx)
    cell = ws.cell(row=6, column=col_idx, value=hdr_text)
    cell.font = FONT_TBL_HDR
    cell.fill = FILL_TBL_HDR
    cell.alignment = ALIGN_CENTER
    cell.border = BORDER_THIN
    ws.cell(row=7, column=col_idx).border = BORDER_THIN
    col_letter = get_column_letter(col_idx)
    ws.column_dimensions[col_letter].width = col_w

# Gantt Weekly Timeline Columns (16 Weeks)
base_date = datetime.date(2026, 10, 5) # Week 1 starting Monday Oct 5, 2026
week_dates = [base_date + datetime.timedelta(days=7*i) for i in range(16)]

# Group weeks by month for Row 6
month_groups = {}
for i, d in enumerate(week_dates, start=13): # Col 13 = M
    m_name = d.strftime("%B %Y")
    if m_name not in month_groups:
        month_groups[m_name] = []
    month_groups[m_name].append(i)

for m_name, cols in month_groups.items():
    start_col = cols[0]
    end_col = cols[-1]
    ws.merge_cells(start_row=6, start_column=start_col, end_row=6, end_column=end_col)
    cell = ws.cell(row=6, column=start_col, value=m_name)
    cell.font = FONT_TBL_HDR
    cell.fill = FILL_GANTT_HDR
    cell.alignment = ALIGN_CENTER
    for c in range(start_col, end_col + 1):
        ws.cell(row=6, column=c).border = BORDER_THIN

for i, d in enumerate(week_dates, start=13):
    col_letter = get_column_letter(i)
    cell = ws.cell(row=7, column=i, value=d)
    cell.font = Font(name="Calibri", size=9, bold=True, color="FFFFFF")
    cell.fill = FILL_GANTT_HDR
    cell.alignment = ALIGN_CENTER
    cell.number_format = '"W"' + f'{i-12:02d}' + ' (mm/dd)'
    cell.border = BORDER_THIN
    ws.column_dimensions[col_letter].width = 12

print("Headers & Timeline created successfully.")

# 4. Populate Task Data
current_row = 8
sec_num = 0

all_task_rows = []

for sec_title, sec_priority, tasks in sections:
    sec_num += 1
    # Section Banner Row
    ws.merge_cells(start_row=current_row, start_column=1, end_row=current_row, end_column=28)
    sec_cell = ws.cell(row=current_row, column=1, value=f"PHASE {sec_num}: {sec_title.upper()}")
    sec_cell.font = FONT_SEC_HDR
    sec_cell.fill = FILL_SEC_HDR
    sec_cell.alignment = Alignment(horizontal='left', vertical='center', indent=1)
    
    for c in range(1, 29):
        ws.cell(row=current_row, column=c).border = Border(
            top=Side(style='medium', color='1F4E78'),
            bottom=Side(style='medium', color='1F4E78')
        )
    current_row += 1

    t_num = 0
    for t in tasks:
        t_num += 1
        r = current_row
        all_task_rows.append(r)
        
        wbs_code = f"{sec_num}.{t_num}"
        status_val = t['status']
        
        # Determine sample start / end date based on status and section for initial realistic Gantt chart view
        if status_val == 'Done':
            st_date = datetime.date(2026, 10, 5) + datetime.timedelta(days=(sec_num-1)*2)
            en_date = st_date + datetime.timedelta(days=7)
        elif status_val == 'In Progress':
            st_date = datetime.date(2026, 10, 19) + datetime.timedelta(days=(sec_num-1)*2)
            en_date = st_date + datetime.timedelta(days=14)
        else: # Not Done
            st_date = datetime.date(2026, 11, 16) + datetime.timedelta(days=(sec_num-1)*3)
            en_date = st_date + datetime.timedelta(days=10)

        # Col A: WBS
        ws.cell(row=r, column=1, value=wbs_code).alignment = ALIGN_CENTER
        # Col B: Category
        ws.cell(row=r, column=2, value=sec_title).alignment = ALIGN_LEFT
        # Col C: Task Name
        c_cell = ws.cell(row=r, column=3, value=t['task'])
        c_cell.alignment = ALIGN_LEFT
        c_cell.font = Font(name="Calibri", size=10, bold=True)
        # Col D: Scope
        ws.cell(row=r, column=4, value=t['scope']).alignment = ALIGN_LEFT
        # Col E: Owner
        ws.cell(row=r, column=5, value=t['owner']).alignment = ALIGN_LEFT
        # Col F: Status
        f_cell = ws.cell(row=r, column=6, value=status_val)
        f_cell.alignment = ALIGN_CENTER
        f_cell.font = Font(name="Calibri", size=10, bold=True)
        # Col G: Progress %
        g_cell = ws.cell(row=r, column=7, value=f'=IF(F{r}="Done", 1, IF(F{r}="In Progress", 0.5, 0))')
        g_cell.alignment = ALIGN_CENTER
        g_cell.number_format = '0%'
        # Col H: Priority
        ws.cell(row=r, column=8, value=sec_priority).alignment = ALIGN_CENTER
        # Col I: Start Date
        i_cell = ws.cell(row=r, column=9, value=st_date)
        i_cell.alignment = ALIGN_CENTER
        i_cell.number_format = 'yyyy-mm-dd'
        # Col J: End Date
        j_cell = ws.cell(row=r, column=10, value=en_date)
        j_cell.alignment = ALIGN_CENTER
        j_cell.number_format = 'yyyy-mm-dd'
        # Col K: Duration
        k_cell = ws.cell(row=r, column=11, value=f'=IF(AND(ISNUMBER(I{r}),ISNUMBER(J{r})), J{r}-I{r}+1, "")')
        k_cell.alignment = ALIGN_CENTER
        # Col L: Notes
        ws.cell(row=r, column=12, value=t['notes']).alignment = ALIGN_LEFT

        # Standard cell borders & fonts
        for col_idx in range(1, 13):
            cell = ws.cell(row=r, column=col_idx)
            if col_idx != 3 and col_idx != 6:
                cell.font = Font(name="Calibri", size=10)
            cell.border = BORDER_THIN

        # Gantt Chart Cells (Cols M to AB / 13 to 28)
        for g_col in range(13, 29):
            col_letter = get_column_letter(g_col)
            gantt_formula = f'=IF(AND(ISNUMBER($I{r}), ISNUMBER($J{r})), IF(AND({col_letter}$7 >= $I{r}, {col_letter}$7 <= $J{r} + 6), IF($F{r}="Done", "✓", IF($F{r}="In Progress", "▶", "■")), ""), "")'
            g_cell = ws.cell(row=r, column=g_col, value=gantt_formula)
            g_cell.alignment = ALIGN_CENTER
            g_cell.border = BORDER_THIN
            g_cell.font = Font(name="Calibri", size=10, bold=True)

        current_row += 1

print(f"Populated {len(all_task_rows)} tasks into sheet.")

# 5. Data Validation (Dropdown lists)
dv_status = DataValidation(type="list", formula1='"Done,In Progress,Not Done,Blocked,Not Started"', allow_blank=True)
ws.add_data_validation(dv_status)
dv_status.add(f"F8:F{current_row-1}")

dv_priority = DataValidation(type="list", formula1='"High,Medium,Low"', allow_blank=True)
ws.add_data_validation(dv_priority)
dv_priority.add(f"H8:H{current_row-1}")

# 6. Conditional Formatting
# A. Status Column (Col F)
fill_done = PatternFill(start_color="D4EDDA", end_color="D4EDDA", fill_type="solid")
font_done = Font(color="155724", bold=True)

fill_inp = PatternFill(start_color="CCE5FF", end_color="CCE5FF", fill_type="solid")
font_inp = Font(color="004085", bold=True)

fill_notdone = PatternFill(start_color="F8D7DA", end_color="F8D7DA", fill_type="solid")
font_notdone = Font(color="721C24", bold=True)

fill_blocked = PatternFill(start_color="F5C6CB", end_color="F5C6CB", fill_type="solid")
font_blocked = Font(color="721C24", bold=True)

fill_ns = PatternFill(start_color="E2E3E5", end_color="E2E3E5", fill_type="solid")
font_ns = Font(color="383D41", bold=True)

range_status = f"F8:F{current_row-1}"
ws.conditional_formatting.add(range_status, CellIsRule(operator='equal', formula=['"Done"'], fill=fill_done, font=font_done))
ws.conditional_formatting.add(range_status, CellIsRule(operator='equal', formula=['"In Progress"'], fill=fill_inp, font=font_inp))
ws.conditional_formatting.add(range_status, CellIsRule(operator='equal', formula=['"Not Done"'], fill=fill_notdone, font=font_notdone))
ws.conditional_formatting.add(range_status, CellIsRule(operator='equal', formula=['"Blocked"'], fill=fill_blocked, font=font_blocked))
ws.conditional_formatting.add(range_status, CellIsRule(operator='equal', formula=['"Not Started"'], fill=fill_ns, font=font_ns))

# B. Task Row Highlighting (Cols A:L)
fill_row_done = PatternFill(start_color="F4FBF7", end_color="F4FBF7", fill_type="solid")
fill_row_notdone = PatternFill(start_color="FFF5F5", end_color="FFF5F5", fill_type="solid")

range_rows = f"A8:L{current_row-1}"
ws.conditional_formatting.add(range_rows, FormulaRule(formula=['$F8="Done"'], fill=fill_row_done))
ws.conditional_formatting.add(range_rows, FormulaRule(formula=['$F8="Not Done"'], fill=fill_row_notdone))

# C. Gantt Chart Cell Formatting (Cols M to AB)
fill_gantt_done = PatternFill(start_color="28A745", end_color="28A745", fill_type="solid")
font_gantt_done = Font(color="FFFFFF", bold=True)

fill_gantt_inp = PatternFill(start_color="007BFF", end_color="007BFF", fill_type="solid")
font_gantt_inp = Font(color="FFFFFF", bold=True)

fill_gantt_notdone = PatternFill(start_color="DC3545", end_color="DC3545", fill_type="solid")
font_gantt_notdone = Font(color="FFFFFF", bold=True)

range_gantt = f"M8:AB{current_row-1}"
ws.conditional_formatting.add(range_gantt, CellIsRule(operator='equal', formula=['"✓"'], fill=fill_gantt_done, font=font_gantt_done))
ws.conditional_formatting.add(range_gantt, CellIsRule(operator='equal', formula=['"▶"'], fill=fill_gantt_inp, font=font_gantt_inp))
ws.conditional_formatting.add(range_gantt, CellIsRule(operator='equal', formula=['"■"'], fill=fill_gantt_notdone, font=font_gantt_notdone))

# 7. Freeze Panes
ws.freeze_panes = "D8"

# 8. Save Workbook
wb.save('/Users/vinayjagtap/Downloads/WT-plan.xlsx')
print("Successfully generated and saved Master Gantt Plan to WT-plan.xlsx!")
