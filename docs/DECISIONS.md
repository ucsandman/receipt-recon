# Decisions

Durable architecture and product decisions. Short entries: the decision, why,
what was rejected, the date.

---

## Statement reconciliation: named tolerances, HARD/SOFT split, no bank API

**Date:** 2026-08-14

**Decision.** Roadmap #19 shipped local-file only. The design spec it demanded:
a statement charge matches an expense row when amounts agree within
`amountToleranceAbs` and dates within `statementDateToleranceDays` (default 5,
editable), same currency when both sides state one, one-to-one matching with
smallest date gap winning and vendor similarity only as a tiebreak (issuer
descriptors like "SQ *COFFEE SHOP" are too mangled to require a name match).
Amounts compare as absolute values because issuers disagree on sign; payment
lines are skipped by keyword and the skip count disclosed. An unmatched charge
is `UNCLAIMED_CHARGE` at HARD, report-level — unreported spend is the blind spot
the Methodology tab used to admit. An unmatched expense row is
`CLAIMED_NOT_ON_STATEMENT` at SOFT, on the row — cash or a personal card is an
innocent explanation. Parsed statement lines join the run-hash material when
present. **Rejected:** any live bank connection (Plaid/OAuth), and HARD severity
for rows missing from the statement.

## Reviewer decisions persist as an explicit session file, never localStorage

**Date:** 2026-08-14

**Decision.** Roadmap #20's open question. Decisions live in memory, export to
and reload from a JSON session file carrying the run hash, and are refused
per-entry when they match no finding in the current run (hash mismatch warns).
They stay out of the run hash: the hash proves what was audited, and a human's
verdict is not an input to that. **Rejected:** localStorage auto-restore —
silently keeping review verdicts on a shared corporate laptop contradicts the
"nothing is retained" posture, the same reasoning that trimmed policy
persistence in roadmap #14.

## FX rates the user types feed a labelled estimate view only

**Date:** 2026-08-14

**Decision.** Roadmap #27 shipped as the disclosed-view variant: `fxRates` /
`fxBase` in the policy produce an "at your stated rates" block on the budget
card and workbook, with the rates printed beside the converted totals. Findings,
budget lines and every comparison stay strictly per-currency. **Rejected:** the
original proposal of converting inside the amount check — a hand-typed rate
rarely reconciles to the penny against the card's real conversion, so it would
manufacture mismatches of its own. RULESET_VERSION bumped 1.0.0 → 1.1.0 because
the policy object is hash material and gained keys.

---

## Browser-only, zero-install, over a Python pipeline

**Date:** 2026-08-12

**Decision.** Ship a static browser page (pdf.js + tesseract.js + SheetJS) rather
than a Python CLI or a packaged desktop app.

**How it was chosen.** Four architectures were designed independently and scored by
three judges applying separate lenses: true cost, non-developer usability, and audit
correctness.

| Design | Approach | Score /30 |
| --- | --- | --- |
| Browser, zero-install | pdf.js + tesseract.js + SheetJS, static page | **24** |
| Local Python ladder | RapidOCR + rules, shipped as a PyInstaller .exe | 23.5 |
| Excel-native | openpyxl workbook builder, policy config as an Excel tab | 16.5 |
| Cloud AI | Gemini free tier for extraction | 7 |

**Why the winner won.** Cost is structural rather than a bet on a vendor's goodwill.
There is no metered service in the data path, so there is no free tier that can be
repriced or revoked. Delivery is a URL, which is the only path that clears a
locked-down corporate laptop with no admin rights.

**Why the runner-up lost.** The Python design was technically strong and scored well
on correctness, but ships as a large unsigned PyInstaller binary. That is exactly the
artifact AppLocker and WDAC exist to block, with no fix the user can apply themselves.
A free tool a laptop will not run is not free, it is unusable.

**Why the cloud design was destroyed (7/30).** Google cut the Gemini free tier 50-80%
without warning in December 2025. Beyond quota risk, Google's own documentation states
that free-tier content is used to improve their products and may be seen by human
reviewers. Mistral's free tier trains on submitted data too, unless a manual opt-out is
found and flipped. Sending client financial records through either is a confidentiality
problem regardless of price. A local vision model was also rejected: the only
CPU-viable candidate was observed inventing numbers on a real receipt, which is the one
failure mode an audit tool cannot have.

**Ideas grafted from the losing designs.**
- A CSP with `connect-src 'self'`, so the privacy claim is enforced by the browser
  rather than promised in a README.
- A SHA-256 run hash, so an auditor can prove two runs are identical.
- Permissive-license-only dependency hygiene (see below).
- Policy thresholds as editable config rather than constants in code.

