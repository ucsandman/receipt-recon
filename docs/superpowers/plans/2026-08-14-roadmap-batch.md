# Roadmap Batch (7 features) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the seven features Wes picked from the 2026-08-12 roadmap: policy save/load (#14), manual FX view (#27, redefined), receipt photos (#15), deterministic header binding (#10, prereq), column-mapping UI (#11), per-employee breakdown (#17), reviewer decisions (#20), and card-statement reconciliation (#19).

**Architecture:** Receipt Recon is a no-build static page (index.html + ES modules in app/), pure logic in node-testable modules (sheet.js, rules.js, budget.js, extract.js parsers, report.js), UI wiring in main.js. Every feature follows that split: pure logic in a testable module with unit tests, UI wiring in main.js/index.html, browser+a11y assertions in tools/. One new module: app/statement.js.

**Tech Stack:** Vanilla JS ES modules, SheetJS (vendored), pdf.js (vendored), tesseract.js (vendored), node:test, Playwright for browser checks. No new dependencies. No network calls, ever.

**Spec:** docs/ROADMAP.md items 10, 11, 14, 15, 17, 19, 20, 27 + the brainstorm redefinitions recorded in the ASSUMPTIONS block of the session (FX = disclosed view only; reviewer persistence = session file; statement severities HARD/SOFT as chosen).

## Global Constraints

- Nothing leaves the machine. No fetch to any non-self origin. CSP stays as is.
- Determinism: same inputs + same policy = same runHash. Reviewer decisions stay OUT of runHash material. Policy shape changes → RULESET_VERSION becomes '1.1.0' (once, in Task 2).
- No currency is ever converted inside a finding or a comparison. Conversion appears only in the clearly labelled "at your stated rates" view.
- Every new interactive control: keyboard reachable, accessible name, works in both themes.
- Zero behaviour change for a user who touches none of the new controls (except: image files now load instead of being silently skipped).
- Branch `roadmap-batch`; commit per task; push the branch; do NOT merge to main (deploys the live site — confirm-first).
- Verify per task: `npm test`. Full pass at the end: `npm test`, then `npm run serve` + `node tools/browser-check.mjs` + `node tools/a11y-check.mjs` (browser/a11y assertions for new UI are added in Task 9 — deviation from per-task TDD for the browser layer only, because those suites need the whole UI and a running server).

---

### Task 1: Policy packs — save/load policy as a file (roadmap #14)

