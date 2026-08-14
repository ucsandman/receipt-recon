// Browser check: drive the real page in a real browser and assert the audit
// it produces, including the OCR tier that the Node tests cannot reach.
//
//   npm run serve          (in one terminal)
//   node tools/browser-check.mjs
//
// This is the proof that the tool works, as opposed to the proof that its
// functions work. It fails loudly on any console error or any external
// network request.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:8080';
const SHOTS = process.env.SHOTS || 'docs/screenshots';
const TRUTH = JSON.parse(fs.readFileSync('sample-data/ground-truth.json', 'utf8'));

const expectedExceptions = new Set(
  TRUTH.transactions.filter((t) => t.expected_codes.length).map((t) => t.txn_id));

function ok(label) { console.log(`  PASS  ${label}`); }

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

const consoleErrors = [];
const externalRequests = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
page.on('request', (r) => {
  if (!r.url().startsWith(BASE) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) {
    externalRequests.push(r.url());
  }
});

fs.mkdirSync(SHOTS, { recursive: true });

console.log('\nBrowser check');
console.log('-------------');

await page.goto(BASE, { waitUntil: 'networkidle' });
assert.match(await page.title(), /Receipt Recon/);
ok('page loads');
await page.screenshot({ path: path.join(SHOTS, '01-landing.png'), fullPage: false });

// ---- run the sample audit ------------------------------------------------
await page.click('#btnSample');
await page.waitForSelector('#step-results:not([hidden])', { timeout: 180000 });
await page.waitForFunction(() => document.querySelectorAll('#resultBody tr[data-txn]').length > 0,
  null, { timeout: 180000 });
ok('sample audit completes end to end');

const summary = await page.evaluate(() => {
  const n = (sel) => [...document.querySelectorAll(sel)];
  return {
    rows: n('#resultBody tr[data-txn]').length,
    tiles: n('.tile').map((t) => `${t.querySelector('.n').textContent} ${t.querySelector('.k').textContent}`),
    statuses: n('#resultBody tr[data-txn]').map((tr) => ({
      txn: tr.dataset.txn,
      status: tr.querySelector('.pill').textContent.trim(),
      readBy: tr.children[6].textContent.trim(),
    })),
  };
});

assert.equal(summary.rows, TRUTH.transactions.length,
  `expected ${TRUTH.transactions.length} rows, rendered ${summary.rows}`);
ok(`all ${summary.rows} transactions rendered`);

// ---- the OCR tier, which only exists in a browser -------------------------
const ocrRows = summary.statuses.filter((s) => /^OCR/.test(s.readBy));
const scanOnly = TRUTH.transactions.filter((t) => t.scan_only).map((t) => t.txn_id).sort();
assert.deepEqual(ocrRows.map((r) => r.txn).sort(), scanOnly,
  `OCR should have run on exactly ${scanOnly.join(', ')}`);
ok(`OCR tier ran on the ${ocrRows.length} image-only receipts: ${ocrRows.map((r) => r.readBy).join(', ')}`);

// Those rows have no planted defect, so with OCR working they must come out
// clean. This is the assertion the Node suite explicitly could not make.
const dirtyScans = ocrRows.filter((r) => r.status !== 'Clean');
assert.deepEqual(dirtyScans, [], 'scan-only receipts should read clean once OCR runs');
ok('image-only receipts resolve clean via OCR, no false exceptions');

// ---- every planted exception is surfaced in the UI ------------------------
const flagged = new Set(summary.statuses.filter((s) => s.status !== 'Clean').map((s) => s.txn));
const missed = [...expectedExceptions].filter((t) => !flagged.has(t));
assert.deepEqual(missed, [], 'planted exceptions missing from the rendered table');
ok(`all ${expectedExceptions.size} planted exception rows surfaced`);

// Hard findings are the strict contract: a row must not be raised to
// "Exception" unless a defect was planted there. Soft signals are a separate,
// deliberately noisier tier (weekend spend, a receipt with no total label) and
// are expected to appear on otherwise-clean rows. Conflating the two is what
// makes an audit tool either miss things or cry wolf, so they are asserted
// separately.
const hardRows = summary.statuses.filter((s) => s.status === 'Exception').map((s) => s.txn);
const unexpectedHard = hardRows.filter((t) => !expectedExceptions.has(t));
assert.deepEqual(unexpectedHard, [], 'rows raised to Exception without a planted defect');
ok(`no false exceptions: ${hardRows.length} hard rows, all planted`);

