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
  (n) => new RegExp(`^${n} receipts loaded`).test(document.getElementById('statusReceipts').textContent),
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

// ---- the FX view: typed rates produce a labelled estimate, nothing more --
await page.click('#btnPolicy');
await page.fill('#fx_newCode', 'EUR');
await page.fill('#fx_newRate', '1.08');
await page.click('#fx_newAdd');
await page.waitForSelector('#budgetFx:not([hidden])');
const fxText = await page.locator('#budgetFx').innerText();
assert.match(fxText, /1 EUR = 1\.08 USD/, 'the applied rate is printed');
assert.match(fxText, /at your stated rates/i);
assert.match(fxText, /nothing was converted there/i, 'the caveat is part of the view');
// The findings above the view must be untouched: still per-currency.
assert.ok((await page.locator('#budgetFindings').innerText()).includes('BUDGET_CURRENCY_UNMATCHED'),
  'typed rates must not absorb the cross-currency finding');
ok('FX view renders at stated rates, findings stay conversion-free');
// Clearing the rate removes the view.
await page.fill('#fx_EUR', '');
await page.locator('#policyGrid').click();   // blur fires the change
await page.waitForSelector('#budgetFx[hidden]', { state: 'attached' });
await page.click('#btnPolicy');
ok('clearing the rate removes the converted view');

// ---- column mapping: a corrected guess drives the audit ------------------
const colmap = await page.evaluate(() => ({
  visible: !document.getElementById('colMap').hidden,
  vendor: document.getElementById('cm_vendor')?.value,
}));
assert.equal(colmap.visible, true, 'the columns disclosure should render for a loaded sheet');
assert.equal(colmap.vendor, '3', 'Vendor should be auto-bound to column D');
await page.click('#colMap summary');          // open the disclosure
await page.selectOption('#cm_vendor', '4');   // point Vendor at the Category column
await page.evaluate(() => { document.getElementById('progText').textContent = 'rerunning'; });
await page.click('#btnRun');
await page.waitForFunction(() => /^Done\./.test(document.getElementById('progText').textContent),
  null, { timeout: 60000 });
const remappedVendor = await page.evaluate(() =>
  document.querySelector('#resultBody tr[data-txn="B-1"] td:nth-child(3)').textContent.trim());
assert.equal(remappedVendor, 'Meals', 'the audit must read Vendor from the corrected column');
ok('column mapping override feeds the audit: Vendor cell shows the remapped column');

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

// ---- policy file: save, reset, load restores; a bad file is refused ------
await page.click('#btnPolicy');
await page.fill('#p_receiptRequiredAtOrAbove', '25');
await page.locator('#p_receiptRequiredAtOrAbove').blur();
const polDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-policy-'));
const [polDownload] = await Promise.all([
  page.waitForEvent('download', { timeout: 30000 }),
  page.click('#btnPolicySave'),
]);
const polFile = path.join(polDir, 'policy.json');
await polDownload.saveAs(polFile);
await page.click('#btnPolicyReset');
assert.equal(await page.inputValue('#p_receiptRequiredAtOrAbove'), '75');
await page.setInputFiles('#filePolicy', polFile);
await page.waitForFunction(() => document.getElementById('p_receiptRequiredAtOrAbove').value === '25');
ok('policy file round-trips: save at 25, reset to 75, load restores 25');

const badPolicy = path.join(polDir, 'bad-policy.json');
fs.writeFileSync(badPolicy, JSON.stringify({ receiptRequiredAtOrAbove: 'high' }));
await page.setInputFiles('#filePolicy', badPolicy);
await page.waitForSelector('#banner');
assert.match(await page.locator('#banner').innerText(), /receiptRequiredAtOrAbove/);
assert.equal(await page.inputValue('#p_receiptRequiredAtOrAbove'), '25',
  'a refused policy file must not change the live policy');
ok('a policy file with a string where a number belongs is refused by name');
await page.click('#btnPolicyReset');
await page.click('#btnPolicy');
fs.rmSync(polDir, { recursive: true, force: true });

// ---- the full monthly workflow: photos, statement, decisions -------------
// A fresh page state: sample sheet via the file input, receipts from a folder
// that carries one PNG photo and one non-receipt file, plus a statement CSV
// with one charge that was never expensed.
await page.goto(BASE, { waitUntil: 'networkidle' });

const wfDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-workflow-'));
const wfReceipts = path.join(wfDir, 'receipts');
fs.mkdirSync(wfReceipts);
for (const name of fs.readdirSync(receiptDir)) {
  if (name === 'TX-1000.pdf') continue;   // this row's receipt becomes a photo
  fs.copyFileSync(path.join(receiptDir, name), path.join(wfReceipts, name));
}
{
  // Paint the photo with the row's real receipt values, so the audit result
  // for TX-1000 stays what the answer key expects.
  const t1000 = TRUTH.transactions.find((t) => t.txn_id === 'TX-1000');
  const b64 = await page.evaluate(({ vendor, total, date }) => {
    const c = document.createElement('canvas');
    c.width = 900; c.height = 620;
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#000'; g.font = 'bold 40px Arial';
    g.fillText(vendor, 60, 100);
    g.font = '34px Arial';
    g.fillText(date, 60, 200);
    g.fillText(`TOTAL $${total.toFixed(2)}`, 60, 300);
    return c.toDataURL('image/png').split(',')[1];
  }, { vendor: t1000.receipt_vendor, total: t1000.receipt_total, date: t1000.receipt_date });
  fs.writeFileSync(path.join(wfReceipts, 'TX-1000.png'), Buffer.from(b64, 'base64'));
}
fs.writeFileSync(path.join(wfReceipts, 'notes.docx'), 'not a receipt');

