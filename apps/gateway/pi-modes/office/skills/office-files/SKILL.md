---
name: office-files
description: Read and edit .xlsx/.xlsm, .docx and .pptx files in place with openpyxl / python-docx / python-pptx, run through `uv` so nothing has to be installed. Covers the inventory-before-edit script, the data_only formula-destroying trap, docx run splitting, legacy .xls/.doc conversion via LibreOffice, and the reopen + part-diff verification. Use whenever a task touches an Excel workbook, a Word document or a PowerPoint deck.
---

# office-files — editing Office documents without wrecking them

An `.xlsx` / `.docx` / `.pptx` is a ZIP of XML. Nothing text-based reaches
inside it: `read` returns mojibake, `edit` corrupts it, `grep` finds nothing.
Every change is a small Python script that you write to a file and run.

## Running Python here

Nothing is installed and nothing needs to be. `uv` fetches into a cached
throwaway environment:

```bash
uv run --with openpyxl --with python-docx --with python-pptx python fix.py
```

Verified on this machine: openpyxl 3.1.5, python-docx, python-pptx, under
Python 3.14. Import names differ from package names — `python-docx` imports as
`docx`, `python-pptx` as `pptx`.

Write the script to a real file (`write` tool) and run it. Do not pipe a
heredoc through bash: quoting eats backslashes and CJK, and you cannot iterate
on what you cannot re-read.

**LibreOffice** (`soffice`) and **pandoc** are also on this machine. They are
for *conversion*, never for editing round-trips — see the last section.

## Step 1 — back up, then take inventory

Always both, always before the first write.

```python
import shutil, zipfile
from pathlib import Path
import openpyxl

src = Path("book.xlsx")
shutil.copy2(src, src.with_suffix(src.suffix + ".bak"))

wb = openpyxl.load_workbook(src)                 # formulas as written
vals = openpyxl.load_workbook(src, data_only=True)  # last-calculated values
for ws in wb.worksheets:
    print(f"[{ws.title}] dims={ws.dimensions} max_row={ws.max_row} max_col={ws.max_column}")
    print("  merged:", [str(r) for r in ws.merged_cells.ranges][:10])
    for row in ws.iter_rows(min_row=1, max_row=min(5, ws.max_row), values_only=True):
        print("  ", row)
    formulas = [c.coordinate for r in ws.iter_rows() for c in r
                if isinstance(c.value, str) and c.value.startswith("=")]
    print(f"  formulas: {len(formulas)} {formulas[:8]}")
```

Read the output before deciding anything. The header is often on row 2 or 3
under a merged title, and the sheet you want is often not the first.

## Step 2 — Excel (openpyxl)

**The trap that destroys work.** `data_only=True` returns the values Excel last
cached and *forgets the formulas exist*. Saving that workbook writes the
forgetting back to disk:

```python
wb = openpyxl.load_workbook("book.xlsx", data_only=True)
wb.save("book.xlsx")      # every formula in the file is now gone. No error.
```

Measured: `=SUM(B2:B4)` becomes `None` after exactly this. So: **load twice**
— `data_only=True` only for the workbook you read from and never save, plain
`load_workbook` for the one you edit and save.

Other flags that matter:

```python
openpyxl.load_workbook(p, keep_vba=True)    # .xlsm — omitting this drops the macros
openpyxl.load_workbook(p, rich_text=True)   # keep in-cell rich text runs
```

Editing:

```python
ws = wb["Data"]                     # by name; wb.active is a guess
ws["B5"] = 42
ws.cell(row=5, column=2, value=42)
ws.insert_rows(3); ws.delete_rows(7)
ws.append(["new", 1, "=B2*2"])      # a string starting with = IS a formula
ws["C2"].number_format = "#,##0.00" # writing a value does not carry format
wb.save("book.xlsx")
```

Formatting is per cell and is not inherited by cells you create — copy
`number_format`, `font`, `alignment`, `border` and `fill` from a neighbour in
the same column when you add rows. `ws.column_dimensions['C'].width` and
`ws.freeze_panes` are sheet-level and survive on their own.

openpyxl does not recalculate. A formula you write has no cached value until
Excel or LibreOffice opens the file, so anything reading it with
`data_only=True` sees `None` — expected, not a bug. If the person needs the
computed number in the file, recalculate with LibreOffice:

```bash
soffice --headless --convert-to xlsx --outdir out/ book.xlsx
```

## Step 3 — Word (python-docx)

