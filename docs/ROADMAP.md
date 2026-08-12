# Receipt Recon roadmap

Ranked output of a tournament of ideas run on 2026-08-12 against commit `ace860e`.
Five dimension specialists read the source and proposed improvements, an adversarial
challenger tested every premise against the code, and three judges scored the survivors
on separate and deliberately conflicting lenses.

> Receipt Recon's two headline guarantees, a deterministic run hash and a fully offline read, are both asserted more broadly than the code enforces them, and the single cheapest fix on the board (per-row fault isolation) is the difference between a 350-file run finishing and being thrown away by one bad PDF.

**Status.** All eight ship-now items landed on 2026-08-12 in commit ec9db7a, each with the check its entry asked for. Test suites went from 19 unit, 14 browser and 17 accessibility assertions to 37, 15 and 22.

| | Count |
| --- | --- |
| Ship now | 8 |
| Next | 10 |
| Later | 13 |
| Rejected | 7 |
| Judges disagreed by 4+ points | 18 |
| Total proposals judged | 38 |

## What the set of findings says that no single finding says

**The guarantees are broader than their enforcement, and every top-scoring finding is that gap**

The four highest integrity scores are not crashes, they are claim-versus-code gaps. runHash binds the claimed receipt filename but never the file's bytes (app/report.js:51-57) while the Summary tab says it proves the inputs matched. normalizeDate's fallback makes a hashed input depend on the auditor's timezone (app/main.js:143-145). The egress badge (index.html:46) claims more than a two-sink watchdog (app/main.js:41-63) enforces. The meta CSP does not reach the two worker realms that actually parse the untrusted bytes. Nothing here is exploited today; every one of them fails the moment a sceptic checks. For a product whose entire differentiator is a promise an LLM cannot make, the promises are the surface that needs hardening first.

**Intake is the least-defended layer and the most load-bearing**

Roughly forty lines in main.js decide the fate of all 350 rows: mapHeaders binds each field independently with a substring fallback and no collision bookkeeping (app/main.js:115-124), normalizeDate falls through to the ambient parser, resolveReceipt matches generously on basename and txnId (app/main.js:203-212), and acceptReceipts writes into a Map that is never cleared and silently discards every non-PDF (app/main.js:565-570). Six separate ideas land in this one region. It has zero unit tests, not by neglect, but because it lives in a module that imports pdf.min.mjs and calls init() at load, so no node test can reach it. Extracting those pure functions is the quiet prerequisite behind a third of this roadmap.

**The engine has a rich failure vocabulary that the orchestrator refuses to use**