// Statement: the first five charges (posted a day late, debit-negative), one
// payment line, one charge that never became an expense row.
const plusDays = (iso, n) =>
  new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const stmtLines = ['Posting Date,Description,Amount'];
for (const t of TRUTH.transactions.slice(0, 5)) {
  stmtLines.push(`${plusDays(t.sheet_date, 1)},"${t.sheet_vendor.toUpperCase()}",-${t.sheet_amount}`);
}
stmtLines.push('2026-07-20,"PAYMENT THANK YOU",500.00');
stmtLines.push('2026-07-11,"VISTAPRINT BANNER SHOP",-999.99');
const stmtCsv = path.join(wfDir, 'statement.csv');
fs.writeFileSync(stmtCsv, stmtLines.join('\n'));

const wfSheet = path.join(wfDir, 'expense-report.xlsx');
fs.copyFileSync('sample-data/expense-report.xlsx', wfSheet);

await page.setInputFiles('#fileSheet', wfSheet);
await page.waitForFunction(() => !document.getElementById('btnRun').disabled);
await page.setInputFiles('#fileReceipts', wfReceipts);
await page.setInputFiles('#fileStatement', stmtCsv);
await page.waitForFunction(() =>
  /charge/.test(document.getElementById('statusStatement').textContent));
assert.match(await page.locator('#statusReceipts').innerText(), /ignored: notes\.docx/,
  'non-receipt files must be reported ignored BY NAME');
ok('a non-receipt file in the folder is reported ignored by name');

await page.click('#btnRun');
await page.waitForFunction(() => /^Done\./.test(document.getElementById('progText').textContent),
  null, { timeout: 180000 });

// The photo row reads via OCR and matches its planted receipt values.
const photoRow = await page.evaluate(() => {
  const tr = document.querySelector('#resultBody tr[data-txn="TX-1000"]');
  return { readBy: tr.children[6].textContent.trim(), status: tr.querySelector('.pill').textContent.trim() };
});
assert.match(photoRow.readBy, /^OCR/, `TX-1000 should read via OCR, got ${photoRow.readBy}`);
ok(`a PNG receipt photo resolves and reads via the OCR tier (${photoRow.readBy})`);

// The statement card: exactly the planted unclaimed charge, nothing else.
const stmtUi = await page.evaluate(() => ({
  visible: !document.getElementById('stmtCard').hidden,
  unclaimed: [...document.querySelectorAll('#stmtBody tr')].map((tr) => tr.textContent),
  softCount: document.getElementById('resultBody').textContent.split('CLAIMED_NOT_ON_STATEMENT').length - 1,
}));
assert.equal(stmtUi.visible, true);
assert.equal(stmtUi.unclaimed.length, 1, 'exactly one statement charge was never expensed');
assert.match(stmtUi.unclaimed[0], /VISTAPRINT/);
assert.equal(stmtUi.softCount, TRUTH.transactions.length - 5,
  'every expense row without a statement charge behind it is flagged soft');
ok('statement reconciliation: 5 matched, the never-expensed charge surfaced as UNCLAIMED_CHARGE');

// A reviewer decision, made in the drawer, lands in the workbook — and the
// run hash printed in the Summary is byte-identical before and after, because
// a human's verdict is not an input to what was audited.
const readWorkbookHash = async () => {
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    page.click('#btnDownload'),
  ]);
  const f = path.join(wfDir, `wb-${Date.now()}.xlsx`);
  await dl.saveAs(f);
  return await page.evaluate((b64) => {
    const wb = XLSX.read(b64, { type: 'base64' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets['Summary'], { header: 1 });
    return {
      tabs: wb.SheetNames,
      hash: rows.find((r) => r[0] === 'Run hash (SHA-256)')?.[1],
      byEmployee: rows.some((r) => r[0] === 'By employee'),
      exceptions: XLSX.utils.sheet_to_json(wb.Sheets['Exceptions'], { header: 1 }),
    };
  }, fs.readFileSync(f).toString('base64'));
};

const before = await readWorkbookHash();
assert.ok(before.tabs.includes('Statement Recon'), `workbook tabs: ${before.tabs.join(', ')}`);
assert.ok(before.byEmployee, 'Summary should carry the By employee block');
ok('workbook carries the Statement Recon tab and the per-employee breakdown');

await page.fill('#reviewerName', 'Browser Check');
await page.click('.chip[data-filter="exception"]');   // a clean row has nothing to decide
await page.click('#resultBody tr[data-txn] .rowbtn');
await page.waitForSelector('#panel:not([hidden])');
await page.locator('.decide-btn[data-decision="approved"]').first().click();
const decidedCode = await page.locator('#panelFindings .code').first().innerText();
await page.locator('.decide-note').first().fill('checked in browser test');
await page.locator('.decide-note').first().blur();
await page.keyboard.press('Escape');

const after = await readWorkbookHash();
assert.equal(after.hash, before.hash, 'a reviewer decision must never move the run hash');
const decidedRow = after.exceptions.find((r) => r[2] === decidedCode && r[10] === 'Approved');
assert.ok(decidedRow, `Exceptions tab should carry the Approved decision for ${decidedCode}`);
assert.equal(decidedRow[11], 'Browser Check');
assert.equal(decidedRow[13], 'checked in browser test');
ok(`reviewer decision on ${decidedCode} filled the sign-off columns; run hash unmoved`);
fs.rmSync(wfDir, { recursive: true, force: true });

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