const softOnly = summary.statuses.filter((s) => s.status === 'Review' && !expectedExceptions.has(s.txn));
ok(`${softOnly.length} soft-signal row(s) on clean data, as designed: ${softOnly.map((s) => s.txn).join(', ') || 'none'}`);

await page.screenshot({ path: path.join(SHOTS, '02-results.png'), fullPage: false });

// ---- evidence panel ------------------------------------------------------
// Pick an exception that actually has a support document. The first planted
// exception is a MISSING_RECEIPT row, which correctly renders no PDF at all.
const firstException = TRUTH.transactions
  .find((t) => t.expected_codes.length && t.receipt_file).txn_id;
await page.click(`#resultBody tr[data-txn="${firstException}"]`);
await page.waitForSelector('#panel:not([hidden])');
await page.waitForSelector('#panelPdf canvas', { timeout: 30000 });
const panel = await page.evaluate(() => ({
  findings: document.querySelectorAll('#panelFindings .finding').length,
  differs: document.querySelectorAll('#panelCompare tr.differs').length,
  hasCanvas: !!document.querySelector('#panelPdf canvas'),
  raw: document.getElementById('panelRaw').textContent.length,
}));
assert.ok(panel.findings > 0, 'panel should list findings');
assert.ok(panel.hasCanvas, 'panel should render the receipt itself');
assert.ok(panel.raw > 40, 'panel should show the text read from the receipt');
ok(`evidence panel renders the receipt, ${panel.findings} finding(s), ${panel.differs} differing field(s)`);
await page.screenshot({ path: path.join(SHOTS, '03-evidence.png'), fullPage: false });

// ---- filters -------------------------------------------------------------
await page.click('#panelClose');
await page.click('.chip[data-filter="exception"]');
const exceptionOnly = await page.evaluate(() =>
  [...document.querySelectorAll('#resultBody tr[data-txn] .pill')].every((p) => p.textContent.trim() === 'Exception'));
assert.ok(exceptionOnly, 'exception filter should show only exceptions');
ok('filters work');
await page.click('.chip[data-filter="all"]');

// ---- the workbook download ----------------------------------------------
const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 60000 }),
  page.click('#btnDownload'),
]);
const out = path.join(SHOTS, '..', 'sample-audit.xlsx');
await download.saveAs(out);
const size = fs.statSync(out).size;
assert.ok(size > 8000, `workbook looks too small (${size} bytes)`);
ok(`audit workbook downloads (${(size / 1024).toFixed(1)} KB) -> ${out}`);

// ---- one corrupt file must cost one row, not the whole run ---------------
// runAudit used to wrap all 350 rows in a single try whose catch never assigned
// state.results, so one bad PDF discarded every row already processed, with no
// partial output and no way to tell which file did it.
const corruptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-corrupt-'));
const receiptDir = 'sample-data/receipts';
for (const name of fs.readdirSync(receiptDir)) {
  fs.copyFileSync(path.join(receiptDir, name), path.join(corruptDir, name));
}
const victim = 'TX-1000.pdf';
fs.writeFileSync(path.join(corruptDir, victim), Buffer.from('%PDF-1.4\nthis is not a pdf\n'));

await page.setInputFiles('#fileReceipts', corruptDir);
await page.waitForFunction(
  (n) => new RegExp(`^${n} PDFs loaded`).test(document.getElementById('statusReceipts').textContent),
  fs.readdirSync(corruptDir).length);
// The previous run already left "Done." in the progress text, so waiting for it
// would return before this run had even started. Stamp a sentinel first.
await page.evaluate(() => { document.getElementById('progText').textContent = 'rerunning'; });
await page.click('#btnRun');
await page.waitForFunction(() => /^Done\./.test(document.getElementById('progText').textContent),
  null, { timeout: 180000 });

