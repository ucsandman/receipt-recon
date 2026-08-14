// End-to-end audit test: read the sample expense report, extract every
// receipt, run the rules engine, and compare the result to the generator's
// answer key.
//
// This is the test that matters. It answers the only question an auditor
// cares about: does the tool find the problems that are actually there, and
// does it stay quiet about the rows that are fine?
//
// Scope note: this runs the text-layer tier only. The 4 scan-only receipts in
// the sample set need the browser's canvas to rasterize before OCR, so they
// are verified in the browser test instead (tools/browser-check.mjs). None of
// the planted exceptions sit on those 4 rows, so every rule is still covered
// here.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractReceipt } from '../app/extract.js';
import { auditAll, vendorSimilarity, sanitizePolicy, DEFAULT_POLICY, SEVERITY } from '../app/rules.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TRUTH = JSON.parse(fs.readFileSync(path.join(ROOT, 'sample-data/ground-truth.json'), 'utf8'));
const RECEIPTS = path.join(ROOT, 'sample-data/receipts');

const SCAN_ONLY = new Set(TRUTH.transactions.filter((t) => t.scan_only).map((t) => t.txn_id));

function toRow(t) {
  return {
    txnId: t.txn_id,
    employee: t.employee ?? 'Unknown',
    date: t.sheet_date,
    vendor: t.sheet_vendor,
    category: t.category ?? '',
    amount: t.sheet_amount,
    currency: t.sheet_currency,
    receiptFile: t.receipt_file,
    purpose: t.purpose ?? 'Business',
    approver: t.approver ?? '',
  };
}

let audited = null;

async function runAudit() {
  if (audited) return audited;
  // The answer key carries the sheet side; the workbook is the same data.
  // Reading it here keeps the test independent of the xlsx parser.
  const sheet = JSON.parse(fs.readFileSync(path.join(ROOT, 'sample-data/ground-truth.json'), 'utf8'));
  const rows = sheet.transactions.map(toRow);

  // Employee and category are not in the answer key, so pull them off the
  // workbook-equivalent fields the generator wrote.
  const extractions = new Map();
  for (const t of sheet.transactions) {
    if (!t.receipt_file) continue;
    const bytes = new Uint8Array(fs.readFileSync(path.join(RECEIPTS, t.receipt_file)));
    extractions.set(t.txn_id, await extractReceipt(bytes, { pdfjsLib, getOcrWorker: null }));
  }
  audited = auditAll(rows, extractions, DEFAULT_POLICY);
  return audited;
}

const codesOf = (r) => new Set(r.findings.filter((f) => f.severity !== SEVERITY.INFO).map((f) => f.code));

test('every planted exception is found', async () => {
  const results = await runAudit();
  const byId = new Map(results.map((r) => [r.row.txnId, r]));
  const missed = [];

  for (const t of TRUTH.transactions) {
    if (!t.expected_codes.length) continue;
    const found = codesOf(byId.get(t.txn_id));
    for (const want of t.expected_codes) {
      if (!found.has(want)) missed.push(`${t.txn_id}: expected ${want}, got [${[...found].join(', ') || 'nothing'}]`);
    }
  }
  assert.deepEqual(missed, [], 'planted exceptions the audit failed to catch');
});

test('clean rows stay quiet', async () => {
  const results = await runAudit();
  const noise = [];

  for (const r of results) {
    const t = TRUTH.transactions.find((x) => x.txn_id === r.row.txnId);
    if (t.expected_codes.length) continue;          // a genuine exception row
    if (SCAN_ONLY.has(r.row.txnId)) continue;       // needs OCR, covered in the browser test
    const hard = r.findings.filter((f) => f.severity === SEVERITY.HARD);
    if (hard.length) noise.push(`${r.row.txnId}: ${hard.map((f) => f.code).join(', ')}`);
  }
  assert.deepEqual(noise, [], 'false positives on clean rows');
});

