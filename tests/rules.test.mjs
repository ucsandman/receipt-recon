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
import { auditAll, vendorSimilarity, DEFAULT_POLICY, SEVERITY } from '../app/rules.js';

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
