// Golden test for the extraction ladder.
//
// Asserts the parsed receipt total against the generator's answer key, not
// against a previous run's output. This is the guard for the "Subtotal
// contains Total" bug in docs/ERRORS.md.
//
//   node --test tests/

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractReceipt, clampScale, MAX_RASTER_PX, __test__ } from '../app/extract.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TRUTH = JSON.parse(fs.readFileSync(path.join(ROOT, 'sample-data/ground-truth.json'), 'utf8'));
const RECEIPTS = path.join(ROOT, 'sample-data/receipts');

const withReceipts = TRUTH.transactions.filter((t) => t.receipt_file && !t.scan_only);

test('tier 1 reads a total from every text-layer receipt', async () => {
  const misses = [];
  for (const t of withReceipts) {
    const bytes = new Uint8Array(fs.readFileSync(path.join(RECEIPTS, t.receipt_file)));
    const r = await extractReceipt(bytes, { pdfjsLib, getOcrWorker: null });
    assert.equal(r.tier, 'text', `${t.txn_id} should not need OCR`);
    if (r.fields.total === null) misses.push(t.txn_id);
  }
  assert.deepEqual(misses, [], 'receipts with no total recovered');
});

test('tier 1 total matches the answer key exactly', async () => {
  const wrong = [];
  for (const t of withReceipts) {
    const bytes = new Uint8Array(fs.readFileSync(path.join(RECEIPTS, t.receipt_file)));
    const r = await extractReceipt(bytes, { pdfjsLib, getOcrWorker: null });
    if (Math.abs(r.fields.total - t.receipt_total) > 0.005) {
      wrong.push(`${t.txn_id}: got ${r.fields.total}, want ${t.receipt_total}`);
    }
  }
  assert.deepEqual(wrong, [], 'totals that disagree with the answer key');
});

test('a subtotal is never mistaken for the total', () => {
  const receipt = [
    'BLUEBIRD DINER',
    'Ribeye 12oz $31.85',
    'Subtotal: $61.94',
    'Sales Tax: $5.42',
    'Tip: $12.39',
    'TOTAL: $79.75',
  ].join('\n');
  const f = __test__.parseFields(receipt);
  assert.equal(f.total, 79.75, 'must read TOTAL, not Subtotal');
  assert.equal(f.subtotal, 61.94);
  assert.equal(f.tax, 5.42);
  assert.equal(f.tip, 12.39);
  assert.deepEqual(f.warnings, [], 'a receipt that foots should raise no warning');
});

test('"TOTAL DUE" is not shadowed by the bare "TOTAL" alternate', () => {
  assert.equal(__test__.parseFields('TOTAL DUE: €180.29').total, 180.29);
  assert.equal(__test__.parseFields('BALANCE DUE: $512.00').total, 512.00);
  assert.equal(__test__.parseFields('TOTAL FARE: $318.10').total, 318.10);
});

test('a receipt that does not foot raises a warning', () => {
  const f = __test__.parseFields('Subtotal: $100.00\nSales Tax: $8.75\nTOTAL: $999.00');
  assert.equal(f.total, 999.00);
  assert.ok(f.warnings.some((w) => /does not foot/i.test(w)), 'expected a footing warning');
});

test('a receipt with no total label is flagged as a guess', () => {
  const f = __test__.parseFields('METROLIFT\n$42.10\nTrip fare $35.00\nBooking fee $2.75');
  assert.equal(f.totalBasis, 'largest-figure-guess');
  assert.ok(f.warnings.some((w) => /largest figure/i.test(w)));
});

test('date formats seen on real receipts all parse', () => {
  const cases = {
    'Date: 07/02/2026': '2026-07-02',
    'Invoice Date: 2026-07-24': '2026-07-24',
    'Issue Date: 02 JUL 2026': '2026-07-02',
    'July 2, 2026': '2026-07-02',
    'Date: 25/12/2026': '2026-12-25',   // day-first when field 1 cannot be a month
  };
  for (const [input, want] of Object.entries(cases)) {
    assert.equal(__test__.parseDate(input), want, `parsing ${input}`);
  }
});

test('currency is detected from symbol, code, and VAT context', () => {
  assert.equal(__test__.parseCurrency('TOTAL: $79.75'), 'USD');
  assert.equal(__test__.parseCurrency('TOTAL DUE: €180.29'), 'EUR');
  assert.equal(__test__.parseCurrency('Amount: 180.29 GBP'), 'GBP');
  assert.equal(__test__.parseCurrency('VAT ID: NL8234.11.892.B01\nTOTAL DUE: 180.29'), 'EUR');
});