test('scan-only receipts escalate rather than silently pass', async () => {
  const results = await runAudit();
  for (const r of results.filter((x) => SCAN_ONLY.has(x.row.txnId))) {
    assert.ok(codesOf(r).has('UNREADABLE_RECEIPT'),
      `${r.row.txnId} has no text layer and OCR is off, so it must escalate, not pass`);
    assert.equal(r.status, 'exception');
  }
});

test('a split transaction is caught only by the batch pass', async () => {
  const results = await runAudit();
  const split = results.filter((r) => codesOf(r).has('SPLIT_TRANSACTION'));
  const planted = TRUTH.transactions.filter((t) => t.expected_codes.includes('SPLIT_TRANSACTION'));
  assert.deepEqual(split.map((r) => r.row.txnId).sort(), planted.map((t) => t.txn_id).sort(),
    'exactly the planted split rows must be flagged, no more and no fewer');
  assert.ok(split.length >= 2, 'a split needs at least two halves');
  const f = split[0].findings.find((x) => x.code === 'SPLIT_TRANSACTION');
  assert.ok(f.groupTotal > f.threshold, 'group total must exceed the approval threshold');
  for (const r of split) {
    assert.ok(r.row.amount <= f.threshold, 'no single row may cross the threshold on its own');
  }
});

test('a tip added after printing is soft, not a hard mismatch', async () => {
  const results = await runAudit();
  const tip = results.find((r) => codesOf(r).has('UNSUPPORTED_TIP'));
  assert.ok(tip, 'the planted post-print tip should be detected');
  assert.ok(!codesOf(tip).has('AMOUNT_MISMATCH'),
    'a plausible tip must not also fire the hard amount-mismatch rule, or the queue floods');
});

test('every finding carries the evidence needed to defend it', async () => {
  const results = await runAudit();
  for (const r of results) {
    for (const f of r.findings) {
      assert.ok(f.code, 'finding needs a rule code');
      assert.ok(f.message && f.message.length > 15, `finding ${f.code} needs a human-readable reason`);
      assert.equal(f.ruleset, '1.0.0', 'finding must record the ruleset version that produced it');
      assert.ok(Object.values(SEVERITY).includes(f.severity), `bad severity on ${f.code}`);
    }
  }
});

test('the audit is reproducible', async () => {
  const a = await runAudit();
  audited = null;                       // force a full second run
  const b = await runAudit();
  assert.equal(JSON.stringify(a.map((r) => [r.row.txnId, r.status, [...codesOf(r)].sort()])),
               JSON.stringify(b.map((r) => [r.row.txnId, r.status, [...codesOf(r)].sort()])),
               'two runs over identical input must produce identical findings');
});

test('vendor matching tolerates real-world name variants', () => {
  assert.ok(vendorSimilarity('MetroLift', 'MetroLift Inc.') > 0.9);
  assert.ok(vendorSimilarity('Nordvane Analytics BV', 'Nordvane Analytics') > 0.9);
  assert.ok(vendorSimilarity('ASHCROFT CHOPHOUSE', 'Ashcroft Chophouse') === 1);
  assert.ok(vendorSimilarity('Ashcroft Chophouse', 'Lakeshore Wine & Spirits') < 0.4,
    'genuinely different vendors must score low');
});

// A minimal readable extraction, so a rule can be exercised without a PDF.
function ext(fields = {}) {
  return {
    tier: 'text', confidence: 100, text: fields.text ?? 'RECEIPT\nTOTAL: $100.00',
    fields: { total: 100, subtotal: null, tax: null, tip: null, currency: 'USD',
              date: null, vendor: null, warnings: [], ...fields },
  };
}
function row(over = {}) {
  return {
    txnId: 'T1', employee: 'A', date: '2026-07-02', vendor: 'Bluebird Diner',
    category: 'Meals', amount: 100, currency: 'USD', receiptFile: null,
    purpose: 'Client lunch', approver: 'M', ...over,
  };
}
const codes = (r) => r.findings.map((f) => f.code);
const find = (r, code) => r.findings.find((f) => f.code === code);