**Files:**
- Modify: `app/rules.js` (add `sanitizePolicy`)
- Modify: `app/main.js` (save/load handlers)
- Modify: `index.html` (two buttons + hidden file input in #step-policy actions)
- Test: `tests/rules.test.mjs`

**Interfaces:**
- Produces: `export function sanitizePolicy(raw)` in rules.js → `{ policy, errors }`. `policy` = DEFAULT_POLICY clone with valid keys from `raw` applied; `errors` = array of strings naming each rejected key ("receiptRequiredAtOrAbove must be a number, got string"). Unknown keys are ignored silently. Type rules derive from DEFAULT_POLICY value types: number → Number.isFinite required; array → must be array, items coerced String(x).trim(), empties dropped; plain object (categoryLimits, later fxRates) → must be object, each value a finite number, each key a non-empty string; string (later fxBase) → must be string.

- [ ] **Step 1: Failing tests** in tests/rules.test.mjs: (a) roundtrip: `sanitizePolicy(JSON.parse(JSON.stringify(DEFAULT_POLICY)))` → errors [] and deep-equal policy; (b) `sanitizePolicy({receiptRequiredAtOrAbove: 'high'})` → one error naming that key, policy keeps 75; (c) `sanitizePolicy({alcoholKeywords: 'wine'})` → error, default list kept; (d) `sanitizePolicy({categoryLimits: {Meals: 'lots'}})` → error; (e) unknown key `{bogus: 1}` → no error, key absent.
- [ ] **Step 2:** Run `npm test` → new cases FAIL (sanitizePolicy not exported).
- [ ] **Step 3:** Implement sanitizePolicy in rules.js after DEFAULT_POLICY.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** UI: in index.html #step-policy actions row add `<button class="btn quiet" id="btnPolicySave">Save policy file</button> <button class="btn quiet" id="btnPolicyLoad">Load policy file</button> <input type="file" id="filePolicy" accept=".json,application/json" class="sr-only">`. In main.js init(): save → Blob download `receipt-recon-policy.json` of `JSON.stringify(state.policy, null, 2)` via temporary `<a download>`; load → filePolicy.click(); on change read text, `JSON.parse` in try/catch (parse error → showBanner), then sanitizePolicy: if errors.length → showBanner(first error + ' — policy not loaded.') and leave state.policy untouched; else assign, savePolicy(), renderPolicy(), announce('Policy loaded from file.'), clearBanner().
- [ ] **Step 6: Commit** `feat: save and load the policy as a file (#14)`

### Task 2: Manual FX table — disclosed converted view (roadmap #27, redefined)

**Files:**
- Modify: `app/rules.js` (DEFAULT_POLICY += `fxBase: 'USD'`, `fxRates: {}`; RULESET_VERSION → '1.1.0')
- Modify: `app/budget.js` (add `fxView`)
- Modify: `app/main.js` (policy panel editor for rates; budget card section; pass fx into workbook meta)
- Modify: `app/report.js` (Budget Recon tab: converted section)
- Modify: `index.html` (container `<div id="budgetFx"></div>` inside #budgetCard after #budgetFindings)
- Modify: `app/style.css` (small styles for the fx block)
- Test: `tests/budget.test.mjs`

**Interfaces:**
- Produces: `export function fxView(lines, policy)` in budget.js. Input: `reconcileBudget().lines`, policy with `fxBase` (code string) and `fxRates` (map code → units of fxBase per 1 unit of code; fxBase itself always rate 1). Returns `null` when `fxRates` has no entries OR no line has a currency. Otherwise returns `{ base, rates: [[code, rate]...] (only codes actually used), rows: [{label, currency, budgetBase, actualBase, deltaBase}], totals: {budget, actual, delta}, missingRates: [codes seen but unrated], excluded: [labels with null currency] }`. Lines whose currency has no rate go to missingRates and are left out of totals. All figures round2. Semantics: `x CODE * rate = y BASE`.
- fxRates/fxBase ride into runHash automatically (policy is hash material) — that is why RULESET_VERSION bumps here.

- [ ] **Step 1: Failing tests** in tests/budget.test.mjs: (a) lines `[{label:'Travel',currency:'EUR',budget:1000,actual:1080,delta:80,status:'over'}]` with `{fxBase:'USD', fxRates:{EUR:1.08}}` → rows[0].budgetBase 1080, actualBase 1166.40, totals.actual 1166.40; (b) fxRates {} → null; (c) currency 'GBP' with only EUR rated → missingRates ['GBP'], totals exclude it; (d) line currency null → excluded contains its label; (e) fxBase line (USD) converts at rate 1 without an entry.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** Implement fxView; bump RULESET_VERSION with a comment ("1.1.0: policy gained fxBase/fxRates + statementDateToleranceDays; hash material changed"); add the two DEFAULT_POLICY keys.
- [ ] **Step 4:** `npm test` → PASS (existing budget/rules tests must also pass; any test pinning RULESET_VERSION gets updated deliberately).
- [ ] **Step 5:** Policy panel (main.js renderPolicy): new section mirroring the categoryLimits pattern — one row per fxRates entry (`label "1 EUR in USD"`, number input, change handler writes state.policy.fxRates[code], savePolicy()), plus add-row (3-letter code text input + rate number input + Add button `fx_newAdd`), plus fxBase text input (uppercased, 3 letters). Hint text: "Month-end rates you choose. Used ONLY for the clearly labelled converted view; no finding ever converts a currency."
- [ ] **Step 6:** Budget card (main.js renderBudget): after findings, if `fxView(lines, state.policy)` non-null, fill #budgetFx: heading "At your stated rates", rate list ("1 EUR = 1.08 USD"), totals line ("Budget ≈ X USD · Spent ≈ Y USD · difference Z"), missingRates/excluded notes, caveat sentence: "Estimate only, at rates you entered by hand. Every finding above compares within one currency; nothing was converted there." Workbook (report.js Budget Recon tab): same block appended when `meta.budget.fx` present (main.js download handler adds `fx: fxView(state.budgetRecon.lines, state.policy)` into the budget meta object).
- [ ] **Step 7:** `npm test`; commit `feat: manual FX table with a disclosed converted budget view (#27)`

### Task 3: Deterministic header binding (roadmap #10 remainder)

**Files:**
- Modify: `app/sheet.js` (mapHeaders: claim tracking + exact-pass-first-for-all-fields)
- Test: `tests/sheet.test.mjs`

**Interfaces:**
- `mapHeaders(header)` keeps its signature. New behaviour: pass 1 binds exact alias matches for ALL fields (claiming column indices); pass 2 binds remaining fields by substring, skipping claimed columns. Field order in COLUMN_ALIASES decides contested exact ties (deterministic).

- [ ] **Step 1: Failing tests** in tests/sheet.test.mjs: (a) `['Txn','Receipt Amount','Receipt File']` → amount:1, receiptFile:2 (today receiptFile grabs 1 by substring); (b) regression: the sample workbook's real header row (read the literal row from tools/make_sample_data.py during implementation) maps identically before/after — pin the full expected map object.
- [ ] **Step 2:** `npm test` → (a) FAILS.
- [ ] **Step 3:** Rewrite mapHeaders with a `claimed` Set and two passes.
- [ ] **Step 4:** `npm test` → PASS, including all pre-existing sheet tests.
- [ ] **Step 5:** Commit `fix: exact header aliases outrank substring fallbacks, one column binds one field (#10)`

### Task 4: Column-mapping review UI (roadmap #11)

**Files:**
- Modify: `index.html` (disclosure after #sheetChoice)
- Modify: `app/main.js` (state.columnMap, mapping UI render, rowsFromSheet takes a map, localStorage memory per header signature)
- Modify: `app/style.css` (.colmap grid)

**Interfaces:**
- `rowsFromSheet(aoa, map)` — map is `{field: index}`; amount required else throw (existing message).
- `state.columnMap` = active mapping. Derived in applySheetSelection as: `mapHeaders(header)` overlaid by any remembered mapping for this header signature. Signature = JSON.stringify of the normalized (trim/lowercase) header row. Storage key `receipt-recon-colmap`, value = array of `[signature, map]`, most recent first, capped at 20.
- Consumes: Task 3's deterministic mapHeaders.

- [ ] **Step 1:** index.html after #sheetChoice:
```html
<details class="colmap" id="colMap" hidden>
  <summary>Columns we found — check the guesses</summary>
  <p class="microcopy">Each field below shows which spreadsheet column feeds it. Fix any wrong guess; the fix is remembered for files with this exact header row.</p>
  <div class="colmap-grid" id="colMapGrid"></div>
</details>
```
- [ ] **Step 2:** main.js: `const MAP_FIELDS = [['txnId','Transaction id'],['employee','Employee'],['date','Date'],['vendor','Vendor'],['category','Category'],['amount','Amount'],['currency','Currency'],['receiptFile','Receipt file'],['purpose','Business purpose'],['approver','Approver']]`. renderColumnMap(): one labelled `<select id="cm_<field>">` per field; options: `<option value="-1">Not in this sheet</option>` + one per header cell (`B — Amount` style, esc()'d). Change handler: update state.columnMap (delete on -1), if amount missing → showBanner + disable Run; else re-derive `state.rows = rowsFromSheet(aoa, state.columnMap)`, remember signature→map, update status text, updateRunButton(). Show #colMap whenever a sheet is loaded; unhide.
- [ ] **Step 3:** applySheetSelection uses `state.columnMap = remembered(signature) ?? mapHeaders(header)` and passes it to rowsFromSheet. Re-picking a different transaction sheet recomputes the map for that sheet's header.
- [ ] **Step 4:** Manual smoke via sample data (`npm run serve`, load page, verify disclosure renders and Vendor re-select changes the table). Browser assertions land in Task 9.
- [ ] **Step 5:** `npm test`; commit `feat: column mapping is visible and correctable, remembered per header signature (#11)`

### Task 5: Receipt photos — JPG/PNG/WEBP (roadmap #15)

**Files:**
- Modify: `app/extract.js` (IMAGE_EXTENSIONS, extractReceiptImage)
- Modify: `app/main.js` (acceptReceipts widens, resolveReceipt generalizes, runAudit branches, openPanel renders images, status text reports skipped names)
- Modify: `index.html` (#fileReceipts accept attr, drop copy)
- Test: `tests/extract.test.mjs` (pure parts only; OCR path is browser-tested in Task 9)

**Interfaces:**
- Produces: `export const IMAGE_EXTENSIONS = ['.jpg','.jpeg','.png','.webp']` and `export async function extractReceiptImage(file, { getOcrWorker })` in extract.js → same result shape as extractReceipt, tier 'ocr' (or 'failed'), plus `isImage: true`. Uses createImageBitmap → canvas (clampScale with desired 1 — photos are already raster; only pathological sizes shrink, and a shrink pushes the same downscale warning) → worker.recognize(canvas) → parseFields. numPages 1.
- resolveReceipt tries, in order: exact basename; basename with each known extension appended when it has none; `txnId + ext` for each of ['.pdf', ...IMAGE_EXTENSIONS]. Existing pdf tries preserved.
- acceptReceipts admits `.pdf` + IMAGE_EXTENSIONS (by name or MIME image/jpeg|png|webp); collects `skippedNames`; paintReceiptStatus prints "N receipts loaded · ignored: a.docx, b.txt" (first 3 names + "and K more"); count wording changes from "PDFs" to "receipts".

- [ ] **Step 1: Failing test** in tests/extract.test.mjs: IMAGE_EXTENSIONS exported and contains the four; extractReceiptImage with `getOcrWorker: null` resolves tier 'failed' with error mentioning OCR — this case must not touch createImageBitmap so it runs in node.
- [ ] **Step 2:** `npm test` → FAIL. Implement. `npm test` → PASS.
- [ ] **Step 3:** main.js: runAudit picks extractor by extension (`isImageFile(name)` helper). openPanel: image file → `<img>` with `URL.createObjectURL(file)`, alt "Receipt photo for <txnId>", tracked in `state.panelImgUrl` and revoked in releasePanelPdf()/closePanel path; no page nav. index.html accept attr: `application/pdf,image/jpeg,image/png,image/webp,.pdf,.jpg,.jpeg,.png,.webp`; drop-title "Receipts (PDF or photo)"; hint mentions photos.
- [ ] **Step 4:** `npm test`; commit `feat: accept JPG/PNG/WEBP receipt photos through the OCR tier (#15)`

### Task 6: Per-employee breakdown in Summary (roadmap #17)

**Files:**
- Modify: `app/report.js` (`employeeBreakdown` + Summary block)
- Test: `tests/report.test.mjs`

**Interfaces:**
- Produces: `export function employeeBreakdown(results)` → array of `{ employee, exceptions, review, flagged }` where flagged = sumsByCurrency of that employee's non-clean rows; sorted by |flagged[0][1]| descending (each employee's largest single-currency flagged value), ties by employee name. Empty employee → '(no employee)'.
- Summary tab, after Findings by rule: header row `['By employee','Exceptions','Needs review','Value on flagged rows']`, then one row per employee, flagged cell rendered `"120.00 USD + 80.00 EUR"` — per-currency strings, never summed across currencies. wsSummary !cols → 4 columns.

- [ ] **Step 1: Failing tests** in tests/report.test.mjs: three fake results (emp A: 1 exception 100 USD; emp B: 1 review 80 EUR + 1 exception 200 USD; emp C: clean) → order [B, A, C? — C has zero flagged, include with zeros], B.flagged deep-equals [['USD',200],['EUR',80]], counts right.
- [ ] **Step 2:** FAIL → implement → PASS.
- [ ] **Step 3:** Wire into buildWorkbook Summary; commit `feat: per-employee breakdown on the Summary tab (#17)`

### Task 7: Reviewer decisions in the drawer (roadmap #20)

**Files:**
- Modify: `app/main.js` (state.reviews, decision controls in panel, session save/load, review progress counter)
- Modify: `app/report.js` (buildWorkbook meta.reviews fills the four Exceptions columns)
- Modify: `index.html` (results-bar: reviewer name input, Save/Load review session buttons + hidden file input, progress span)
- Modify: `app/style.css` (.decide controls)
- Test: `tests/report.test.mjs` (exceptions rows carry decisions; runHash ignores them)

**Interfaces:**
- `state.reviews = new Map()` keyed `` `${txnId}::${code}` `` → `{ decision: 'approved'|'rejected'|'follow-up', note: string, reviewer: string, date: 'YYYY-MM-DD' }`. NEVER hash material (runHash signature untouched by this task).
- buildWorkbook gains `meta.reviews` (the Map or null). Exceptions rows fill: decision label ('Approved'/'Rejected'/'Needs follow-up'), reviewer, date, note; blanks when undecided.
- Session file shape: `{ app:'receipt-recon-review', version:1, reportName, runHash, reviewer, decisions:[{txnId, code, decision, note, date}] }`. Load: validate shape; hash mismatch → warning banner but matching keys still apply; report "applied N of M decisions" via announce + banner when any skipped.
- Panel: under each rendered finding, a `.decide` group: three toggle buttons (aria-pressed, clicking the active one clears the decision) + note text input (aria-label "Note for CODE on TXNID") + the stamp uses the reviewer name input's value.
- Results table: decided findings get ' ✓' after the code with `<span class="sr-only">decided</span>`; results-bar span `#reviewProgress` shows "K of M findings decided" (M = non-info findings across results).

- [ ] **Step 1: Failing tests** (report.test.mjs): buildWorkbook with a reviews Map containing one decision → Exceptions sheet row for that txn/code carries ['Approved', 'Wes', date, 'ok']; a result set hashed with runHash before and after adding meta.reviews is byte-identical (runHash never sees reviews — assert by calling runHash twice on same inputs while reviews exist elsewhere; the honest assertion: runHash's material function does not reference reviews — test hash equality with and without decisions applied to the same results object).
- [ ] **Step 2:** FAIL → implement report.js side → PASS.
- [ ] **Step 3:** main.js: render `.decide` groups in openPanel (findings loop); delegated change/click handlers update state.reviews, re-render the findings list cell of that row + progress counter (cheap: renderRows()). Wire session save (compute runHash at save via existing runHash import), load with validation.
- [ ] **Step 4:** index.html results-bar additions; style.css.
- [ ] **Step 5:** `npm test`; commit `feat: reviewer decisions in the evidence drawer, exported to the workbook, saved as a session file (#20)`

### Task 8: Card-statement reconciliation (roadmap #19)

**Files:**
- Create: `app/statement.js`
- Modify: `app/rules.js` (DEFAULT_POLICY += `statementDateToleranceDays: 5`; auditAll gains optional `extra` findings map)
- Modify: `app/main.js` (third drop zone wiring, state.stmtRows/stmtRecon, runAudit order, statement card render)
- Modify: `index.html` (third drop + clear button + statement card section)
- Modify: `app/report.js` (Statement Recon tab, Summary lines, Methodology line becomes conditional, runHash gains optional statement material)
- Modify: `app/style.css`
- Test: `tests/statement.test.mjs` (new), `tests/report.test.mjs` (hash)

**Interfaces (the design spec roadmap #19 demanded):**
- `app/statement.js` exports:
  - `STATEMENT_ALIASES` = `{ date: ['date','transaction date','trans date','posting date','post date','posted'], description: ['description','merchant','details','payee','narrative','memo','transaction description'], amount: ['amount','debit','charge','transaction amount','billing amount'], currency: ['currency','ccy','cur','billing currency'] }`
  - `parseStatement(aoa)` → `{ rows: [{line, date, description, amount, currency}], headerRow } | null`. Header searched in the first 12 rows (needs date+amount). Values: normalizeDate/toNumber from sheet.js. Amounts: `Math.abs()` (issuer sign conventions differ); rows whose description matches `/\b(payment|autopay|thank you|credit adjustment)\b/i` OR whose raw amount is a credit that reverses (kept simple: the regex) are skipped and counted in `skipped`.
  - `pickStatementSheet(sheets)` → index of best-qualifying sheet (mirrors pickTransactionSheet: date+amount mapped; most mapped fields wins; -1 when none).
  - `reconcileStatement(rows, stmtRows, policy)` → `{ matchedCount, unclaimed: [stmtRow...], notOnStatement: [txnId...], rowFindings: Map(txnId -> [finding]), findings: [report-level finding...] }`.
- Matching rule (named tolerances, per the spec demand): candidate = same currency when both sides state one (a statement without a currency column matches any); `|abs(stmt.amount) - row.amount| <= policy.amountToleranceAbs`; `|daysBetween(stmt.date, row.date)| <= policy.statementDateToleranceDays` (default 5, editable in the policy panel — add to POLICY_FIELDS). One-to-one greedy: expense rows in sheet order; best candidate by smallest date gap, tie by highest vendorSimilarity(description, row.vendor) (import from rules.js).
- Severities (owner decision, disclosed): statement line unmatched → **UNCLAIMED_CHARGE, HARD, report-level** (`findings`); expense row unmatched → **CLAIMED_NOT_ON_STATEMENT, SOFT, row-level** (`rowFindings`), message names the amount, date, tolerance and the innocent explanations (cash, personal card).
- `auditAll(rows, extractions, policy, extra = null)` — extra is a Map txnId→findings merged exactly like batch findings, so SOFT statement findings drive row status. Default null keeps today's behaviour byte-identical.
- `runHash(results, policy, budget = null, statement = null)` — when statement present, material gains `{ statementLines: rows.map(r => [r.line, r.date, r.description, r.amount, r.currency]) }`. Callers updated (main.js download + save-session).
- UI: third drop in .dropgrid "Card statement (optional)" accepting .xlsx/.xls/.csv, its own status line + Clear button; results gain a `#stmtCard` (pattern-copied from #budgetCard): matched count line, unclaimed-charges table (line, date, description, amount + HARD pill), note listing how many rows were flagged CLAIMED_NOT_ON_STATEMENT. Workbook: "Statement Recon" tab (rule disclosure incl. tolerances and the abs()/payment-skip rules, matched count, unclaimed table, not-on-statement txn list); Summary gains the two counts; Methodology's "No bank or card statement was compared" line becomes conditional on whether one was.

- [ ] **Step 1: Failing tests** tests/statement.test.mjs: (a) parseStatement finds an offset header (2 junk rows first); (b) amounts: a -42.50 debit matches a 42.50 claim; (c) a "PAYMENT THANK YOU" line is skipped, not UNCLAIMED; (d) boundary: gap exactly = statementDateToleranceDays matches (no UNCLAIMED_CHARGE), gap = tolerance+1 → UNCLAIMED_CHARGE with `severity === 'hard'` asserted literally; (e) expense row with no candidate → rowFindings has CLAIMED_NOT_ON_STATEMENT `severity === 'soft'`; (f) one-to-one: two identical rows, one statement line → matchedCount 1 and one SOFT finding; (g) auditAll with extra map → row status becomes 'needs-review'.
- [ ] **Step 2:** FAIL → implement statement.js + auditAll extra param → PASS.
- [ ] **Step 3:** report.js: tab + summary + conditional methodology + runHash statement material (report.test.mjs: hash differs with/without statement material, identical across two calls with it).
- [ ] **Step 4:** main.js + index.html + style.css wiring; manual smoke with a hand-made statement CSV against the sample sheet.
- [ ] **Step 5:** `npm test`; commit `feat: local card-statement reconciliation — UNCLAIMED_CHARGE and CLAIMED_NOT_ON_STATEMENT (#19)`

### Task 9: Browser/a11y assertions, docs, full verification

**Files:**
- Modify: `tools/browser-check.mjs`, `tools/a11y-check.mjs`
- Modify: `README.md`, `PRODUCT.md` (feature list), `docs/ROADMAP.md` (status note), `docs/DECISIONS.md` (severity + persistence + FX-view decisions)

- [ ] **Step 1: browser-check additions:** (a) policy: set receiptRequiredAtOrAbove to 25, save file (download captured), reset, load file, input reads 25; reject a `{"receiptRequiredAtOrAbove":"x"}` file → banner shown, value unchanged; (b) column mapping: re-select Vendor to a different column → first row's vendor cell shows that column's value; (c) image receipt: generate a PNG receipt fixture (canvas → dataURL → temp file) with a known total, add to the receipts pick → row resolves, Read by shows OCR, total matches; a .docx-named dummy is reported ignored by name; (d) reviewer: set a decision + note on one finding → downloaded workbook Exceptions row carries both, and runHash printed in Summary is identical to the pre-decision workbook's; (e) statement: load a fixture statement CSV with one extra charge and one missing → stmtCard shows 1 unclaimed; workbook has the Statement Recon tab.
- [ ] **Step 2: a11y-check additions:** new buttons/selects/inputs (policy save/load, colmap selects with bound labels, decision buttons aria-pressed + keyboard, statement drop + clear) reachable and named; decision buttons operable by keyboard.
- [ ] **Step 3:** Full run: `npm test`; `npm run serve` + `node tools/browser-check.mjs` + `node tools/a11y-check.mjs`. READ the output.
- [ ] **Step 4:** Docs: README sections for each feature (run steps unchanged); Methodology text verified; DECISIONS.md entries; ROADMAP.md status header updated ("items 10, 11, 14, 15, 17, 19, 20, 27 landed 2026-08-14").
- [ ] **Step 5:** Commit `docs+test: browser/a11y coverage and docs for the roadmap batch`; push branch `roadmap-batch`; report to Wes; merge to main only on his confirm.

## Self-Review Notes

- Spec coverage: #14→T1, #27→T2, #10→T3, #11→T4, #15→T5, #17→T6, #20→T7, #19→T8, checks/docs→T9. Gaps: none known.
- Type consistency: sanitizePolicy `{policy, errors}` used in T1 UI; fxView return shape used in T2 UI+workbook; auditAll extra param defined in T8 and consumed only there; runHash 4-arg form updated at all call sites in T8.
- Deviation recorded: browser/a11y TDD is batched into T9 because those suites need a server and the full UI; unit tests stay strictly per-task.
