# Decisions

Durable architecture and product decisions. Short entries: the decision, why,
what was rejected, the date.

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