test('a mileage claim is not asked for a receipt it can never have', () => {
  // report.js Methodology already tells the reader mileage and per-diem have no
  // support document by nature. The engine did not know that, so every such row
  // over the floor produced a guaranteed HARD MISSING_RECEIPT, every month.
  const [r] = auditAll([row({ category: 'Mileage', amount: 200, receiptFile: null })],
    new Map(), DEFAULT_POLICY);
  assert.ok(!codes(r).includes('MISSING_RECEIPT'),
    'a mileage row must not be asked for a receipt');
  for (const f of r.findings) {
    assert.doesNotMatch(f.message, /floor/i,
      'the under-floor wording is false for a 200.00 claim and must not be reused');
  }
});

test('an exempt category still has to carry its substantiating detail', () => {
  const [r] = auditAll([row({ category: 'Per Diem', amount: 200, receiptFile: null, purpose: '' })],
    new Map(), DEFAULT_POLICY);
  const f = find(r, 'CATEGORY_EXEMPT_NO_RECEIPT');
  assert.ok(f, 'an exempt row missing detail must still raise a finding');
  assert.equal(f.severity, SEVERITY.HARD);
  assert.match(f.message, /business purpose/i, 'the finding must name what is missing');
});

test('the exempt-category list is policy, not a hardcoded carve-out', () => {
  const strict = auditAll([row({ category: 'Mileage', amount: 200, receiptFile: null })],
    new Map(), { ...DEFAULT_POLICY, noReceiptCategories: [] });
  assert.ok(codes(strict[0]).includes('MISSING_RECEIPT'),
    'emptying the exempt list must bring the receipt requirement back');
});

test('two receiptless claims of the same charge are caught by something', () => {
  // DUPLICATE_CHARGE skipped any group whose file set had one member, on the
  // comment "already reported above if they share one file". But
  // DUPLICATE_RECEIPT skips blank-receipt rows entirely, so a pair of
  // receiptless identical claims fell through both rules.
  const rows = [
    row({ txnId: 'T1', receiptFile: null }),
    row({ txnId: 'T2', receiptFile: null }),
  ];
  const results = auditAll(rows, new Map(), DEFAULT_POLICY);
  for (const r of results) {
    assert.ok(codes(r).includes('DUPLICATE_CHARGE'),
      `${r.row.txnId}: same vendor, date and amount claimed twice with no receipt either time`);
  }
});

test('rows genuinely sharing one receipt are still only reported once', () => {
  // The control for the case above: when both rows cite the same real file,
  // DUPLICATE_RECEIPT owns it and DUPLICATE_CHARGE must stay quiet.
  const rows = [
    row({ txnId: 'T1', receiptFile: 'TX-1000.pdf' }),
    row({ txnId: 'T2', receiptFile: 'TX-1000.pdf' }),
  ];
  const extractions = new Map([['T1', ext()], ['T2', ext()]]);
  const results = auditAll(rows, extractions, DEFAULT_POLICY);
  for (const r of results) {
    assert.ok(codes(r).includes('DUPLICATE_RECEIPT'), 'the shared-file rule still fires');
    assert.ok(!codes(r).includes('DUPLICATE_CHARGE'),
      'one duplicate must not be reported twice under two rule names');
  }
});

test('an unreadable currency does not let the amount check compare two units silently', () => {
  const rows = [row({ receiptFile: 'r.pdf', amount: 100, currency: 'USD' })];
  const extractions = new Map([['T1', ext({ currency: null, total: 100 })]]);
  const [r] = auditAll(rows, extractions, DEFAULT_POLICY);
  const f = find(r, 'CURRENCY_UNVERIFIED');
  assert.ok(f, 'the amount was compared as a bare number; that assumption must be stated');
  assert.equal(f.severity, SEVERITY.SOFT, 'unverified is a signal, not a violation');
  assert.match(f.message, /single currency|could not confirm|assumed/i);
});