rules.js already converts a {tier:'failed'} extraction into a HARD UNREADABLE_RECEIPT (app/rules.js:181-186) and any string in fields.warnings into a visible SOFT finding (app/rules.js:192-195). runAudit already writes exactly that failed shape for a file-not-found row (app/main.js:231-235). Yet the loop wraps all 350 rows in one try whose catch never assigns state.results, has no cancel, no partial output and no resume. The three cheapest high-value fixes on this list (fault isolation, the rasterization clamp's warning, the ambiguous-receipt case) all work by routing a new failure into machinery that already exists. The gap is not missing capability, it is an all-or-nothing orchestrator sitting on top of a per-row engine.

**Two rules that each assume the other has it covered is this engine's signature bug**

DUPLICATE_CHARGE exempts a group on the comment 'already reported above' while DUPLICATE_RECEIPT skips exactly that case (app/rules.js:333, 359-361). DUPLICATE_RECEIPT's dedup key is stricter than the resolver that decided which file each row was graded against. CURRENCY_MISMATCH is gated on a parsed currency, so the amount check silently runs currency-blind when parsing fails. The split detector measures every candidate against a seed chosen by sheet order. Each is one predicate to fix and each carries disproportionate cost in answer-key churn, which is why they cluster in ship-now for the unit test and in next for the sample-data regeneration. Fix them as predicates with node tests first; regenerate EXPECTED-FINDINGS.md as its own commit.

**The entire speed dimension is a rounding error, and half of it would be paid for in accuracy**

Five of the six lowest-scoring ideas are speed. By extract.js's own documented figures a 350-row run is tens of seconds, dominated by the ~11% OCR tier, and the user opens this tool once a month. Against that, parallelizing the loop introduces a getOcrWorker race, an OCR pool adds two more copies of a 9.5 MB WASM engine to a locked-down laptop, lowering the render scale trades read fidelity on the least trustworthy tier, and throttling progress writes had to carve out aria-valuenow to avoid breaking constraint 8. Only the two lazy-load items are clean, and they are worth 1 out of 10 to the user. The product's scarce resource is trust in the output, not milliseconds; optimise the former.

## Ship now (8)

Small, low regression risk, and each one has a concrete check that proves it landed.

### 1. One unparseable receipt aborts the whole run and discards results

`security` · effort **S** · **low** risk · score **23/30** (value 6 · cost 9 · integrity 8)

**Problem.** runAudit wraps all 350 rows in a single try (app/main.js:230-277) whose catch never assigns state.results and never unhides the results section, and parseFields runs outside extractReceipt's only try (app/extract.js:229). Any throw from any one receipt destroys every row already processed, with no partial output and no way to identify the offender.

**Change.** Wrap the per-row body of the loop in its own try/catch that records {tier:'failed', confidence:0, text:'', fields:{warnings:[]}, error} and continues. This shape is already produced two branches above at app/main.js:231-235 for the file-not-found case and app/rules.js:181-186 already converts it into a HARD UNREADABLE_RECEIPT, so the fix writes no new vocabulary. Replace the spread at app/extract.js:56 (Math.max(...all)) with a reduce so a receipt carrying 100k money figures cannot blow the stack.

**Why here.** Highest total on the board (23) and the best effort-to-payoff: it only produces output where today there is none, so no existing finding, tile count or run hash can move. It also ranks first for sequencing — every other idea that touches extraction (image receipts, rasterization clamp, byte hashing) becomes safer to build once a single bad file costs one row instead of the run. Judges agreed within 3 points; the value lens docked it only because it fixes a catastrophic-but-rare event rather than a monthly one.

**Proof it shipped.** Add a case to tests/extract.test.mjs asserting parseTotal survives a 100k-match text without throwing, and an assertion in tools/browser-check.mjs that a run over a sample folder containing one deliberately corrupt PDF still renders 40 rows in #resultBody with exactly one UNREADABLE_RECEIPT.

**Touches.** `app/main.js`, `app/extract.js`

### 2. normalizeDate's fallback parses non-ISO dates in local time, breaking the run-hash guarantee

`reliability` · effort **S** · **low** risk · score **21/30** (value 5 · cost 7 · integrity 9) · **judges split by 4pt**

**Problem.** normalizeDate handles Excel serials, ISO and D/M/Y-with-separator by hand, then falls through to `const d = new Date(s)` followed by .toISOString() (app/main.js:143-145). The ambient parser resolves spelled-out dates like 'July 2, 2026' in local time, so east of UTC the row date shifts back a day — and row.date is hashed material (app/report.js:52).

**Change.** Replace the new Date(s) fallback with an explicit spelled-out-month parser reusing extract.js's MONTHS table, so every accepted format is parsed by hand into YYYY-MM-DD with no dependency on the ambient parser's timezone behaviour.

**Why here.** Spread of 4: the integrity lens scored 9 because a hashed input silently depends on the auditor's machine, which falsifies the reproducibility claim printed in the workbook; the value lens scored 5 because Excel serials and ISO cover the common exports, so it only bites on spelled-out dates outside US timezones. Both are right, and the integrity view wins here because reproducibility is the product's entire differentiator (constraint 4) — a guarantee with a machine-dependent input is not a guarantee. Cheap, contained, and it changes nothing on the current sample set.

**Proof it shipped.** New test in tests/rules.test.mjs (after extracting normalizeDate, see rank 10) asserting normalizeDate('July 2, 2026') === '2026-07-02' under process.env.TZ='Pacific/Kiritimati' and TZ='Pacific/Midway'.

**Touches.** `app/main.js`

### 3. Re-picking the receipts folder doesn't clear the old one

`features` · effort **S** · **low** risk · score **20/30** (value 5 · cost 8 · integrity 7)

**Problem.** acceptReceipts (app/main.js:565-570) only ever calls state.receipts.set and nothing anywhere clears the Map. Pick the wrong folder, notice, pick the right one, and every file that existed only in the wrong folder stays eligible to resolve via resolveReceipt's generous basename/txnId fallbacks (app/main.js:203-212) and be cited as evidence in the exported workbook.

**Change.** Clear state.receipts on the fileReceipts change event (a webkitdirectory pick is always a whole folder, never partial) while leaving drag-drop additive, and add a 'Clear receipts' text button beside #dropReceipts that clears the Map and resets the status text.

**Why here.** Ranked ahead of the fuller rank-12 version of the same defect on purpose: this is the cheap ~80% that touches no rules code, no hash and no matching logic, and it removes the stale-state hazard before rank 12 re-keys the Map and adds an AMBIGUOUS_RECEIPT finding on top. Shipping the M-effort version first would mix a state-lifecycle fix with a matching-behaviour change in one diff. Judges spread 3, all three confirmed the write-only Map.

**Proof it shipped.** Assertion in tools/browser-check.mjs: load folder A, then folder B, and assert #statusReceipts reports exactly B's file count; plus an a11y-check.mjs assertion that the new Clear button is in the tab order and has an accessible name.

**Touches.** `app/main.js`, `index.html`

### 4. Exempt mileage/per-diem rows from the receipt-floor check

`capabilities` · effort **S** · **low** risk · score **21/30** (value 8 · cost 7 · integrity 6)

**Problem.** The Methodology tab (app/report.js:188) states mileage and per-diem have no support document by nature, but rules.js has no exemption: checkRow's presence block (app/rules.js:155-163) gives every such row at or above the $75 floor a guaranteed HARD MISSING_RECEIPT, every month, on every row.

**Change.** Add policy.noReceiptCategories = ['Mileage','Per Diem','Per-Diem'] to DEFAULT_POLICY, exposed as an editable list in the policy panel, and route matching rows into a distinct CATEGORY_EXEMPT_NO_RECEIPT branch that shares the date/vendor/purpose completeness check with the under-floor branch but does NOT reuse its 'under the $X floor' wording (app/rules.js:174-176), which would be false for a $200 mileage claim. Print the exempt list into the Methodology tab so the suppression is disclosed.

**Why here.** Tightest agreement on the board (spread 2) and the only ship-now item that removes recurring false HARD exceptions rather than adding work. The sample generator emits no Mileage or Per Diem categories, so zero answer-key rows move and the 19 tests cannot regress. The integrity lens scored it lowest (6) because it is a suppression lever — that is why the proposal above keeps its own code and message and puts the category list in the workbook, rather than quietly folding it into the under-floor branch.

**Proof it shipped.** New tests/rules.test.mjs case: a $200 Mileage row with date/vendor/purpose present yields no MISSING_RECEIPT and no message containing 'floor'; a $200 Mileage row missing purpose yields a HARD finding naming 'business purpose'.

**Touches.** `app/rules.js`, `app/main.js`, `app/report.js`

### 5. DUPLICATE_CHARGE exempts the one case its own comment assumes is already covered

`reliability` · effort **S** · **low** risk · score **19/30** (value 6 · cost 6 · integrity 7)

**Problem.** checkBatch skips a same-vendor/date/amount group whenever `files.size <= 1` (app/rules.js:359-361) with the comment 'Already reported above if they share one file' — but DUPLICATE_RECEIPT skips blank-receipt rows entirely (app/rules.js:333). Two receiptless claims of identical vendor, date and amount are therefore flagged by neither rule.

**Change.** Exempt a group only when it shares exactly one NON-blank file, not merely when the file set has one member. Plant an all-blank-receipt duplicate pair in tools/make_sample_data.py and add the matching answer-key row so the case has permanent coverage.

**Why here.** Spread 1 — all three judges confirmed the gap independently. The engine change is one predicate, which is why it ships now; the sample-data regeneration is the expensive half, so ship the predicate with a unit test first and treat the answer-key plant as a follow-on commit. Under the $75 floor this pair currently passes completely clean, which is silence on the pattern (identical claim, zero evidence) that most deserves a human look.

**Proof it shipped.** New tests/rules.test.mjs case: two rows, same vendor/date/amount, both with receiptFile null, produce DUPLICATE_CHARGE on both txnIds; and a control case with both citing the same non-blank file still produces only DUPLICATE_RECEIPT.

**Touches.** `app/rules.js`, `tools/make_sample_data.py`, `sample-data/EXPECTED-FINDINGS.md`

### 6. Amount comparison silently ignores currency whenever the receipt's currency can't be parsed

`reliability` · effort **S** · **low** risk · score **20/30** (value 5 · cost 6 · integrity 9) · **judges split by 4pt**

**Problem.** parseCurrency recognises 4 symbols and a 12-code allowlist (app/extract.js:12, 60-70) and returns null otherwise. CURRENCY_MISMATCH is gated on f.currency being truthy (app/rules.js:223), so an SGD, ZAR, BRL or KRW receipt raises no currency finding at all while the amount check immediately above still compares the raw claimed number against the raw receipt total as if they were the same unit.

**Change.** Widen CURRENCY_SYMBOLS/CURRENCY_CODES to the common set, and when f.currency is null while row.currency is present (or the reverse), emit a SOFT CURRENCY_UNVERIFIED finding stating that the amount comparison assumed a single currency and could not confirm it.

**Why here.** Spread 4: the integrity lens scored 9 (an undisclosed currency-blind comparison is the exact false-clean this product exists to prevent), the value lens 5 (foreign receipts in unlisted currencies are a small slice of 350 rows). The integrity read decides it because the failure mode is silent — the auditor gets no signal at all, which is worse than a noisy one. Kept in ship-now despite adding a new code: the widened code list is a one-line edit and the SOFT finding only flips affected rows from clean to needs-review, which is a re-baseline, not a regression.

**Proof it shipped.** tests/rules.test.mjs case: row.currency 'USD' with extraction fields.currency null yields exactly one CURRENCY_UNVERIFIED at SOFT; tests/extract.test.mjs case asserting parseCurrency('Total SGD 42.00') returns 'SGD'.

**Touches.** `app/extract.js`, `app/rules.js`

### 7. Evidence drawer only ever shows receipt page 1

`features` · effort **S** · **low** risk · score **20/30** (value 6 · cost 7 · integrity 7)

**Problem.** The extraction ladder reads up to 10 pages (app/extract.js:170) and names hotel folios as its own multi-page example, but openPanel hardcodes doc.getPage(1) (app/main.js:475). When the flagged total or itemization sits on page 2, the auditor cannot see the evidence for the finding inside the tool at all.

**Change.** When doc.numPages > 1, add Prev/Next page controls above the canvas in #panelPdf and re-run the existing render block (app/main.js:476-482) for the selected page instead of the constant 1.

**Why here.** Spread 1 and the only unanimous mid-scorer (6/7/7). It touches no rule, no hash and no workbook, so it cannot regress a finding, and it closes the one place where the tool finds something it then refuses to show you. Ships now because the entire cost is giving two new buttons keyboard handling that the existing 17 a11y assertions already police.

**Proof it shipped.** tools/a11y-check.mjs assertion: open the drawer on a multi-page sample receipt, Tab reaches Next, Enter advances, and the page indicator text changes from '1 of N' to '2 of N'; single-page receipts render no controls.

**Touches.** `app/main.js`, `app/style.css`

### 8. A hostile or oversized PDF page box rasterizes to a multi-gigabyte canvas

`security` · effort **S** · **low** risk · score **19/30** (value 4 · cost 8 · integrity 7) · **judges split by 4pt**

**Problem.** renderToCanvas uses a fixed scale of 3.0 (app/extract.js:193) with no clamp on the resulting bitmap, and openPanel does the same at app/main.js:476. A PDF may declare a page box up to 14400x14400 pt, which at 3.0x is 43200x43200 px — roughly 7.5 GB of RGBA backing store. The worse outcome is not the crash but a blank render that parseFields then reports as 'no monetary amount found', which reads as a real result.

**Change.** Add a MAX_RASTER_PX constant and derive the scale as Math.min(3.0, Math.sqrt(MAX_RASTER_PX/(w*h))) in both render sites. When the clamp fires, push a string into fields.warnings, which app/rules.js:192-195 already turns into a visible SOFT EXTRACTION_WARNING so a downscaled read is never mistaken for a clean one.

**Why here.** Spread 4: the value lens scored 4 ('my receipts come from employees, not attackers'), cost and integrity scored 8 and 7 because the load-bearing fix is two expressions and a constant that fire only on pathological page boxes. Treat this as insurance rather than a security fix — and note the correction: maxImageSize on getDocument does not cap the MediaBox-driven canvas, so the scale clamp is the actual remedy and the maxImageSize half can be dropped. Sequenced after rank 1 so a clamp failure degrades one row, not the run.

**Proof it shipped.** tests/extract.test.mjs case with a stub doc reporting a 14400x14400 pt viewport: assert the computed canvas pixel count is <= MAX_RASTER_PX and that fields.warnings contains a downscale notice; assert all 4 OCR-tier sample receipts still extract identical totals (their scale must stay 3.0).

**Touches.** `app/extract.js`, `app/main.js`

## Next (10)

Clearly worth doing. Larger, or sequenced behind a ship-now item.

### 9. Two template writes skip esc() while their neighbours use it

`security` · effort **S** · **low** risk · score **15/30** (value 2 · cost 9 · integrity 4) · **judges split by 7pt**

**Problem.** app/main.js:406 interpolates x.code raw into innerHTML while every neighbouring cell in the same template is escaped, and app/main.js:522-523 writes `pc_${cat}` unescaped into both the label's `for` and the input's `id` while escaping the same value two characters away in data-cat.

**Change.** Apply esc() at all three sites and add a browser-check case that runs an audit over a row whose vendor and category contain `"><img src=x onerror=1>`, asserting no injected element exists in #resultBody or #policyGrid.

**Why here.** Spread 7, the widest on the list: cost scored 9 (three esc() calls, zero output change) against integrity 4 and value 2, because both sources are hardcoded constants today so there is no live injection path. That disagreement is really about what the score measures — everyone agrees it is nearly free and nearly pointless right now. It lands in next rather than ship-now because its value is entirely pre-emptive: 'learn category limits from the sheet' (rank 11's neighbourhood) and extractor-generated codes would each make one of these lines live. Bundle it with whichever browser-check hardening ships first.

**Proof it shipped.** New tools/browser-check.mjs assertion: after auditing a row with vendor `"><img src=x onerror=1>`, document.querySelectorAll('#resultBody img, #policyGrid img').length === 0 and the literal text appears in a cell.

**Touches.** `app/main.js`, `tools/browser-check.mjs`

### 10. An ambiguous spreadsheet header can bind to two logical fields at once and corrupt every row

`reliability` · effort **M** · **low** risk · score **20/30** (value 7 · cost 5 · integrity 8)

**Problem.** mapHeaders (app/main.js:115-124) matches each of the ten logical fields independently — an exact pass then a substring fallback, per field, with no record of which column another field already claimed. A header like 'Receipt Amount' or 'Receipt Total' contains both the amount alias 'amount' and the receiptFile alias 'receipt', so receiptFile binds to the dollar column and all 350 rows become UNREADABLE_RECEIPT with nothing in the UI pointing at the cause.

**Change.** Track claimed column indices in a Set and run the exact-match pass for every field before any field's substring fallback, so a precise alias always outranks an accidental substring. Separately extract mapHeaders, normalizeDate, toNumber and excelSerialToISO into a module that can be imported without pdf.js, so the intake layer becomes unit-testable the way rules.js and extract.js already are.

**Why here.** Ranked first in 'next' because it is the prerequisite for two other items: rank 2's normalizeDate test cannot run until these functions leave main.js (which imports pdf.min.mjs and calls init() at load), and rank 11's mapping UI needs a binding that is deterministic before it is worth displaying. Spread 3, but the cost lens scored it lowest (5) precisely because of that extraction — the refactor is the honest prerequisite and it is what pushes this out of surgical territory. Separate the mechanical extraction commit from the binding-order change.

**Proof it shipped.** New unit test over the extracted mapHeaders: header row ['Txn','Receipt Amount','Receipt File'] binds amount to index 1 and receiptFile to index 2, not both to index 1; plus a regression test that the existing sample header row maps identically before and after.

**Touches.** `app/main.js`, `tests/rules.test.mjs`

### 11. Column mapping is auto-guessed, silent, and fuzzy

`features` · effort **M** · **low** risk · score **20/30** (value 7 · cost 5 · integrity 8)

**Problem.** Which spreadsheet column feeds vendor, date, category or receiptFile is decided by alias matching in mapHeaders (app/main.js:115-124), never displayed, and never overridable. The only way to correct a bad guess today is to rename the header in the source spreadsheet — which constraint 5's non-developer auditor has no reason to suspect is necessary.

**Change.** After acceptSheet() succeeds (app/main.js:548-563), render a 'Columns we found' disclosure reusing the #step-policy pattern: each logical field beside a <select> populated from the sheet's real header row, defaulting to the auto-detected guess. Feed the confirmed mapping into readSheet instead of the raw guess. Zero behaviour change for anyone who never opens it.

**Why here.** Depends on rank 10 and is its human surface: rank 10 makes the guess correct, this makes it visible and correctable, and it is the only diagnosis path a non-developer has when intake goes wrong. Spread 3, with cost lowest at 5 because it inserts user-controlled state into the one code path every downstream result depends on. Do not ship it before rank 10, or the dropdown will faithfully display a collided binding.

**Proof it shipped.** tools/browser-check.mjs assertion: load the sample sheet, open the disclosure, change the Vendor select to a different column, run the audit, and assert the first row's Vendor cell in #resultBody matches the newly selected column's value; tools/a11y-check.mjs assertion that every select has a bound <label> and is keyboard-reachable.

**Touches.** `app/main.js`, `index.html`, `app/style.css`

### 12. Loaded receipts never clear and are keyed on basename, so one audit can cite another's PDFs

`security` · effort **M** · **low** risk · score **21/30** (value 7 · cost 5 · integrity 9) · **judges split by 4pt**

**Problem.** state.receipts is keyed on the lowercased basename (app/main.js:568) and never cleared. Two subfolders each containing 'receipt-01.pdf' silently collapse to one entry inside a single correct pick, and resolveReceipt's generous fallbacks (app/main.js:203-212) will happily attach whichever survived to a row whose evidence is then printed in the workbook.

**Change.** Key the Map on (f.webkitRelativePath || f.name).toLowerCase(), keep a separate basename index for resolveReceipt, and when one basename maps to two distinct paths return null and emit an AMBIGUOUS_RECEIPT finding instead of guessing. Report files actually accepted rather than Map.size.

**Why here.** Spread 4, and the disagreement is about scope, not truth: integrity scored 9 (guessing between two candidate evidence files is exactly what a Tier-3 'never guess' extractor refuses to do), cost scored 5 because the extra work beyond rank 3 — re-keying, a second index, a new finding code — moves matching outcomes and the run hash where the cheap version does not. Sequenced after rank 3 ships the lifecycle fix, so this diff contains only the matching change. The AMBIGUOUS_RECEIPT code is the load-bearing half; the re-keying alone would silently change which file wins.

**Proof it shipped.** tests/rules.test.mjs case asserting AMBIGUOUS_RECEIPT fires at HARD when the resolver reports two paths for one basename; tools/browser-check.mjs assertion that a folder with a/receipt.pdf and b/receipt.pdf reports 2 files loaded, not 1.

**Touches.** `app/main.js`, `app/rules.js`

### 13. The reproducibility hash never binds the receipt files it audited

`security` · effort **M** · **low** risk · score **22/30** (value 6 · cost 6 · integrity 10) · **judges split by 4pt**

**Problem.** runHash's material (app/report.js:51-57) covers txnId, date, vendor, category, amount, currency, the claimed receipt filename, the extraction tier, the parsed total and the finding codes — never the resolved file's identity or bytes. Two runs backed by entirely different PDFs hash identically whenever the parsed totals match, while the Summary tab presents the hash as proof the same inputs were audited.

**Change.** Digest the bytes already in hand at app/main.js:246 with crypto.subtle, attach {sha256, resolvedPath, byteLength} to the extraction result, add those to the hash material, and print the per-receipt digest as a column in Audit Detail (app/report.js:113-130) so a reviewer can re-verify one specific document a year later. Bump RULESET_VERSION, and guard the new path the same way runHash already guards for crypto.subtle being absent on file:// origins.

**Why here.** Spread 4 and the widest gap between what a lens values: integrity scored 10 — the only perfect score on the board — because this is the product's headline claim not actually covering the evidence; value scored 6 because it strengthens a sign-off without changing this month's findings. It sits in next rather than ship-now for one concrete reason the cost lens named: changing the hash material invalidates every previously recorded hash, so it needs a RULESET_VERSION bump and a docs change in the same commit. Sequence it after rank 12 so the digest binds a file identity that is already unambiguous.

**Proof it shipped.** tests/rules.test.mjs (or a new report test): two result sets identical except for one extraction's sha256 field produce different runHash values, and identical inputs produce a byte-identical hash across two calls; tools/browser-check.mjs assertion that the Audit Detail sheet contains a 64-hex-char digest for every row with a resolved receipt.

**Touches.** `app/main.js`, `app/extract.js`, `app/report.js`, `README.md`

### 14. Policy resets to factory defaults on every reload

`features` · effort **M** · **low** risk · score **20/30** (value 8 · cost 5 · integrity 7)

**Problem.** All nine numeric thresholds plus categoryLimits come from a structuredClone of DEFAULT_POLICY on every visit (app/main.js:23, 683-686). Those exact values are hashed (app/report.js:50) and printed into the Methodology tab, so a mistyped digit means the filed workbook applied a policy nobody intended and this month is not comparable to last month.

**Change.** Ship the explicit half only: 'Save policy' and 'Load policy' buttons beside 'Reset to defaults' (index.html:150-152), serialising state.policy to a downloaded .json and reading it back through a shape validator. Defer the localStorage auto-mirror.

**Why here.** Spread 3, and the split is entirely about the localStorage half: value scored 8 for the shareable-policy-file idea, cost 5 and integrity 7 both flagged that silently restoring an edited policy makes the same spreadsheet produce different findings across sessions with nothing on screen saying so — which cuts against the reproducibility pitch the feature is meant to serve. Ship the file, skip the auto-restore. That trim also removes most of the shape-validation cost, since an explicit Load is a moment the user can be shown what they loaded.

**Proof it shipped.** tools/browser-check.mjs assertion: change receiptRequiredAtOrAbove to 25, save, reset to defaults, load the saved file, and assert the input reads 25 and the Methodology tab of a fresh workbook prints 25.00; plus a rejection test that loading a JSON with a string where a number belongs shows the error banner and leaves state.policy untouched.

**Touches.** `app/main.js`, `index.html`

### 15. Accept JPG/PNG receipt photos, not just PDFs

`capabilities` · effort **M** · **low** risk · score **19/30** (value 7 · cost 6 · integrity 6)

**Problem.** acceptReceipts (app/main.js:566-570) admits a file only if its type is application/pdf or its name ends .pdf, and says nothing about the rest. A folder of phone-photographed receipts produces false MISSING_RECEIPT flags on every photographed expense and a loaded-file count that misrepresents what the user supplied.

**Change.** Accept .jpg/.jpeg/.png/.webp, add an extractReceiptImage path that decodes via createImageBitmap into a canvas and hands it straight to the already-vendored tesseract worker's recognize(), reusing parseFields unchanged — entering the ladder at Tier 2 since a photo has no text layer. Generalise resolveReceipt to try the sheet's own extension, and report skipped files by name.

**Why here.** The highest-value capability item that respects every constraint: no new dependency, nothing leaves the machine, PDF-only folders behave byte-identically. Spread 1, with all three judges docking it for the same reason — every photo enters on the least-certain tier, so the win in coverage is partly paid for in read confidence. Sequenced after rank 12 because it modifies resolveReceipt, the same function rank 12 re-keys; doing both at once would make a matching regression hard to attribute.

**Proof it shipped.** tools/browser-check.mjs assertion over a sample folder containing one PNG receipt: the row resolves, its tier reads 'ocr', its extracted total matches ground-truth.json, and #statusReceipts counts the PNG; plus an assertion that a folder containing a .docx reports it by name as skipped.

**Touches.** `app/main.js`, `app/extract.js`

### 16. DUPLICATE_RECEIPT's dedup key is stricter than the file-resolution logic it polices

`reliability` · effort **M** · **medium** risk · score **18/30** (value 6 · cost 4 · integrity 8) · **judges split by 4pt**

**Problem.** checkBatch keys the double-claim check on the raw lowercased spreadsheet cell (app/rules.js:334), while resolveReceipt strips path prefixes, tries with and without .pdf, and falls back to txnId.pdf (app/main.js:203-212). Two rows that were graded against the literally same PDF can produce different, non-colliding keys and evade the rule entirely — routine when one cell was pasted from Explorer with a full path and the other typed by hand.

**Change.** Pass the actually-resolved file identity from main.js into each row before checkBatch runs, so the engine dedupes on what was truly loaded rather than on raw sheet text. Add tests for the path-prefix, missing-extension and txnId-fallback-collision cases.

**Why here.** Spread 4: integrity scored 8 (a finding that fires only when two humans happened to spell a filename the same way is string-luck, not proof), cost scored 4 because the honest fix changes checkBatch's signature (app/rules.js:323, 411) and, by design, makes DUPLICATE_RECEIPT fire on rows it currently misses — so exception counts and the run hash move on real inputs. It ranks here rather than higher because rank 13 already plumbs resolved file identity from main.js into the extraction result; do that first and this becomes a much smaller change riding existing wiring.

**Proof it shipped.** tests/rules.test.mjs case: rows citing 'C:\\scans\\R-1001.pdf' and 'r-1001' that resolve to the same File both receive DUPLICATE_RECEIPT; control case where they resolve to different files receives none.

**Touches.** `app/rules.js`, `app/main.js`

### 17. Add a per-employee breakdown to the Summary tab

`capabilities` · effort **S** · **low** risk · score **17/30** (value 4 · cost 8 · integrity 5) · **judges split by 4pt**

**Problem.** At 350 transactions a month the report almost certainly spans a dozen employees, but the Summary sheet reports one global aggregate. A controller deciding who to call first has to pivot the Audit Detail tab by hand every close.

**Change.** After the 'Findings by rule' block (app/report.js:96-106), add a 'By employee' block grouping results by r.row.employee with exception count, review count and flagged-dollar total, sorted by flagged dollars descending. Do NOT mirror the `s + r.row.amount` pattern at app/report.js:72 for the dollar column — group per currency or print an explicit mixed-currency caveat.

**Why here.** Spread 4 and the cheapest item in this tier (cost 8, pure additive aggregation over data buildWorkbook already holds, touching no rule and nothing in the hash material). It is held out of ship-now for one reason both the cost and integrity lenses raised independently: implemented naively it propagates the already-known mixed-currency summing defect into a new place, at finer grain and beside a named person. Fix the known 'Value flagged' tile defect first, then this column inherits the correct arithmetic instead of the wrong one. Value scored it 4 — an accountant can pivot a sheet in thirty seconds.

**Proof it shipped.** tools/browser-check.mjs assertion on the generated workbook: the Summary sheet contains a row per distinct employee in ground-truth.json, counts sum to the global exception/review totals, and a mixed-currency employee's dollar cell either shows per-currency subtotals or the caveat string.

**Touches.** `app/report.js`

### 18. Split-transaction grouping checks every candidate against one seed row, not against each other

`reliability` · effort **M** · **medium** risk · score **17/30** (value 6 · cost 4 · integrity 7)

**Problem.** The split detector's inner loop measures each candidate's date gap and vendor similarity against the first unflagged row in sheet order (app/rules.js:377-387). A leg within splitWindowDays of another leg but outside the window from the seed is dropped, which can pull the group total back under approvalThreshold — and because the seed is 'first in input order', not 'earliest date', the finding depends on unrelated row ordering in the export.

**Change.** Sort `remaining` by date before grouping and track each group's running min/max date span, so a candidate must fit the group's actual span rather than the seed's date. Add tests for a 3-leg split whose outer leg is in range of the middle leg but not the seed, and for the same transactions in shuffled row order.

**Why here.** Spread 3 but the sharpest value-versus-cost split in this tier: value scored 6 because split detection is the marquee fraud check and a hole in it is a false clean on threshold-dodging, cost scored 4 because this is the single highest-sensitivity loop in the engine and the change alters existing SPLIT_TRANSACTION output by construction — the sample set has a planted split (tools/make_sample_data.py:585) whose grouping the answer key asserts. Last in 'next' because it demands answer-key work and a careful re-read of EXPECTED-FINDINGS.md, not because the bug is doubtful.

**Proof it shipped.** tests/rules.test.mjs: a 3-leg same-employee same-vendor split on days 1/4/7 with splitWindowDays=3 flags all three; and the identical rows in reversed array order produce an identical set of flagged txnIds.

**Touches.** `app/rules.js`, `tests/rules.test.mjs`

## Later (13)

Real, but low leverage right now, or needs a call from the owner.

### 19. Local-file card statement reconciliation, not a bank API

`capabilities` · effort **L** · **medium** risk · score **17/30** (value 9 · cost 2 · integrity 6) · **judges split by 7pt**

**Problem.** README.md and the Methodology tab (app/report.js:186) both state that no card statement is compared and that a charge existing with no expense row at all is invisible to the tool. Unreported spend is the one failure class the product openly cannot see.

**Change.** A third drop zone for a card-statement export the user downloads themselves, parsed with the existing XLSX.read path, feeding a checkStatement(rows, statementRows, policy) batch function that emits UNCLAIMED_CHARGE and CLAIMED_NOT_ON_STATEMENT. Explicitly no Plaid, no OAuth, no live connection.

**Why here.** Spread 7, the joint-widest on the board, and the disagreement is the whole story: value scored 9 (this automates the largest manual step of a month-end close and adds a finding class the tool cannot produce at all), cost scored 2 (a second column-alias system, issuer vendor-name normalisation for descriptors like 'SQ *COFFEE SHOP NYC', a new batch check, two new finding types, tests and docs — in a 1,929-line codebase whose virtue is being small), integrity 6. This is the highest-upside idea here and it is not shippable as written: 'fuzzy match' names no tolerance, no policy field and no severity, unlike every other rule in rules.js. It belongs in 'later' pending an owner decision, and the next step is a design spec with named tolerances and severities, not code.

**Proof it shipped.** Blocked on a design spec first. When built: tests/rules.test.mjs must assert UNCLAIMED_CHARGE fires for a statement line with no row inside statementDateToleranceDays and does NOT fire when a row matches at the tolerance boundary, with the severity asserted explicitly.

**Touches.** `index.html`, `app/main.js`, `app/rules.js`, `app/report.js`

### 20. Reviewer decisions have no UI at all

`features` · effort **L** · **medium** risk · score **16/30** (value 6 · cost 3 · integrity 7) · **judges split by 4pt**

**Problem.** The Exceptions sheet emits 'Reviewer decision', 'Reviewer', 'Date reviewed' and 'Note' columns that are always blank (app/report.js:141, 164), and index.html:242-244 tells the user to fill them in Excel. The auditor reviews in the drawer where the PDF and the comparison table are, then re-derives every decision in a separate file.

**Change.** A decision control under each finding in the evidence panel backed by a state.reviews Map keyed `${txnId}::${code}`, merged back onto state.results after auditAll recomputes, read by buildWorkbook instead of emitting blanks. Keep the map out of runHash's material.

**Why here.** Spread 4: integrity 7 and value 6 both see a documented workflow with no control anywhere in the page; cost scored 3 because it is L-sized (new state, controls inside a drawer that 17 a11y assertions already police, a merge-back that survives re-running auditAll, workbook writes) and, critically, has no persistence story — losing 350 typed decisions to a refresh would be worse than the Excel workflow it replaces. Parked in later pending an owner decision on persistence, which on a shared corporate laptop is not an obvious localStorage yes. The correction is right that runHash reads only row/extraction/code data, so reproducibility survives by construction.

**Proof it shipped.** tools/browser-check.mjs assertion: set a decision and note on one finding, download the workbook, and assert the Exceptions row carries both values; plus an assertion that runHash is byte-identical before and after the decision was entered.

**Touches.** `app/main.js`, `app/report.js`, `index.html`

### 21. Nothing in the repo records or verifies what is in vendor/

`security` · effort **M** · **low** risk · score **16/30** (value 2 · cost 6 · integrity 8) · **judges split by 6pt**

**Problem.** Seven binaries totalling roughly 9 MB constitute the entire runtime, with no version, upstream URL, license or checksum recorded anywhere, and .gitattributes suppresses diffs on that directory so any change appears in review as an opaque blob.

**Change.** Add vendor/MANIFEST.json (name, upstream URL, version, license, SHA-256 per file) and tools/verify-vendor.mjs that recomputes digests and exits non-zero on drift, wired into the test script. Drop the two bundled extras: SRI on index.html:247 collides head-on with the lazy-load-xlsx idea, and bumping the pdf.js devDependency from ^5.4.149 to 6.x is a separate change that runs under all 19 tests.

**Why here.** Spread 6: integrity scored 8 (this is what lets the sceptical IT department the docs invite actually check the offline claim), value scored 2 (no effect on what an auditor catches). The honest reading is that this is maintainer hygiene, not user value — real, and correctly noting the vendored copies are not currently vulnerable. Trimmed to the manifest plus verify script it is purely additive dev tooling with zero runtime effect, and could be picked up any time a maintenance window appears.

**Proof it shipped.** `npm test` fails with a non-zero exit and names the drifted file after one byte of vendor/xlsx.full.min.js is altered, and passes on a clean tree.

**Touches.** `vendor/MANIFEST.json`, `tools/verify-vendor.mjs`, `package.json`

### 22. The egress watchdog wraps two sinks; navigation is not one of them

`security` · effort **S** · **low** risk · score **15/30** (value 2 · cost 5 · integrity 8) · **judges split by 6pt**

**Problem.** installNetworkWatchdog patches fetch and XMLHttpRequest.open and nothing else (app/main.js:41-63), while the badge at index.html:46-47 claims more than either that or the CSP enforces. No CSP directive restricts top-level navigation, so location.href or window.open would exfiltrate unnoticed by both layers.

**Change.** Ship the cheap, safe half: also trip on navigator.sendBeacon, WebSocket and EventSource, and reword the badge to the claim that is actually enforced and testable. Do NOT ship the click/beforeunload navigation guard — XLSX.writeFile (app/report.js:216) triggers its own anchor-click download that tools/browser-check.mjs exercises, so a naive guard risks tripping the badge on the product's own happy path.

**Why here.** Spread 6: integrity scored 8 (a sceptic who tests the headline trust control with one sendBeacon watches it pass silently, which costs more credibility than the gap costs security), value scored 2 (nothing in the app navigates or beacons; invisible to audit work). Split verdict: the three sink wrappers are a ten-minute change worth doing whenever this file is next open, the navigation guard is a real regression hazard and should stay unbuilt.

**Proof it shipped.** tools/browser-check.mjs assertion beside the existing external-request check: navigator.sendBeacon('https://example.com', 'x') from the page context throws or is refused and the watchdog banner appears, while a normal workbook download completes without tripping it.

**Touches.** `app/main.js`, `index.html`, `tools/browser-check.mjs`

### 23. PDF and OCR workers run with no CSP and outside the egress watchdog

`security` · effort **L** · **medium** risk · score **14/30** (value 2 · integrity 9 · cost 3) · **judges split by 7pt**

**Problem.** The CSP is delivered by <meta http-equiv> (index.html:17-27), which binds the document only. Both workers load from same-origin https URLs, and per CSP3 an https worker takes its policy from its own response headers — which GitHub Pages does not send. connect-src 'self' is therefore not enforced in the two realms that actually parse the untrusted PDF bytes, and the fetch/XHR watchdog does not run there either.

**Change.** Build both workers from blob: URLs, which do inherit the creating document's policy, with a module shim that wraps self.fetch/WebSocket before dynamically importing the real worker (pdf.js instantiates with {type:'module'}, so importScripts is not available on that one; the tesseract worker is classic and can use it).

**Why here.** Spread 7 across only two lenses that scored it: integrity 9 — the highest security score on the board, because the browser-enforced guarantee the product is sold on genuinely does not cover the code that reads the receipts — against value 2, since it is not exploitable today and changes nothing about a finding. That gap is the honest state of it: technically correct, strategically important to the trust story, and L-effort work on the fragile worker-bootstrap path. It needs an owner decision on whether the offline claim's completeness is worth an L, and it should not be attempted in the same window as any extraction change.

**Proof it shipped.** tools/browser-check.mjs assertion: a cross-origin fetch issued from inside the pdf.js worker realm is refused, and all 14 existing browser-check assertions plus the 4 OCR-tier sample extractions still pass unchanged.

**Touches.** `app/main.js`, `tools/browser-check.mjs`

### 24. Capture itemized line items, not just a line count

`capabilities` · effort **M** · **low** risk · score **16/30** (value 4 · cost 5 · integrity 7)

**Problem.** The MISSING_ITEMIZATION check scans receipt text for money-formatted lines to count them (app/rules.js:281-288) and then discards the lines, keeping only lineCount. Nothing downstream, including the workbook, ever shows a reviewer what the itemized lines were.

**Change.** Capture items as [{label, amount}] inside parseFields and have MISSING_ITEMIZATION read items.length, removing a regex duplicated across two files, and add an 'Itemized lines' column to Audit Detail.

**Why here.** Spread 3 with integrity highest at 7 (the rule already reads the evidence and throws it away). Held in later for the cost lens's specific catch: lineCount runs on ext.text while parseFields works on a whitespace-flattened copy (app/extract.js:128), so relocating the regex risks silently changing which rows fire MISSING_ITEMIZATION — and the correction is right that splitting a line into label and amount is new logic, not a move. Its real leverage is as a dependency: it is the only thing that would make rank 32's folio reconciliation honest, so revisit them together or not at all.

**Proof it shipped.** tests/extract.test.mjs asserting parseFields on a fixture folio returns 3 items with expected labels and amounts, plus a regression assertion that every sample receipt's MISSING_ITEMIZATION verdict is unchanged from EXPECTED-FINDINGS.md.

**Touches.** `app/extract.js`, `app/rules.js`, `app/report.js`

### 25. A running audit cannot be cancelled

`features` · effort **S** · **low** risk · score **16/30** (value 3 · cost 8 · integrity 5) · **judges split by 5pt**

**Problem.** Once 'Run the audit' starts there is no way to stop it. The only escape from a run against the wrong folder is closing or reloading the tab, which also discards the loaded spreadsheet.

**Change.** A Cancel button in #step-progress plus a state.cancelled flag checked at the existing yield point (app/main.js:259), breaking the loop, skipping auditAll and returning to step-input via the existing finally block so no partial audit ever reaches the screen.

**Why here.** Spread 5: cost scored 8 (the yield point and the finally block already exist, so this is a flag, a button and one if), value scored 3 (a wrong-folder run costs under a minute plus a reload, once a month). Nobody thinks it is hard and nobody thinks it matters much — which is exactly 'later': a good filler item to bundle with rank 3's Clear button, since both are affordances on the same wrong-folder mistake, but not worth its own window.

**Proof it shipped.** tools/browser-check.mjs assertion: click Run then Cancel, and assert #step-results stays hidden, state.results is unset, and the Run button is re-enabled; tools/a11y-check.mjs assertion that Cancel is keyboard-reachable while the run is in flight.

**Touches.** `index.html`, `app/main.js`

### 26. Give DUPLICATE_CHARGE a date tolerance, but only as a new SOFT finding

`capabilities` · effort **S** · **low** risk · score **14/30** (value 5 · cost 4 · integrity 5)

**Problem.** DUPLICATE_CHARGE groups on an exact string match of r.date (app/rules.js:353) while every other date comparison in the engine allows a tolerance window. The same charge claimed twice a calendar day apart — post-date versus transaction-date — is invisible.

**Change.** Replace the exact-key grouping with a pairwise scan using daysBetween, mirroring the SPLIT_TRANSACTION loop twenty lines below, gated on a new policy.duplicateChargeDateToleranceDays defaulting to 1. Emit near-date matches as a new SOFT POSSIBLE_DUPLICATE_CHARGE, not as the existing HARD code.

**Why here.** Spread 1 and the lowest-agreeing-but-uniform score in the tier (5/4/5). All three judges landed on the same objection: as originally specified it reuses HARD severity for a fuzzier signal, so daily parking and recurring identical subscriptions would generate a monthly stream of 'requires a decision' exceptions — the exact noise problem rank 4 exists to fix. In the corrected SOFT form it is defensible but it is still an O(n²) rewrite of a working rule plus a new code and new policy field, for a duplicate pattern that is real but uncommon. Later, and only in the SOFT form.

**Proof it shipped.** tests/rules.test.mjs: two rows, same vendor and amount, dates one day apart, produce POSSIBLE_DUPLICATE_CHARGE at SOFT and no HARD DUPLICATE_CHARGE; same-date rows still produce the HARD code; three-days-apart rows produce neither at the default tolerance.

**Touches.** `app/rules.js`

### 27. Make the amount check currency-aware with a manual FX table

`capabilities` · effort **M** · **medium** risk · score **13/30** (value 4 · cost 3 · integrity 6)

**Problem.** The amount ladder compares row.amount against ext.fields.total as raw numbers (app/rules.js:202) with no regard for currency, and can mislabel a genuine FX gap as UNSUPPORTED_TIP when the raw digit difference happens to land inside the 25% tip band (app/rules.js:205-209).

**Change.** An editable policy.fxRates map, never fetched, converting f.total into row.currency before the tolerance comparison when a rate exists, with the applied arithmetic printed on the finding ('100.00 EUR x 1.08 = 108.00 USD'). Keep today's CURRENCY_MISMATCH wording when no rate is configured.

**Why here.** Spread 3 and materially deflated by its own correction: CURRENCY_MISMATCH already fires HARD on these rows unconditionally (app/rules.js:223), so nothing is currently missed and the real payoff is diagnostic quality plus removing the spurious tip label. Cost scored 3 — it inserts conversion into the single most consequential comparison in the engine and needs a map-shaped policy field that renderPolicy (app/main.js:514-537) has no pattern for. Later, and it needs an owner decision first: a hand-typed rate rarely reconciles to the penny against a card's actual converted rate, so this can manufacture mismatches of its own.

**Proof it shipped.** tests/rules.test.mjs: a 100.00 EUR receipt against a 108.00 USD row with fxRates.EUR=1.08 produces no AMOUNT_MISMATCH and no UNSUPPORTED_TIP, and the CURRENCY_MISMATCH message contains the literal string '100.00 EUR x 1.08 = 108.00'; with no rate configured, output is byte-identical to today.

**Touches.** `app/rules.js`, `app/main.js`

### 28. Detail sheet emits findings the screen never showed

`features` · effort **S** · **low** risk · score **13/30** (value 2 · cost 7 · integrity 4) · **judges split by 5pt**

**Problem.** The results table and evidence drawer both filter out INFO-severity findings; the Audit Detail sheet does not (app/report.js:119-130), so the filed workbook can contain finding text the auditor never saw during review.

**Change.** Apply the same severity !== SEVERITY.INFO filter to the Detail sheet that the screen (app/main.js:394) and the Exceptions sheet (app/report.js:148) already use — or, per the integrity lens, show INFO findings on screen instead.

**Why here.** Spread 5, and the disagreement is about which direction the fix should go. Cost scored 7 (one filter, one already-imported constant, no hash impact), value 2 and integrity 4 both because the only INFO finding that exists today is app/rules.js:175's positive statement that an under-floor row carries amount, date, place and purpose — useful context in a filed workbook, not a leak. Since app/rules.js:64 defines INFO as deliberate context, deleting it from the record is arguably the worse of the two fixes. Park it until a second INFO-severity rule exists, then decide once for all three surfaces.

**Proof it shipped.** Once a direction is chosen: a report-level test asserting the set of finding codes in the Detail sheet equals the set rendered in #resultBody for the sample run.

**Touches.** `app/report.js`

### 29. Lazy-load xlsx.full.min.js instead of blocking on it

`speed` · effort **S** · **low** risk · score **13/30** (value 1 · cost 8 · integrity 4) · **judges split by 7pt**

**Problem.** vendor/xlsx.full.min.js (929.6 KB) loads as a classic parser-blocking <script> at index.html:247 on every visit, before the deferred module that wires the UI can run, even though XLSX is referenced in exactly two places (app/main.js:157 and the download handler at app/main.js:723), both already async.

**Change.** Inject it the way tesseract is injected today (app/main.js:74-82), gated on first entry into readSheet and the download click handler.

**Why here.** Spread 7: cost scored 8 (small, obviously testable, cannot alter a finding or the hash) against value 1 ('shaves page-load time on a tool I open twelve times a year and then sit in for a minute'). That gap is the whole speed dimension in miniature — the change is genuinely clean and the user genuinely does not care. It stays in later rather than rejected because it is the one speed item that costs nothing and risks nothing, and it conflicts with the SRI half of rank 21, so whoever touches either should decide between them.

**Proof it shipped.** tools/browser-check.mjs assertion: on first paint no request for xlsx.full.min.js has been made, the request appears only after a sheet is chosen, and all 14 existing assertions including the no-external-request check still pass.

**Touches.** `index.html`, `app/main.js`

### 30. Lazy-load pdf.min.mjs instead of an eager static import

`speed` · effort **M** · **medium** risk · score **11/30** (value 1 · cost 6 · integrity 4) · **judges split by 5pt**

**Problem.** pdf.min.mjs (444 KB) is a static ES import at app/main.js:8, so the browser must fetch, parse and evaluate it before any of main.js's top-level code — including init(), which wires every button — can run.

**Change.** A dynamic import cached in a module-level promise, awaited in runAudit and openPanel (app/main.js:473), with the GlobalWorkerOptions.workerSrc assignment (app/main.js:13) moved behind the same await.

**Why here.** Spread 5, same shape as rank 29 but strictly worse: value 1, integrity 4, cost 6 rather than 8, because workerSrc ordering is a real hazard and pdfjsLib is threaded into extractReceipt as a dependency. Additive with rank 29 for about 1.38 MB off the blocking path, which is still a saving nobody in this product's audience has asked for. Do it only if rank 29 ships and proves clean.

**Proof it shipped.** tools/browser-check.mjs assertion: no pdf.min.mjs request before Run is clicked, and the 4 OCR-tier sample receipts extract identical totals afterwards, proving workerSrc was set before the worker spawned.

**Touches.** `app/main.js`

### 31. round2's naive Math.round(n*100)/100 can misround at the hard/soft severity boundary

`reliability` · effort **S** · **low** risk · score **11/30** (value 2 · integrity 5 · cost 4)

**Problem.** round2 (app/rules.js:71) computes both the claimed-versus-receipt diff and the tipBand cutoff that decides SOFT tip versus HARD amount mismatch (app/rules.js:203-209), using the classic pattern that misrounds values landing exactly on a half-cent.

**Change.** Round in integer cents throughout — Math.round(n*100) as the canonical value, dividing by 100 only for display — so intermediate comparisons never re-round a boundary. The EPSILON-nudge alternative is itself a fudge and should not be used.

**Why here.** Only two lenses scored it (value 2, integrity 5, total 7 — the lowest non-speed score). Both agree it is real and both agree it is vanishingly thin: the diff must land exactly on the half-cent boundary of the tip band, and either outcome still puts the row in front of the auditor, just under a different label. It stays in 'later' rather than rejected because integer cents is the correct money representation for a tool that hashes its arithmetic, and it is a natural rider on any future rules.js refactor — not worth its own change.

**Proof it shipped.** tests/rules.test.mjs boundary case: an f.total and tipTolerancePct pair whose product is exactly a half-cent resolves to the same severity across 1,000 repetitions and matches a hand-computed integer-cent expectation.

**Touches.** `app/rules.js`

## Rejected (7)

Correctly identified and adversarially confirmed, but the score does not justify building it, or it quietly erodes what the product is for.

### 32. Stop flagging multi-line receipts (hotel folios) as duplicates

`capabilities` · effort **M** · **medium** risk · score **14/30** (value 7 · cost 3 · integrity 4) · **judges split by 4pt**

**Problem.** DUPLICATE_RECEIPT flags every row past the first citing one file, unconditionally (app/rules.js:338-347), so an itemized hotel folio split by charge type produces multiple false HARD 'claimed twice' findings per trip.

**Change.** Rejected as specified. The false-positive class is real and worth solving later, but not by this mechanism.

**Why here.** Rejected, and this is where the tiering rules bite rather than the score (14). The proposal downgrades a HARD fraud finding to SOFT whenever the group's amounts sum within tolerance of the receipt total — and as its own correction concedes, one genuine $80 charge plus one fabricated $120 charge passes that reconciliation exactly as well as three real folio lines. Auto-clearing a fraud finding on evidence that does not prove the thing it claims to prove is precisely the erosion of identity that disqualifies an idea here, whatever the value lens's 7 for folio noise. Spread 4 between value 7 and cost 3, with integrity 4 naming the auto-clear pattern directly. Revisit only after rank 24 makes real itemized lines available, so the downgrade can be validated against actual receipt lines rather than an aggregate that anything can sum to.

**Proof it shipped.** Not applicable — rejected. Any future version must assert in tests/rules.test.mjs that a fabricated second row which merely sums to the folio total is NOT downgraded, using per-line matching.

**Touches.** `app/rules.js`

### 33. No way to compare this run to last month's

`features` · effort **M** · **low** risk · score **10/30** (value 3 · cost 4 · integrity 3)

**Problem.** Nothing remembers a previous run, so comparing this month's exception count to last month's means reopening an old workbook.

**Change.** Rejected. Persisting run history to localStorage on the audit machine is the wrong trade for this product.

**Why here.** Rejected on identity, not just score (10, spread 1 — the judges agreed). It writes prior report names and counts into localStorage on what constraint 5 describes as a locked-down shared corporate laptop, which quietly contradicts the 'your receipts never leave the machine, nothing is retained' posture the whole product is sold on. On top of that, its own correction shows loadSample calls runAudit directly (app/main.js:651), so the 40-row demo run with 15 planted defects would poison the very history the feature exists to compare. A raw exception-count delta across months of different volume tells an auditor almost nothing, and last month's workbook is one file-open away.

**Proof it shipped.** Not applicable — rejected.

**Touches.** `app/main.js`

### 34. Parallelize the sequential receipt-extraction loop

`speed` · effort **M** · **medium** risk · score **9/30** (value 2 · cost 3 · integrity 4)

**Problem.** runAudit awaits each extraction before starting the next (app/main.js:230-260), so 350 receipts are processed strictly one at a time.

**Change.** Rejected. A bounded-concurrency pool over the hot loop is not worth the exposure at this scale.

**Why here.** Rejected at 9 (value 2, cost 3, integrity 4). By extract.js's own documented tier ratio and timings — roughly 89% text tier at ~5 ms, OCR at ~460 ms — 350 rows is on the order of half a minute serial, so the saving is tens of seconds once a month. Against that it rewrites the loop that owns progress, error handling and the run's only ordering guarantees, and its own correction concedes it must also add an in-flight-promise lock to getOcrWorker (app/main.js:69-70) or two concurrent OCR files will each load a duplicate ~9.5 MB engine. Buying seconds by introducing a race into the code that produces the audit is the wrong direction for a determinism-first product.

**Proof it shipped.** Not applicable — rejected.

**Touches.** `app/main.js`

### 35. Tune OCR render scale down from a hardcoded 3.0x

`speed` · effort **S** · **medium** risk · score **7/30** (value 1 · cost 4 · integrity 2)

**Problem.** renderToCanvas always rasterizes at scale 3.0 (app/extract.js:193) and nobody has measured whether the accuracy needs it.

**Change.** Rejected. Do not trade read fidelity for wall-clock on the least reliable tier.

**Why here.** Rejected at 7 (value 1, cost 4, integrity 2 — the lowest integrity score on the entire board). This lowers fidelity on the one tier that already warns below 70% confidence (app/extract.js:252), validated against only 4 sample receipts that live solely in tools/browser-check.mjs and not in the node tests. A degraded read produces a wrong extracted total sitting behind a clean verdict the auditor signs — the exact outcome the Tier-3 'never guess' philosophy exists to prevent — in exchange for a few seconds. The one legitimate fragment of this idea, clamping a pathological page box, already ships as rank 8.

**Proof it shipped.** Not applicable — rejected.

**Touches.** `app/extract.js`

### 36. Give OCR a worker pool instead of one shared worker

`speed` · effort **M** · **medium** risk · score **6/30** (value 1 · cost 2 · integrity 3)

**Problem.** getOcrWorker caches a single Tesseract worker for the whole run (app/main.js:69-94), so image-only receipts funnel through one WASM engine serially.

**Change.** Rejected. Two extra copies of the engine on the target machine is the wrong cost.

**Why here.** Lowest score on the board (6) and rejected on constraint 5 as much as on score. A 3-worker pool means three instantiations of the ~3.7 MB SIMD core plus 2.8 MB of traineddata each on a locked-down corporate laptop, to save single-digit seconds on the ~11% OCR tier — and it is entirely inert until rank 34, which is itself rejected, ships first. getOcrWorker already avoids the expensive mistake (re-instantiating per file); this optimises a cost the user has never noticed while adding memory pressure on the exact machine class the product targets.

**Proof it shipped.** Not applicable — rejected.

**Touches.** `app/main.js`

### 37. Pre-group the split-transaction scan by employee

`speed` · effort **S** · **low** risk · score **9/30** (value 1 · cost 4 · integrity 4)

**Problem.** The split detector rejects cross-employee pairs inside the inner loop (app/rules.js:382) rather than before it, so 350 rows produce roughly 61,000 pair comparisons instead of only same-employee ones.

**Change.** Rejected. Provably output-identical, and provably imperceptible.

**Why here.** Rejected at 9 with the proposal conceding the point itself: 61,000 cheap string comparisons is sub-millisecond against a run dominated by OCR. It is mechanical and safe, but it edits the highest-sensitivity loop in the engine — the same loop rank 18 needs to change for a real correctness reason — for zero measurable payoff. If the grouping ever happens, it should ride rank 18's diff as a structural side-effect, not arrive on its own as a performance change nobody can measure.

**Proof it shipped.** Not applicable — rejected. If folded into rank 18: assert the flagged txnId set is identical before and after over the full sample run.

**Touches.** `app/rules.js`

### 38. Throttle per-row progress-bar DOM writes

`speed` · effort **S** · **low** risk · score **8/30** (value 1 · cost 4 · integrity 3)

**Problem.** setProgress writes style.width, aria-valuenow and textContent once per row for all 350 rows (app/main.js:188-193), while the loop only yields every third row.

**Change.** Rejected. Three DOM writes per row are not the bottleneck, and the obvious version of this fix is an accessibility regression.

**Why here.** Lowest-value item on the board (value 1, integrity 3, total 8). It saves low single-digit milliseconds against per-file PDF parsing, and it degrades the only feedback the user has during the one operation they wait on. Its own correction had to carve out aria-valuenow, because gating that on 25% milestones would break constraint 8 for assistive tech that polls the attribute — a fix whose first draft violates a load-bearing constraint to save milliseconds does not belong on the roadmap at all.

**Proof it shipped.** Not applicable — rejected.

**Touches.** `app/main.js`

## How this was produced

Four rounds. Ideation by five specialists, one per dimension, each required to cite a
file and line it had actually opened. An adversarial challenger per dimension, told to
default to REJECT. Three judges scoring every survivor 0-10 on one lens each, forbidden
from balancing against the other two. A synthesizer ranking all of it into tiers.

The three lenses:

| Lens | Scores from the position of |
| --- | --- |
| User value | an auditor who signs their name under the result |
| Cost and regression risk | the engineer on the hook if the audit output changes |
| Product integrity | offline, deterministic, honest about its limits |

Two things worth recording about the process itself.

The challenge round killed nothing. All 38 proposals survived a stage told to default
to REJECT, which is unusual enough to be worth auditing rather than accepting. The five
challengers returned 555 to 1,071 characters of evidence per verdict, every one citing
specific lines, and 16 of the 38 came back with a material correction that changed the
framing before judging. The round worked as a corrector rather than a filter, most
likely because ideation was required to cite code it had actually opened. The filtering
happened one stage later, where seven proposals were tiered rejected on judgement.

The cost judge returned 36 scores for 38 ideas. Two proposals were therefore being
presented out of 20 while labelled out of 30. That judge was re-run on exactly those
two, with the full 38-idea slate as calibration context, and returned 3 and 4. Neither
changed tier, so the ranking did not depend on the missing data.

Findings text is the agents' own words, unedited.