**Still open.** The optional, off-by-default, human-approved escalation to Azure
Document Intelligence (free tier, does not train on customer data) for the rare
receipt local OCR cannot read. Deliberately not in v1: it reintroduces a vendor
dependency and the current ladder resolved 37/37 sample receipts without it.

---

## Deterministic rules engine, not an LLM verdict

**Date:** 2026-08-12

**Decision.** An LLM is never asked whether a transaction is acceptable. Extraction
produces fields; plain code decides pass or fail.

**Why.** An auditor has two obligations a model cannot meet. They must reproduce last
month's audit and get last month's answer, and they must explain to a reviewer exactly
why a specific row was flagged. A rules engine gives a rule code, a triggering value, a
threshold, and a ruleset version on every finding. Roughly 85% of a real expense audit
is arithmetic and table lookups once the fields exist, so almost nothing is given up.

**Consequence.** Findings are split into hard violations and soft signals, kept in
separate tiers so a weekend charge never buries a missing receipt.

---

## Permissive licenses only, including in dev tooling

**Date:** 2026-08-12

**Decision.** MIT, Apache-2.0 and BSD dependencies only, in the app *and* in the
sample-data generator.

**Why.** PyMuPDF was the obvious choice for rasterising sample receipts and was
already working, but it is AGPL-3.0. Distributing an MIT repo containing a script that
imports it is a license conflict. Replaced with pypdfium2 (Apache-2.0 / BSD-3).

**Also rejected on license grounds:** Marker and LayoutLMv3, both of which ship
non-commercial CC-BY-NC-SA model weights, which a for-profit employer's use would
plausibly violate. Donut was rejected separately as unmaintained since 2022.

---

## Vendored dependencies, no CDN, no build step

**Date:** 2026-08-12

**Decision.** Commit all ~9 MB of pdf.js, tesseract.js and SheetJS into `vendor/`.

**Why.** A corporate network that blocks a CDN would otherwise break the tool at the
worst moment. Vendoring also makes the offline claim true rather than aspirational,
and keeps the repo auditable: a sceptical IT department can read every line that runs.

**Cost.** ~2.5 MB on first load. The 6.5 MB OCR engine loads only when an image-only
PDF actually appears, which never happens on sets that are all digital receipts.

**Gotcha found the hard way.** `corePath` must point at one specific tesseract core
file, not at the directory. Given a directory, tesseract.js probes for whichever
variant the browser supports and requested a relaxed-SIMD build that was not shipped.

---

## Keyboard operability is a correctness requirement, not a nicety

**Date:** 2026-08-12

**Decision.** Every task the mouse can do is reachable and operable from the
keyboard, and `tools/a11y-check.mjs` fails the build if that stops being true.

**Why.** The first version was unusable without a mouse in the two places that
matter most. Both file inputs carried the `hidden` attribute, which resolves to
`display: none` and removes an element from the tab order, so a keyboard user
could not load a spreadsheet at all. Result rows were `<tr>` elements with a
click listener and no tabindex, so the evidence drawer could not be opened
either. Nothing surfaced this: the page looked finished and every test passed.

**How the row handle was resolved.** Putting `tabindex="0"` and `role="button"`
on the `<tr>` was rejected: it trades away row semantics, and a screen reader
then announces a button where a table row is. Instead the transaction id cell
holds a real `<button>`. Mouse users still click anywhere on the row, the click
is delegated once on `<tbody>`, and both paths run the same code, so they cannot
drift apart.

**Consequence.** The evidence panel is a drawer, not a modal, and is not focus
trapped. It exists to be read *against* the row behind it, so trapping focus or
setting `aria-modal` would fight the actual task. Focus moves in on open and
returns to the originating row on Escape, but a click elsewhere dismisses it
without pulling focus backwards.

---

## Contrast is verified against the rendered page, not the palette

**Date:** 2026-08-12

**Decision.** The AA check walks every text node in a real browser, resolves the
effective background by climbing ancestors, and compares that. It runs in both
themes.

**Why.** The muted ink rung was originally tuned by eye against the page
background, where it reached 3.75:1, and then used on the table header and other
`--surface-2` wells where it fell to 3.50:1. Arithmetic on the token list would
have cleared it, because the token list does not know which surfaces a colour
actually lands on. Every ink rung is now set against the *darkest* surface it
appears on.

**Guard.** Reverting the token to its old value fails the check, which is how the
check was confirmed to have teeth rather than being decorative.

---

## The dark palette is duplicated on purpose

**Date:** 2026-08-12

**Decision.** Write the dark tokens twice, once under
`@media (prefers-color-scheme: dark)` and once under `:root[data-theme="dark"]`,
instead of collapsing both into `light-dark()`.

**Why.** `light-dark()` would state the palette once and is the cleaner code, but
it needs Chrome 123 or later. The product exists to work on the locked-down
corporate laptop that is several years behind, and the failure mode is not
graceful: unsupported colour functions resolve to invalid, which strips the
palette rather than falling back to it. Twenty duplicated lines are cheaper than
an unreadable page on the exact machine this tool was built for.