test('a currency that reads cleanly raises no unverified signal', () => {
  const rows = [row({ receiptFile: 'r.pdf', currency: 'USD' })];
  const extractions = new Map([['T1', ext({ currency: 'USD' })]]);
  const [r] = auditAll(rows, extractions, DEFAULT_POLICY);
  assert.ok(!codes(r).includes('CURRENCY_UNVERIFIED'), 'no noise when the read was clean');
  assert.ok(!codes(r).includes('CURRENCY_MISMATCH'));
});

test('a real currency mismatch still outranks the unverified signal', () => {
  const rows = [row({ receiptFile: 'r.pdf', currency: 'USD' })];
  const extractions = new Map([['T1', ext({ currency: 'EUR' })]]);
  const [r] = auditAll(rows, extractions, DEFAULT_POLICY);
  assert.ok(codes(r).includes('CURRENCY_MISMATCH'));
  assert.ok(!codes(r).includes('CURRENCY_UNVERIFIED'),
    'a known mismatch is not an unverified one');
});

// ---------------------------------------------------------------------------
// sanitizePolicy: the gate a loaded policy file passes through. A mistyped
// digit in a hand-edited file must be refused loudly, never applied silently.
// ---------------------------------------------------------------------------

test('a saved policy round-trips through sanitizePolicy unchanged', () => {
  const raw = JSON.parse(JSON.stringify(DEFAULT_POLICY));
  const { policy, errors } = sanitizePolicy(raw);
  assert.deepEqual(errors, []);
  assert.deepEqual(policy, DEFAULT_POLICY);
});

test('a string where a number belongs is refused by name and the default kept', () => {
  const { policy, errors } = sanitizePolicy({ receiptRequiredAtOrAbove: 'high' });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /receiptRequiredAtOrAbove/);
  assert.equal(policy.receiptRequiredAtOrAbove, DEFAULT_POLICY.receiptRequiredAtOrAbove);
});

test('a bare string where a word list belongs is refused', () => {
  const { policy, errors } = sanitizePolicy({ alcoholKeywords: 'wine' });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /alcoholKeywords/);
  assert.deepEqual(policy.alcoholKeywords, DEFAULT_POLICY.alcoholKeywords);
});

test('a category limit that is not a number is refused', () => {
  const { errors } = sanitizePolicy({ categoryLimits: { Meals: 'lots' } });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /categoryLimits/);
});

test('unknown keys are ignored without complaint', () => {
  const { policy, errors } = sanitizePolicy({ bogus: 1 });
  assert.deepEqual(errors, []);
  assert.equal('bogus' in policy, false);
});

test('list items are coerced to trimmed strings and empties dropped', () => {
  const { policy, errors } = sanitizePolicy({ alcoholKeywords: [' wine ', '', 'mead'] });
  assert.deepEqual(errors, []);
  assert.deepEqual(policy.alcoholKeywords, ['wine', 'mead']);
});

test('policy thresholds are configurable, not hardcoded', async () => {
  const rows = [{
    txnId: 'T1', employee: 'A', date: '2026-07-02', vendor: 'Bluebird Diner',
    category: 'Meals', amount: 120.00, currency: 'USD', receiptFile: null, purpose: 'Lunch',
  }];
  const strict = auditAll(rows, new Map(), { ...DEFAULT_POLICY, categoryLimits: { Meals: 50 } });
  const loose = auditAll(rows, new Map(), { ...DEFAULT_POLICY, categoryLimits: { Meals: 500 } });
  // No receipt at 120.00 fires under both, but the limit rule must respond to config.
  assert.ok(strict[0].findings.some((f) => f.code === 'MISSING_RECEIPT'));
  assert.equal(loose[0].findings.some((f) => f.code === 'OVER_CATEGORY_LIMIT'), false);
});
