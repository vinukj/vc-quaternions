import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.formatting.rule import CellIsRule, FormulaRule
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.utils import get_column_letter
import datetime
import sys

def process_file(file_path):
    print(f"Processing: {file_path}")
    try:
        wb = openpyxl.load_workbook(file_path)
    except Exception as e:
        print(f"Error loading {file_path}: {e}")
        return

    # Clean existing generated sheets
    for name in ['Master Gantt Plan', 'Gantt Plan', 'Project Plan']:
        if name in wb.sheetnames:
            del wb[name]

    if 'checklist' not in wb.sheetnames:
        print(f"Skipping {file_path} - 'checklist' sheet not found.")
        return

    ws_orig = wb['checklist']
    ws = wb.create_sheet(title='Master Gantt Plan')
    ws.views.sheetView[0].showGridLines = True

    # Section mapping and categorization
    cat_map = {
        'MARKETING': ('1. Marketing & Communications', 'High', (1, 7)), # Weeks relative to start
        'FOUNDATION AND CRITICAL DECISION': ('2. Foundation & Critical Decisions', 'High', (1, 6)),
        'REGISTRATION AND PARTICIPATION': ('3. Registration & Participation', 'High', (2, 8)),
        'Invites (iDENTIFY AND INVITE)': ('4. Invites & Outreach', 'Medium', (3, 7)),
        'TECHNICAL AND STREAMING': ('5. Technical & Streaming', 'High', (5, 9)),
        'ACADEMIC & POSTER': ('6. Academic & Poster Presentations', 'Medium', (2, 8)),
        'HACKATHON': ('7. Hackathon Operations', 'Medium', (3, 8)),
        'LOGISTICS': ('8. Venue & Logistics', 'High', (6, 9)),
        'MEDIA AND DOCUMENTATION': ('9. Media & Documentation', 'Medium', (7, 9)),
        'FINAL AGENDA- LAST WEEK': ('10. Final Agenda & Pre-Event Week', 'High', (9, 9)),
        'CONFERENCE DAY': ('11. Conference Day Execution', 'High', (10, 10)),
        'POST CONFERENCE DAY': ('12. Post Conference Wrap-up', 'Medium', (11, 12)),
        'SPEAKER': ('13. Speaker Management', 'High', (1, 9)),
        'SPONSOR': ('14. Sponsor Management', 'High', (1, 9)),
        'GIFTS AND MOMENTOS': ('15. Gifts & Mementos', 'Medium', (4, 9))
    }

    # Timeline Setup (Dec 7 is Monday of Event Week - W10)
    # W01: Oct 05, 2026
    # W09: Nov 30 (Final Prep Week)
    # W10: Dec 07 (Event Week)
    # W11: Dec 14 (Post Event Week)
    timeline_base = datetime.date(2026, 10, 5)
    week_start_dates = [timeline_base + datetime.timedelta(days=7*i) for i in range(16)]

    sections = []
    current_sec = None
    current_priority = "High"
    current_weeks = (1, 8)
    current_tasks = []

    for r in range(1, ws_orig.max_row + 1):
        vals = [ws_orig.cell(row=r, column=c).value for c in range(1, 10)]
        if not any(vals): continue
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
                sections.append((current_sec, current_priority, current_weeks, current_tasks))
                current_tasks = []
            current_sec, current_priority, current_weeks = cat_map[b_val]
            continue
        if b_val in ['Category'] or c_val in ['DETAILS'] or d_val in ['STATUS', 'REMARK']:
            continue
        if not b_val: continue

        status = h_val if h_val and h_val != 'Status' else 'Not Done'
        if status in ['Done', 'DONE']: norm_status = 'Done'
        elif status in ['In Progress', 'IN PROGRESS', 'In progress']: norm_status = 'In Progress'
        else: norm_status = 'Not Done'

        current_tasks.append({
            'task': b_val, 'scope': f"{c_val} | {e_val}".strip(" |"),
            'owner': f_val or "Unassigned", 'timeline_raw': g_val,
            'status': norm_status, 'notes': f"{d_val} | {i_val}".strip(" |")
        })
    if current_tasks:
        sections.append((current_sec, current_priority, current_weeks, current_tasks))

    # Styles
    FONT_TITLE = Font(name="Calibri", size=18, bold=True, color="1F4E78")
    FONT_SUBTITLE = Font(name="Calibri", size=10, italic=True, color="595959")
    FONT_TBL_HDR = Font(name="Calibri", size=11, bold=True, color="FFFFFF")
    FONT_SEC_HDR = Font(name="Calibri", size=11, bold=True, color="1F4E78")
    FILL_TBL_HDR = PatternFill(start_color="1F4E78", end_color="1F4E78", fill_type="solid")
    FILL_GANTT_HDR = PatternFill(start_color="2F5597", end_color="2F5597", fill_type="solid")
    FILL_SEC_HDR = PatternFill(start_color="D9E1F2", end_color="D9E1F2", fill_type="solid")
    BORDER_THIN = Border(left=Side(style='thin', color='D9D9D9'), right=Side(style='thin', color='D9D9D9'), top=Side(style='thin', color='D9D9D9'), bottom=Side(style='thin', color='D9D9D9'))
    ALIGN_CENTER = Alignment(horizontal='center', vertical='center', wrap_text=True)
    ALIGN_LEFT = Alignment(horizontal='left', vertical='center', wrap_text=True)

    # 1. Title Banner
    ws['A1'] = "WEARABLE TECHNOLOGY (WT) CONFERENCE - MASTER PROJECT PLAN & DYNAMIC GANTT TRACKER"
    ws['A1'].font = FONT_TITLE
    ws['A2'] = "Event Launch: Dec 2nd Week (Dec 7, 2026) | All Preparations Complete by: Dec 6, 2026 (End of 1st Week of Dec)"
    ws['A2'].font = FONT_SUBTITLE

    # 2. Row 6/7 Headers (Timeline & Columns)
    headers = [("WBS", 8), ("Phase", 24), ("Task Name", 32), ("Scope", 40), ("Owner", 26), ("Status", 14), ("Progress", 12), ("Priority", 10), ("Start", 13), ("End", 13), ("Dur", 8), ("Notes", 30)]
    for idx, (txt, w) in enumerate(headers, 1):
        ws.merge_cells(start_row=6, start_column=idx, end_row=7, end_column=idx)
        cell = ws.cell(row=6, column=idx, value=txt)
        cell.font = FONT_TBL_HDR; cell.fill = FILL_TBL_HDR; cell.alignment = ALIGN_CENTER; cell.border = BORDER_THIN
        ws.cell(row=7, column=idx).border = BORDER_THIN
        ws.column_dimensions[get_column_letter(idx)].width = w

    # Months and Weekly Headers (Rows 5/6/7)
    # Row 5: Hidden Data row for formula comparison (Serial Dates)
    # Row 6: Month Labels
    # Row 7: Text Labels (W01, W02...)
    month_groups = {}
    for i, d in enumerate(week_start_dates, 13):
        ws.cell(row=5, column=i, value=d).number_format = 'yyyy-mm-dd'
        m_name = d.strftime("%B %Y")
        month_groups.setdefault(m_name, []).append(i)
        ws.cell(row=7, column=i, value=f"W{i-12:02d} ({d.strftime('%m/%d')})").font = Font(size=9, color="FFFFFF", bold=True)
        ws.cell(row=7, column=i).fill = FILL_GANTT_HDR; ws.cell(row=7, column=i).alignment = ALIGN_CENTER; ws.cell(row=7, column=i).border = BORDER_THIN
        ws.column_dimensions[get_column_letter(i)].width = 12

    ws.row_dimensions[5].visible = False # Hide data row

    for m_name, cols in month_groups.items():
        ws.merge_cells(start_row=6, start_column=cols[0], end_row=6, end_column=cols[-1])
        cell = ws.cell(row=6, column=cols[0], value=m_name)
        cell.font = FONT_TBL_HDR; cell.fill = FILL_GANTT_HDR; cell.alignment = ALIGN_CENTER
        for c in range(cols[0], cols[-1] + 1): ws.cell(row=6, column=c).border = BORDER_THIN

    # 3. Populate Tasks
    current_row = 8
    sec_num = 0
    for title, priority, weeks, tasks in sections:
        sec_num += 1
        ws.merge_cells(start_row=current_row, start_column=1, end_row=current_row, end_column=28)
        c_sec = ws.cell(row=current_row, column=1, value=f"PHASE {sec_num}: {title.upper()}")
        c_sec.font = FONT_SEC_HDR; c_sec.fill = FILL_SEC_HDR; c_sec.alignment = Alignment(horizontal='left', indent=1)
        for c in range(1, 29): ws.cell(row=current_row, column=c).border = Border(top=Side(style='medium', color='1F4E78'), bottom=Side(style='medium', color='1F4E78'))
        current_row += 1
        
        t_num = 0
        for t in tasks:
            t_num += 1
            r = current_row
            ws.cell(r, 1, f"{sec_num}.{t_num}").alignment = ALIGN_CENTER
            ws.cell(r, 2, title).alignment = ALIGN_LEFT
            ws.cell(r, 3, t['task']).font = Font(bold=True)
            ws.cell(r, 4, t['scope'])
            ws.cell(r, 5, t['owner'])
            ws.cell(r, 6, t['status']).alignment = ALIGN_CENTER
            ws.cell(r, 7, f'=IF(F{r}="Done", 1, IF(F{r}="In Progress", 0.5, 0))').number_format = '0%'
            ws.cell(r, 8, priority).alignment = ALIGN_CENTER
            
            # Smart auto-dates based on section week ranges
            s_week, e_week = weeks
            st_d = week_start_dates[s_week-1]
            en_d = week_start_dates[e_week-1] + datetime.timedelta(days=5)
            ws.cell(r, 9, st_d).number_format = 'yyyy-mm-dd'
            ws.cell(r, 10, en_d).number_format = 'yyyy-mm-dd'
            ws.cell(r, 11, f'=IF(AND(ISNUMBER(I{r}),ISNUMBER(J{r})), J{r}-I{r}+1, "")').alignment = ALIGN_CENTER
            ws.cell(r, 12, t['notes'])

            for col in range(1, 13):
                ws.cell(r, col).border = BORDER_THIN; ws.cell(r, col).font = Font(name="Calibri", size=10) if col != 3 else Font(name="Calibri", size=10, bold=True)

            # Gantt Formulas using Row 5 (Hidden Serial Dates)
            for g_col in range(13, 29):
                cl = get_column_letter(g_col)
                # Formula: If week start (Row 5) is within task date range
                formula = f'=IF(AND(ISNUMBER($I{r}), ISNUMBER($J{r})), IF(AND({cl}$5 >= $I{r}, {cl}$5 <= $J{r} + 6), IF($F{r}="Done", "✓", IF($F{r}="In Progress", "▶", "■")), ""), "")'
                c_g = ws.cell(r, g_col, formula)
                c_g.alignment = ALIGN_CENTER; c_g.border = BORDER_THIN; c_g.font = Font(bold=True)
            current_row += 1

    # 4. KPI Summary
    ws['B3'] = "TOTAL TASKS"; ws['C3'] = f'=COUNTA(C8:C{current_row})'
    ws['D3'] = "DONE"; ws['E3'] = f'=COUNTIF(F8:F{current_row}, "Done")'
    ws['F3'] = "PENDING"; ws['G3'] = f'=COUNTA(C8:C{current_row})-E3'
    for cell_idx in ['B3', 'D3', 'F3']: ws[cell_idx].font = Font(bold=True, size=10); ws[cell_idx].alignment = ALIGN_CENTER; ws[cell_idx].fill = FILL_SEC_HDR
    for cell_idx in ['C3', 'E3', 'G3']: ws[cell_idx].font = Font(bold=True, size=12); ws[cell_idx].alignment = ALIGN_CENTER

    # 5. Validation & Conditional Formatting
    dv = DataValidation(type="list", formula1='"Done,In Progress,Not Done,Blocked"', allow_blank=True)
    ws.add_data_validation(dv); dv.add(f"F8:F{current_row}")
    
    # Status Colors
    ws.conditional_formatting.add(f"F8:F{current_row}", CellIsRule(operator='equal', formula=['"Done"'], fill=PatternFill(start_color="D4EDDA", end_color="D4EDDA", fill_type="solid")))
    ws.conditional_formatting.add(f"F8:F{current_row}", CellIsRule(operator='equal', formula=['"In Progress"'], fill=PatternFill(start_color="CCE5FF", end_color="CCE5FF", fill_type="solid")))
    ws.conditional_formatting.add(f"F8:F{current_row}", CellIsRule(operator='equal', formula=['"Not Done"'], fill=PatternFill(start_color="F8D7DA", end_color="F8D7DA", fill_type="solid")))
    
    # Gantt Colors
    g_range = f"M8:AB{current_row}"
    ws.conditional_formatting.add(g_range, CellIsRule(operator='equal', formula=['"✓"'], fill=PatternFill(start_color="28A745", end_color="28A745", fill_type="solid"), font=Font(color="FFFFFF")))
    ws.conditional_formatting.add(g_range, CellIsRule(operator='equal', formula=['"▶"'], fill=PatternFill(start_color="007BFF", end_color="007BFF", fill_type="solid"), font=Font(color="FFFFFF")))
    ws.conditional_formatting.add(g_range, CellIsRule(operator='equal', formula=['"■"'], fill=PatternFill(start_color="DC3545", end_color="DC3545", fill_type="solid"), font=Font(color="FFFFFF")))

    ws.freeze_panes = "D8"
    wb.save(file_path)
    print(f"Successfully updated: {file_path}")

process_file('/Users/vinayjagtap/Downloads/WT-plan.xlsx')
process_file('/Users/vinayjagtap/Downloads/WT-plan-v1.xlsx')