const afterCorrupt = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#resultBody tr[data-txn]')];
  return {
    rows: rows.length,
    unreadable: rows.filter((tr) => tr.textContent.includes('UNREADABLE_RECEIPT'))
      .map((tr) => tr.dataset.txn),
  };
});
assert.equal(afterCorrupt.rows, TRUTH.transactions.length,
  `one corrupt PDF must not cost the run: expected ${TRUTH.transactions.length} rows, got ${afterCorrupt.rows}`);
assert.deepEqual(afterCorrupt.unreadable, ['TX-1000'],
  `exactly the corrupt row should be unreadable, got [${afterCorrupt.unreadable.join(', ')}]`);
ok(`one corrupt PDF costs exactly one row: ${afterCorrupt.rows} rows rendered, ${afterCorrupt.unreadable[0]} flagged`);
fs.rmSync(corruptDir, { recursive: true, force: true });

// ---- multi-sheet workbook with a multi-currency budget cover sheet -------
// The shape a real user described: a cover sheet with a budget breakdown in
// several currencies that the expense report has to reconcile against. The
// fixture is built here with the same SheetJS build the page ships.
// Built inside the page with the exact SheetJS build the page ships, then
// round-tripped through a real file and the real file input.
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-budget-'));
const fixture = path.join(fixtureDir, 'report-with-cover.xlsx');
{
  const b64 = await page.evaluate(() => {
    const wb = XLSX.utils.book_new();
    const cover = XLSX.utils.aoa_to_sheet([
      ['Acme GmbH'],
      ['Monthly expense budget'],
      [],
      ['Category', 'Currency', 'Budget'],
      ['Meals', 'EUR', 500],
      ['Travel', 'USD', 2000],
      ['Lodging', 'GBP', 800],
      ['Software', 'USD', 100],
    ]);
    const expenses = XLSX.utils.aoa_to_sheet([
      ['Txn ID', 'Employee', 'Date', 'Vendor', 'Category', 'Amount', 'Currency', 'Business Purpose'],
      ['B-1', 'Ana', '2026-07-02', 'Bistro Uno', 'Meals', 300, 'EUR', 'client lunch'],
      ['B-2', 'Ana', '2026-07-09', 'Bistro Due', 'Meals', 250, 'EUR', 'client dinner'],
      ['B-3', 'Ana', '2026-07-10', 'RailCo', 'Travel', 500, 'USD', 'site visit'],
      ['B-4', 'Ana', '2026-07-11', 'Tokyo Inn', 'Lodging', 10000, 'JPY', 'conference'],
      ['B-5', 'Ana', '2026-07-12', 'City Cab', 'Taxis', 30, 'USD', 'airport'],
    ]);
    // Cover first, exactly the order that used to break the import.
    XLSX.utils.book_append_sheet(wb, cover, 'Cover');
    XLSX.utils.book_append_sheet(wb, expenses, 'Expenses');
    return XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
  });
  fs.writeFileSync(fixture, Buffer.from(b64, 'base64'));
}

await page.setInputFiles('#fileSheet', fixture);
await page.waitForFunction(() => /budget: 4 lines/.test(document.getElementById('statusSheet').textContent));
ok('cover sheet first: transactions found on "Expenses", budget read from "Cover"');

const choice = await page.evaluate(() => ({
  visible: !document.getElementById('sheetChoice').hidden,
  txn: document.getElementById('selTxnSheet').selectedOptions[0]?.textContent,
  budget: document.getElementById('selBudgetSheet').selectedOptions[0]?.textContent,
}));
assert.equal(choice.visible, true, 'sheet choice controls should appear for a multi-sheet workbook');
assert.equal(choice.txn, 'Expenses');
assert.equal(choice.budget, 'Cover');
ok('sheet pickers show the guess and allow overriding it');

await page.evaluate(() => { document.getElementById('progText').textContent = 'rerunning'; });
await page.click('#btnRun');
await page.waitForFunction(() => /^Done\./.test(document.getElementById('progText').textContent),
  null, { timeout: 60000 });
await page.waitForSelector('#budgetCard:not([hidden])');