test('vendor skips boilerplate, addresses, and phone numbers', () => {
  const v = __test__.parseVendor(
    'ASHCROFT CHOPHOUSE\n1847 Kestrel Avenue, Portland OR 97209\n(503) 555-0142\nDate: 07/02/2026');
  assert.equal(v, 'ASHCROFT CHOPHOUSE');
  assert.equal(__test__.parseVendor('INVOICE\nNordvane Analytics BV\nKeizersgracht 241'), 'Nordvane Analytics BV');
});

test('a receipt carrying a huge number of money figures does not blow the stack', () => {
  // parseTotal's no-label fallback used Math.max(...all). A spread that wide
  // overflows the argument stack, and because parseFields runs outside
  // extractReceipt's try, that RangeError escaped and killed the entire run,
  // not just this row. 150k is where V8 gives out; the reduce has no ceiling.
  const text = 'HOSTILE RECEIPT\n' + Array.from({ length: 150000 }, () => '$1.00').join(' ');
  let r;
  assert.doesNotThrow(() => { r = __test__.parseTotal(text); },
    'a pathological receipt must degrade to a finding, never take the process down');
  assert.equal(r.value, 1);
  assert.equal(r.basis, 'largest-figure-guess');
});

test('an absurd page box is clamped to a renderable canvas', () => {
  // A PDF may declare a page box up to 14400x14400 pt. At the fixed 3.0x scale
  // that is 43200x43200 px, about 7.5 GB of RGBA backing store. The bad outcome
  // is not the crash, it is a blank render that then reads as "no monetary
  // amount found", which looks like a real result.
  const huge = clampScale(14400, 14400, 3.0);
  assert.ok(huge < 3.0, 'a 14400pt page must not render at full scale');
  assert.ok(14400 * huge * 14400 * huge <= MAX_RASTER_PX,
    `clamped canvas is ${Math.round(14400 * huge * 14400 * huge)} px, over the ${MAX_RASTER_PX} cap`);

  // An ordinary receipt must be untouched, or the OCR tier silently gets worse.
  for (const [w, h, label] of [[612, 792, 'US Letter'], [595, 842, 'A4'], [288, 720, 'till roll']]) {
    assert.equal(clampScale(w, h, 3.0), 3.0, `${label} must still render at 3.0x`);
  }
  assert.equal(clampScale(0, 0, 3.0), 3.0, 'a degenerate viewport must not divide by zero');
});

test('currency codes cover the common set, not just twelve', () => {
  // CURRENCY_MISMATCH is gated on a parsed currency, so an unrecognised code
  // meant the amount check compared two different units in silence.
  const cases = {
    'Total SGD 42.00': 'SGD', 'TOTAL ZAR 610.00': 'ZAR', 'Total: BRL 89.90': 'BRL',
    'TOTAL KRW 18000': 'KRW', 'Amount PLN 240.00': 'PLN', 'Total NZD 55.20': 'NZD',
    'TOTAL HKD 480.00': 'HKD', 'Total CNY 320.00': 'CNY',
  };
  for (const [text, want] of Object.entries(cases)) {
    assert.equal(__test__.parseCurrency(text), want, `parseCurrency(${JSON.stringify(text)})`);
  }
  // The ones that already worked must not regress.
  assert.equal(__test__.parseCurrency('TOTAL: $79.75'), 'USD');
  assert.equal(__test__.parseCurrency('TOTAL DUE: €180.29'), 'EUR');
  // A bare word that happens to look like a code must not win.
  assert.equal(__test__.parseCurrency('ASHCROFT CHOPHOUSE\nTOTAL: $12.00'), 'USD');
});

test('scan-only receipts are correctly detected as needing OCR', async () => {
  const scans = TRUTH.transactions.filter((t) => t.scan_only && t.receipt_file);
  assert.ok(scans.length >= 4, 'sample set should contain scan-only receipts');
  for (const t of scans) {
    const bytes = new Uint8Array(fs.readFileSync(path.join(RECEIPTS, t.receipt_file)));
    const r = await extractReceipt(bytes, { pdfjsLib, getOcrWorker: null });
    assert.equal(r.tier, 'failed', `${t.txn_id} has no text layer, must escalate`);
    assert.match(r.error, /Image-only/, 'must say why it escalated');
  }
});
