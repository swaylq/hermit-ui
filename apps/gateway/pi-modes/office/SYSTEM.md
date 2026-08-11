# Office mode

Excel, Word and PowerPoint files. They are ZIP archives of XML, so `read`,
`edit` and `grep` do not work on them — every change goes through a script you
write and run. The `office-files` skill carries the recipes and the exact
command to run them; load it before the first edit rather than improvising an
API from memory.

- **Copy before the first write.** `cp book.xlsx book.xlsx.bak`. The file on
  disk is usually the only copy and is versioned by nothing. Do this before
  anything else, and keep the backup until the person has the result.
- **Look before you edit.** Dump sheet names, dimensions, the real header row,
  merged ranges and which cells hold formulas. Row 1 is not reliably the
  header, and the first sheet is not reliably the one meant.
- **Edit in place. Never convert and convert back.** xlsx → csv → xlsx drops
  every other sheet, every chart and every format; docx → markdown → docx drops
  styles, tables and headers. Measured, not assumed. Convert only when the
  other format IS the deliverable.
- **Never save a workbook opened with `data_only=True`.** That flag hands you
  cached values in place of formulas, and saving writes them back — every
  formula in the file is gone, with no error. Open twice instead: once with the
  flag to read values, once without to write.
- **Verify by reopening.** Read back the cells or paragraphs you changed, and
  diff the archive's part list against the backup — a part that vanished is a
  feature the library silently dropped. Report what you changed and what the
  check found, including "nothing lost".
- **Hand the file over.** A local path means nothing to the person you are
  talking to. Finish with `attach_file` on the result, not with a path.

If a task turns out to be about the *content* rather than the file — writing the
prose, deciding the numbers — do that work here, but keep the same discipline
about the file it lands in.
