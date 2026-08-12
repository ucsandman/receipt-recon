# Errors and lessons

Short entries only: the failure, the root cause, the fix, the date.

---

## "Subtotal" contains "Total" — the receipt-parsing trap

**Date:** 2026-08-12

**Failure.** The first total-extraction regex recovered the wrong amount from 3
of 4 scanned receipts. OCR confidence was 94% and the OCR text was word-perfect,
so the obvious conclusion (bad OCR) was wrong.

**Root cause.** The pattern was case-insensitive and unanchored:

```js
/(?:TOTAL|BALANCE\s*DUE)\s*:?\s*[$€£]?\s*([\d,]+\.\d{2})/i
```

A receipt reads `Subtotal: $61.94` ... `TOTAL: $79.75`. Case-insensitively,
`TOTAL` matches inside `Sub-total-`, and since it appears first, the parser
returned the **subtotal** and silently under-read every itemized receipt.

This is the worst class of bug for an audit tool: it fails quietly and in a
plausible direction. A subtotal always looks like a believable total.

**Fix.** Anchor on a word boundary, and order the alternates longest-first so
`TOTAL DUE` is not shadowed by a bare `TOTAL`:

```js
/\b(?:TOTAL\s*DUE|TOTAL\s*FARE|BALANCE\s*DUE|AMOUNT\s*DUE|TOTAL)\b\s*:?\s*[$€£]?\s*([\d,]+\.\d{2})/i
```

`\b` fails between `Sub` and `total` because both sides are word characters.

**Lesson that generalizes.** When an extraction result is wrong, check the
pattern before blaming the OCR. The sample set is what caught this: it had
receipts carrying both a subtotal and a total, so the two numbers could
disagree. A fixture where subtotal equals total would have hidden the bug.

**Guard.** `tests/` asserts the extracted total for every sample receipt against
the known figure, so this cannot regress silently.

---

## Rendering PDFs through node-canvas is not a browser test

**Date:** 2026-08-12

**Failure.** `pdfjs.page.render()` into a `node-canvas` surface threw
`TypeError: Image or Canvas expected` on image-only PDFs, which briefly looked
like the whole browser-side OCR design was unworkable.

**Root cause.** `node-canvas` does not implement the inline image XObject path
pdf.js uses. It is a limitation of the Node shim, not of pdf.js and not of the
browser. Real browsers render these PDFs correctly.

**Fix.** Prove the genuinely uncertain step in isolation. The open question was
whether WASM OCR could read a 300dpi rendered receipt, so the images were
rasterized outside pdf.js and fed straight to tesseract.js: 4/4 exact. Browser
canvas rendering was then verified in an actual browser rather than a shim.

**Lesson that generalizes.** When a proof-of-mechanism fails, first ask whether
the harness or the mechanism failed. Do not redesign around a test-shim defect.
