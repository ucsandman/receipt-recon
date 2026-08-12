# Receipt Recon

**Audit an expense report against its receipt PDFs. In your browser. Nothing gets uploaded.**

You drop in a spreadsheet and a folder of receipts. Every row gets matched to its
support document, checked against policy, and you get an Excel workbook saying what
is wrong, why, and which receipt proves it.

**[Try it now →](https://ucsandman.github.io/receipt-recon/)** · no install, no signup, no API key

![Results screen](docs/screenshots/02-results.png)

---

## Why this exists

Someone on Reddit asked for a cheaper alternative to [Shortcut](https://shortcut.ai)
for auditing monthly expense reports of up to 350 transactions, each with its own
PDF receipt. Their boss suggested Copilot. They were right that Copilot won't do it.

The useful thing we found while building this:

> **At 350 receipts a month, every option costs $0. Cost is not what should decide this.**

Gemini's free tier, Mistral's free tier, local OCR, a paid API at that volume, all
land at or near nothing. So the real questions are the other three:

1. **Is your data safe?** Google's free Gemini tier states plainly that submitted
   content is used to improve their products and that human reviewers may see it.
   Mistral's free tier trains on your data too, unless someone remembers to flip an
   opt-out. Expense receipts carry employee names, card digits and client financials.
2. **Can a non-developer actually run it?** Most answers to this problem are a Python
   pipeline. On a locked-down corporate laptop, `pip install` is where they die.
3. **Is the answer reproducible?** An auditor has to re-run last month and get last
   month's answer, and explain to a partner exactly why a row was flagged. A model
   that summarises "looks fine" cannot do either.

This tool is the answer that survives all three.

## The part nobody says out loud

**Auditing expenses is mostly not an AI problem.** Once you have the fields off a
receipt, roughly 85% of a real audit is arithmetic and table lookups: does the amount
match, is the receipt there, is this the same receipt twice, does this group of
charges add up to just under an approval limit.

So the AI budget goes on exactly one job, reading the PDF, and the checking is plain
deterministic code. Same inputs, same output, every single time.

On the bundled sample set:

| Tier | How it reads the receipt | Hit rate | Speed |
| --- | --- | --- | --- |
| 1 | PDF text layer (pdf.js) | **33 / 37** | ~5 ms |
| 2 | WASM OCR (tesseract.js) | **4 / 37** | ~460 ms |
| 3 | Gives up and says so | 0 / 37 | — |

Tier 3 is a feature. A tool that guesses when it cannot read a document is worse
than one that says "check this one yourself".

## Your files never leave your computer

This is not a promise in a README, it is enforced three ways:

- **There is no server.** The page is static files. There is no backend to receive
  anything, no account, no API key.
- **The browser blocks it.** A Content Security Policy sets `connect-src 'self'`, so
  the page is physically unable to open a connection to another host. Not "won't",
  *can't*. Try it: open DevTools → Network, run the whole audit, and watch nothing
  go out.
- **The page watches itself.** A wrapper around `fetch` and `XMLHttpRequest` flips the
  badge in the corner to a red warning if anything ever tries to call out.

Disconnect from the network entirely and it still works.

## What it checks

Every rule is deterministic and every threshold is editable in the UI.

**Documentation**
- `MISSING_RECEIPT` — no support document, at or above the $75 IRS documentary-evidence floor
- `NO_RECEIPT_UNDER_FLOOR` — under $75, so a receipt is not required; flags only if amount, date, place or purpose is missing
- `UNREADABLE_RECEIPT` — the file is there but could not be read; never guessed at
- `MISSING_ITEMIZATION` — a meal over the threshold with no itemised detail

**Matching the row against the receipt**
- `AMOUNT_MISMATCH` — claimed amount differs from the receipt total
- `UNSUPPORTED_TIP` — claimed exceeds the printed total within a plausible tip band, reported as a soft signal rather than a hard mismatch, so the queue doesn't flood
- `DATE_MISMATCH` · `VENDOR_MISMATCH` · `CURRENCY_MISMATCH`
- `RECEIPT_DOES_NOT_FOOT` — subtotal + tax + tip does not equal the printed total, so a number was misread or altered

**Policy**
- `OVER_CATEGORY_LIMIT` · `POLICY_ALCOHOL` · `PERSONAL_EXPENSE`

**Patterns across the whole batch** (invisible to any per-row check)
- `DUPLICATE_RECEIPT` — the same PDF cited by two rows; both get flagged, because the tool cannot know which is the original
- `DUPLICATE_CHARGE` — same vendor, date and amount claimed twice under different receipts
- `SPLIT_TRANSACTION` — several charges by one person at one vendor in a short window that total over the approval threshold while no single one crosses it

**Soft signals** kept in their own tier, so they never bury a real violation
- `WEEKEND_CHARGE` · `ROUND_AMOUNT` · `STALE_SUBMISSION` · `EXTRACTION_WARNING`

## What you get

A four-tab `.xlsx`:

| Tab | What's in it |
| --- | --- |
| **Summary** | Counts, value flagged, findings by rule, and a SHA-256 run hash |
| **Audit Detail** | Every transaction, not just the problems, with how each receipt was read and at what confidence |
| **Exceptions** | One row per finding, with the triggering value, the threshold, and blank **reviewer decision / reviewer / date / note** columns |
| **Methodology** | The ruleset version, every threshold applied, and an explicit list of what was *not* verified |

The run hash is the reproducibility proof: same report, same receipts, same policy,
same hash, same findings. That is the thing an LLM cannot give you.

## Prove it works before you trust it

Click **Try it with sample data**. You get 40 transactions with **15 problems planted
on purpose**, and [`sample-data/EXPECTED-FINDINGS.md`](sample-data/EXPECTED-FINDINGS.md)
is the answer key listing every one.

Check the tool against the key. Four of the receipts are image-only PDFs with no text
layer at all, so you can watch the OCR tier work.

Regenerate the set at any size:

```bash
python tools/make_sample_data.py --count 350
```

## Using it on real data

1. Open the [live page](https://ucsandman.github.io/receipt-recon/), or download this
   repo and open `index.html` through any local server.
2. Drop in your expense report. Column headers are matched loosely, so `Amount`,
   `Total`, `Claimed` and `Gross` all work.
3. Drop in the receipts folder. Files are matched by the receipt-file column, falling
   back to matching on the transaction ID.
4. Adjust **Policy settings** to your own thresholds.
5. **Run the audit**, then download the workbook.

Roughly a minute for 350 transactions when most have a text layer, longer if many
need OCR.

## Honest limits

Read these before relying on it.

- **No bank or card statement is compared.** Only the report and its attachments. A
  charge that exists with no row at all is invisible to this tool.
- **OCR quality on genuinely bad receipts is the weak point.** Tesseract handles clean
  scans well (94% confidence on the sample set) and struggles with crumpled, angled
  phone photos. Low-confidence reads are flagged, never silently accepted.
- **Business purpose is not judged.** Whether a stated reason is genuine is a human call.
- **Mileage and per-diem rows cannot be verified.** They have no receipt by nature.
- **Vendor matching is a similarity score**, not an identity check. The score and
  threshold are printed on every finding so you can second-guess it.
- **It drafts an audit, it does not sign one.** Nothing is auto-cleared.

## Development

```bash
npm install          # dev-only; the app itself has zero runtime dependencies
npm run sample       # regenerate the sample data (needs Python + reportlab, openpyxl, pypdfium2)
npm test             # 19 unit and integration tests
npm run serve        # http://localhost:8080
node tools/browser-check.mjs   # drives the real page in a real browser
```

The browser check is the one that matters. It runs the full audit in Chromium,
asserts the findings against the answer key, exercises the OCR tier, downloads the
workbook, and **fails if the page makes a single external network request**.

Everything in `vendor/` is committed on purpose. There is no build step and no CDN,
because a tool that stops working when a CDN is blocked is no use on a corporate
network.

## Built on

[pdf.js](https://mozilla.github.io/pdf.js/) · [tesseract.js](https://tesseract.projectnaptha.com/) ·
[SheetJS](https://sheetjs.com/) — all permissively licensed, all running locally.

PyMuPDF is deliberately *not* used anywhere, including the sample-data generator:
it is AGPL-3.0, which would conflict with publishing this under MIT.

## License

MIT. Use it, fork it, put it on your company's intranet, take it to your boss instead
of the $49/month invoice.