const budgetUi = await page.evaluate(() => ({
  rows: [...document.querySelectorAll('#budgetBody tr')].map((tr) =>
    [...tr.children].map((td) => td.textContent.trim())),
  findings: [...document.querySelectorAll('#budgetFindings .code')].map((c) => c.textContent),
  flaggedTile: [...document.querySelectorAll('.tile')].at(-1).textContent,
}));
const mealsRow = budgetUi.rows.find((r) => r[0] === 'Meals');
assert.equal(mealsRow.at(-1), 'Over budget', 'Meals is 550 EUR against a 500 EUR budget');
assert.ok(mealsRow.some((c) => c.includes('€50')), `Meals over-budget delta should show €50, got: ${mealsRow.join(' | ')}`);
assert.ok(budgetUi.findings.includes('BUDGET_EXCEEDED'), 'BUDGET_EXCEEDED should be listed');
assert.ok(budgetUi.findings.includes('BUDGET_CURRENCY_UNMATCHED'),
  'JPY lodging spend against a GBP budget line must be flagged, never converted');
assert.ok(budgetUi.findings.includes('BUDGET_UNBUDGETED_SPEND'), 'Taxis has no budget line');
ok(`budget card renders: ${budgetUi.rows.length} lines, findings ${budgetUi.findings.join(', ')}`);

// The flagged-value tile must never add currencies together.
assert.ok(budgetUi.flaggedTile.includes('€') && budgetUi.flaggedTile.includes('¥'),
  `flagged tile should list currencies separately, got: ${budgetUi.flaggedTile}`);
ok('flagged-value tile reports each currency separately');

await page.locator('#budgetCard').scrollIntoViewIfNeeded();
await page.screenshot({ path: path.join(SHOTS, '04-budget.png'), fullPage: false });

// The workbook gains a Budget Recon tab, readable back with the same SheetJS.
const [budDownload] = await Promise.all([
  page.waitForEvent('download', { timeout: 60000 }),
  page.click('#btnDownload'),
]);
const budOut = path.join(fixtureDir, 'budget-audit.xlsx');
await budDownload.saveAs(budOut);
const budBack = await page.evaluate((b64) => {
  const wb = XLSX.read(b64, { type: 'base64' });
  const tab = wb.Sheets['Budget Recon'];
  return {
    tabs: wb.SheetNames,
    recon: tab ? XLSX.utils.sheet_to_json(tab, { header: 1 }) : [],
  };
}, fs.readFileSync(budOut).toString('base64'));
assert.ok(budBack.tabs.includes('Budget Recon'), `workbook tabs: ${budBack.tabs.join(', ')}`);
assert.ok(budBack.recon.some((r) => r[0] === 'Meals' && r[5] === 'OVER BUDGET'),
  'Budget Recon tab should carry the Meals overrun');
ok('audit workbook carries a Budget Recon tab with the overrun');
fs.rmSync(fixtureDir, { recursive: true, force: true });

// ---- the policy editor teaches an in-house policy ------------------------
await page.click('#btnPolicy');
const policyUi = await page.evaluate(() => ({
  lists: ['p_alcoholKeywords', 'p_personalKeywords', 'p_tipEligibleCategories']
    .map((id) => !!document.getElementById(id)),
  addRow: !!document.getElementById('pc_newAdd'),
}));
assert.deepEqual(policyUi.lists, [true, true, true], 'keyword and category lists should be editable');
assert.ok(policyUi.addRow, 'a new category limit can be added');
ok('policy editor exposes the keyword lists and category limits');
await page.click('#btnPolicy');

// ---- the privacy claim ---------------------------------------------------
assert.deepEqual(externalRequests, [],
  `page made external network requests: ${externalRequests.join(', ')}`);
ok('zero external network requests during the entire audit');

const badgeTripped = await page.evaluate(() => document.getElementById('netBadge').classList.contains('tripped'));
assert.equal(badgeTripped, false, 'network watchdog should not have tripped');
ok('network watchdog clean');

assert.deepEqual(consoleErrors, [], `console errors: ${consoleErrors.join(' | ')}`);
ok('no console errors');

await browser.close();
console.log(`\nAll browser checks passed. Screenshots in ${SHOTS}/\n`);
