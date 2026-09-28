# Automatic assignments

The extension's **Assignments** tab supports a complete solve cycle and a sequential batch queue. It shares the paced Groq request queue with quizzes. MongoDB is optional.

## Start

From the project root, keep the backend running:

```sh
npm run dev:server
```

Build the extension, then reload it in `chrome://extensions`:

```sh
npm run build:extension
```

Load `extension/dist` if this is the first installation. Configure your Groq key in the existing settings, or use the configured backend key. The server runs at `http://localhost:5001`.

- **One assignment:** open its coding or notebook workspace, then choose **Assignments → Solve this assignment**.
- **Batch:** open the course's **All Assignments** page, then choose **Assignments → Solve unfinished assignments**.

The popup chooses its launch controls from the current page. On the catalog it shows the batch action; single-assignment Solve and Inspect are available in a coding or notebook workspace. A failed catalog scan reports an unconfirmed count rather than claiming there is no unfinished work.

The background worker continues when the popup closes. Keep Chrome, the portal tabs, and the backend running. The queue displays each outcome. **Stop** prevents later actions; an already dispatched run or submission may still finish.

## What the solver does

1. Reads the question, runtime and current source.
2. Selects the verified coding source or editable notebook code cells. Markdown and locked/grader cells remain protected.
3. Generates complete replacements and retains the original sources before editing.
4. Applies native editor changes and verifies the resulting text.
5. Runs the code, or notebook cells in document order, including dependencies and protected tests.
6. Uses fresh execution errors or a rejected submission for up to two repairs.
7. Saves the notebook with an acknowledged save. Coding source is checked in the editor before submission.
8. Clicks the portal's Submit control and reads a fresh result.

**Submitted** means the portal acknowledged receipt and grading may be pending. **Accepted** requires a fresh acceptance result or a completed catalog status. A completed Run alone does not establish acceptance.

## Supported workspaces

| Workspace | Automation |
| --- | --- |
| Newton `/playground/code/<id>` | Native Monaco source editing, Run, bounded repairs, Submit and result tracking |
| Newton `/playground/newton-box/<id>` | Classic Jupyter cell editing, execution, repairs, acknowledged save and outer Submit Solution |
| Simulators and other workspace types | Skipped by the batch when identified |

Coding runtime detection uses explicit portal labels, including Python, MIPS/Mars and Verilog/Icarus. Additional known language families can use an explicit runtime selector. A syntax-highlighting mode alone is insufficient. Source, stdin, testbench and result editors must be distinguishable; ambiguous pages stop with an explanation.

Monaco editing uses its native edit/undo APIs. Jupyter uses its native cell, kernel and save APIs. Visible paste warnings and dialogs are left visible and stop subsequent actions. The extension does not remove monitoring, suppress warnings or simulate human typing.

A notebook cell can run for up to 20 minutes before its outcome is marked unknown; a coding run waits up to two minutes. Empty spacer cells are preserved and not executed. Repairs reuse completed setup cells before the earliest changed cell in the same kernel; changed and downstream cells run again.

## Batch scope

Newton's table layout is read by its column headings, including plain-text question titles. Subject, group title, and release/deadline text distinguish assignments that share a question title. A bookmark or topic column is never used as the assignment title.

The queue reads completion icons, never XP alone. It skips completed cards and processes unfinished supported workspaces sequentially. It expands a unique Load more control up to 20 times per scan and follows a unique enabled Next/Next page control. Each transition must expose a new assignment page within the same course. A batch is bounded to 50 pages and 500 assignments; ambiguous navigation or reaching a bound stops with an explanation.

Only tabs opened and attributed to this batch are eligible for closing. Unrelated tabs are untouched. Known unsupported workspaces are skipped; known exhausted solution failures are recorded. Provider quota/authentication errors and uncertain effects pause the queue. Acknowledged submissions with pending grades are retained and are not automatically submitted again in the same saved batch.

## Recovery and manual controls

**Manual controls** provides Inspect, source selection, Generate, Apply, Run, Save, Restore and recovery tools. After interruption, reconcile the single-assignment job first when required, then use **Reconcile batch**. Recovery checks retained page results and catalog status without repeating submission.

Originals and proposed edits are checkpointed in Chrome local storage before effects. A current assignment checkpoint is retained for 24 hours, capped at 2 MB; batch metadata is capped at 512 KB. Unresolved effects retain their checkpoint beyond expiry until reconciled. Credentials are excluded. Restore only changes source still matching the extension's recorded edits; it does not undo execution, kernel state, files, or portal submissions.

## Free API limits

- One sequential generation stream, sharing provider pacing with quizzes.
- Three logical generations per assignment: initial solution plus two repairs.
- Six actual provider attempts, including rate-limit retries.
- Output caps of 2,048 tokens for coding and 4,096 for notebooks.
- Up to 30 editable targets, with complete bounded context. Oversized tasks stop explicitly.
- Candidate cache: 15 minutes. Backend job/repair ledger: two hours, with count and memory bounds.
- Repeated failed candidates or diagnostics stop further requests.

Usage distinguishes reported tokens from attempts with unknown usage. Local estimates do not establish the account's remaining provider quota.

## Validation

```sh
npm test --prefix backend
npm test --prefix extension
npm run build:extension
```

Automated checks use provider mocks and editor/notebook/portal fixtures; they do not spend Groq quota. Live inspection established the Newton workspace layouts and main controls. The complete new edit/run/submit cycle has not yet been verified against a live graded assignment. Unexpected page layouts or unrecognized result text stop with an explicit unresolved state rather than reporting acceptance.
