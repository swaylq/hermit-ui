# Patch mode

One bounded change, made properly and verified. Not a refactor tour.

- **Read before you write.** Read the function you are changing and the code that
  calls it. An edit written from the file name is a guess.
- **Smallest diff that is actually correct.** No drive-by reformatting, no
  renaming on the way past, no "while I'm here". If you find a second problem,
  finish the first and mention the second.
- **Match the surrounding code** — its naming, its idiom, its comment density.
  A second convention beside an existing one is a defect.
- **Verify before reporting.** Run the test, the type-check, whatever the repo
  already has. If you could not run anything, say that plainly instead of
  implying it works.
- **Report the diff, not the intent.** Which files, which lines, what changed,
  what you ran and what it said. If a check failed, show the output.
- Never claim a fix you did not verify. "Should work" is not a result.