**Runs split text.** Word stores a paragraph as runs, and it breaks them
wherever formatting, spell-check or an earlier edit did. Measured: the
paragraph `项目预算为 1,200 万元` came back as three runs — `'项目预算为 '`,
`'1,200'`, `' 万元'`. A per-run `if old in run.text` finds nothing and reports
"not found" on text that is plainly there.

Search on `paragraph.text` (the joined string), then write back across the
span:

```python
def replace_in_paragraph(p, old, new):
    """Replace within one paragraph, keeping the first touched run's formatting."""
    if old not in p.text:
        return False
    runs, pos, hits = p.runs, 0, []
    for i, r in enumerate(runs):           # map each run to its slice of p.text
        hits.append((i, pos, pos + len(r.text)))
        pos += len(r.text)
    start = p.text.index(old)
    end = start + len(old)
    touched = [i for i, a, b in hits if a < end and b > start]
    if not touched:
        return False
    first, last = touched[0], touched[-1]
    head = runs[first].text[: start - hits[first][1]]
    tail = runs[last].text[end - hits[last][1] :]
    runs[first].text = head + new + tail
    for i in touched[1:]:
        runs[i].text = ""
    return True
```

The replacement takes the formatting of the first run it touched — if the span
was bold in the middle and plain at the edges, that distinction is gone. Say so
when it matters.

Everything else:

```python
import docx
d = docx.Document("report.docx")
for p in d.paragraphs:
    print(repr(p.style.name), repr(p.text))
for t in d.tables:                      # tables are NOT in d.paragraphs
    for row in t.rows:
        print([c.text for c in row.cells])
        for c in row.cells:
            for p in c.paragraphs:      # cell text is paragraphs too
                replace_in_paragraph(p, "旧", "新")
for s in d.sections:                    # headers/footers are per section
    for p in s.header.paragraphs + s.footer.paragraphs:
        ...
d.add_paragraph("正文", style="Normal")
d.add_heading("标题", level=2)
d.save("report.docx")
```

Use a `style=` that already exists in the document — inventing a style name
raises `KeyError`, and a directly-formatted run will not match the rest of the
document. `d.styles` lists what is available.

## Step 4 — PowerPoint (python-pptx)

```python
from pptx import Presentation
prs = Presentation("deck.pptx")
for i, slide in enumerate(prs.slides):
    for shape in slide.shapes:
        if shape.has_text_frame:
            for p in shape.text_frame.paragraphs:
                print(i, [r.text for r in p.runs])   # runs split here too
prs.save("deck.pptx")
```

Same run-splitting rule as Word. Shape positions are EMU
(`from pptx.util import Inches, Pt`).

## Step 5 — legacy and other formats

openpyxl and python-docx read the modern XML formats **only**. A `.xls`,
`.doc`, `.ppt` or `.wps` must be converted first:

```bash
soffice --headless --convert-to xlsx --outdir /tmp/conv old.xls
soffice --headless --convert-to docx --outdir /tmp/conv old.doc
```

Verified working here (LibreOffice 26.2). It is slow on first run and writes to
`--outdir`, never in place. Tell the person the deliverable changed format, or
convert back at the end.

For a PDF the person can look at:

```bash
soffice --headless --convert-to pdf --outdir . report.docx
```

`pandoc` is fine for docx → markdown when *reading* prose is the goal. It is
not a round-trip: everything it cannot express in markdown is dropped.

## Step 6 — verify, then hand over

Two checks. Reopening catches wrong edits; the part diff catches silent feature
loss, and neither catches the other.

```python
import zipfile, openpyxl
orig, new = "book.xlsx.bak", "book.xlsx"

before = set(zipfile.ZipFile(orig).namelist())
after = set(zipfile.ZipFile(new).namelist())
lost = sorted(before - after)
print("lost parts:", lost or "none")     # charts/, drawings/, pivot*, vbaProject.bin

def formula_count(p):
    wb = openpyxl.load_workbook(p)
    return sum(isinstance(c.value, str) and c.value.startswith("=")
               for ws in wb.worksheets for r in ws.iter_rows() for c in r)
print("formulas:", formula_count(orig), "->", formula_count(new))

wb = openpyxl.load_workbook(new)
print("check B5 =", wb["Data"]["B5"].value)   # the cells you actually changed
```

Measured on a csv-style round-trip: 5 parts lost (`xl/charts/chart1.xml`,
`xl/drawings/*`, the sheet rels) — exactly the loss the part diff exists to
catch. A `data_only` save loses 0 parts, which is why the formula count is a
separate check.

Then deliver it: `attach_file` with the path and a one-line caption saying what
changed. The person is on the web and cannot see this machine's disk. Keep the
`.bak` until they confirm.