**Related.** The theme bootstrap is `app/theme-boot.js` rather than an inline
`<script>` for the same class of reason: the page's CSP is `script-src 'self'`
with no `'unsafe-inline'`, and a hand-maintained hash would rot on every edit.
It has to run before first paint, and `app/main.js` cannot, because modules
defer.

---

## Mileage and per-diem are exempt from the receipt requirement, by policy

**Date:** 2026-08-12

**Decision.** Add `policy.noReceiptCategories` and route matching rows into their
own `CATEGORY_EXEMPT_NO_RECEIPT` branch, rather than reusing the under-floor one.
The list is editable in the policy panel and printed into the Methodology tab.

**Why.** The Methodology tab already told the reader that mileage and per-diem
have no support document by nature, but the engine did not know it, so every such
row at or above the $75 floor produced a guaranteed hard `MISSING_RECEIPT`, every
month, on every row. Reusing the under-floor branch was rejected because its
message reads "under the 75.00 floor", which is simply false on a $200 mileage
claim, and a finding that states a false reason is worse than no finding.

**Alternatives rejected.** Hardcoding the category names, which would have made
the suppression invisible to the reviewer. Any suppression an auditor cannot see
and cannot switch off is a liability, so the list is both configurable and
disclosed in the workbook. Emptying it restores the old behaviour exactly.

---

## An unreadable currency is reported, not ignored

**Date:** 2026-08-12

**Decision.** Widen the currency code list from 12 to 49, require a parsed code
to sit adjacent to a number, and emit a soft `CURRENCY_UNVERIFIED` when no
currency could be read off a receipt whose amount was still compared.

**Why.** `CURRENCY_MISMATCH` was gated on a successfully parsed currency, so an
SGD or ZAR receipt raised no currency finding at all while the amount check
immediately above it compared the claimed number against the receipt total as if
they were the same unit. Silence read as agreement.

**Alternatives rejected.** Matching a bare currency code anywhere in the text.
With 49 codes that lets "PLEASE TRY OUR APP" book a row as Turkish lira, so a
code now only counts when it is adjacent to a digit, which is how a currency
actually appears on a receipt. Making the finding hard was also rejected: an
unverified assumption is a signal, not a proven violation, and hard findings are
what an auditor must clear before sign-off.

---

## One bad receipt costs one row, never the run

**Date:** 2026-08-12

**Decision.** Wrap each row's body in its own try/catch in `runAudit`, recording
the same `{tier:'failed'}` shape the file-not-found branch already writes.
Replace `Math.max(...all)` in `parseTotal` with a reduce.

**Why.** All 350 rows sat inside one try whose catch never assigned
`state.results`, so a single throw discarded every row already processed,
including minutes of OCR, with no partial output and no way to identify the
offending file. `parseFields` also ran outside `extractReceipt`'s only try, and
its `Math.max` spread overflows the argument stack at about 150,000 matches, so a
receipt carrying that many money figures took down the whole run. The fix writes
no new vocabulary: `rules.js` already converts that shape into a hard
`UNREADABLE_RECEIPT` naming the row.

**Related.** `clampScale` bounds both render sites to 40 million pixels. A PDF
may declare a 14400pt page box, which at the fixed 3.0x OCR scale is about 7.5 GB
of backing store. The dangerous outcome was never the crash: it was a blank
canvas that OCR reads as nothing and the parser then reports as "no monetary
amount found", which looks like a real result. When the clamp fires it pushes a
warning that surfaces as a visible soft finding.

---

## Spreadsheet intake lives in its own module so it can be tested

**Date:** 2026-08-12

**Decision.** Move `mapHeaders`, `normalizeDate`, `excelSerialToISO` and
`toNumber` out of `app/main.js` into `app/sheet.js`, unchanged, as a separate
commit before any behaviour changed.

**Why.** These roughly forty lines decide the fate of every row in the report and
had no unit coverage, not through neglect but because `main.js` imports
`pdf.min.mjs` and calls `init()` at load, so no node test could reach them. That
is how `normalizeDate` kept a `new Date(s)` fallback that resolved a spelled-out
date in local time: `"July 2, 2026"` returned `2026-07-01` in UTC+14 and
`2026-07-02` in UTC-11, and `row.date` is hashed material, so the reproducible
run hash depended on the machine it ran on.

**Related.** The replacement parses every accepted format by hand and returns
null for anything else, so an unrecognised date is reported missing rather than
silently off by one. `tests/sheet.test.mjs` opens with a control asserting that a
runtime TZ change still moves the ambient parser, so the timezone tests underneath
cannot pass vacuously if the platform stops honouring it.
