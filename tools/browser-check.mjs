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
