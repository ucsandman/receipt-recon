// Workbook helpers.
//
// sumsByCurrency exists because the "Value flagged" tile and the Summary tab
// used to add euro, yen and dollar amounts into one number and print it as
// USD. For the multi-currency reports this tool now targets, that number was
// simply false.

import assert from 'node:assert/strict';
import test from 'node:test';

import { sumsByCurrency, employeeBreakdown, buildWorkbook, runHash } from '../app/report.js';

const res = (amount, currency, status = 'exception') => ({
  row: { amount, currency }, status,
});

test('sums are grouped per currency, never added across currencies', () => {
  const out = sumsByCurrency([res(100, 'USD'), res(50, 'USD'), res(200, 'EUR')]);
  assert.deepEqual(out, [['EUR', 200], ['USD', 150]]);
});

test('a filter narrows which rows are summed', () => {
  const out = sumsByCurrency(
    [res(100, 'USD', 'clean'), res(40, 'USD', 'exception')],
    (r) => r.status !== 'clean');
  assert.deepEqual(out, [['USD', 40]]);
});

test('rows with no amount are skipped and a missing currency defaults to USD', () => {
  const out = sumsByCurrency([res(null, 'USD'), res(10, undefined)]);
  assert.deepEqual(out, [['USD', 10]]);
});

// --------------------------------------------------------------------------
// Per-employee breakdown. An auditor thinks per person; the Summary tab now
// says who to call first. The dollar column inherits sumsByCurrency, so a
// mixed-currency employee shows per-currency figures, never a false sum.
// --------------------------------------------------------------------------

const empRes = (employee, amount, currency, status) => ({
  row: { employee, amount, currency }, status,
});

test('employees are ranked by flagged value, per currency, zeros included', () => {
  const out = employeeBreakdown([
    empRes('Avery', 100, 'USD', 'exception'),
    empRes('Blake', 80, 'EUR', 'needs-review'),
    empRes('Blake', 200, 'USD', 'exception'),
    empRes('Casey', 50, 'USD', 'clean'),
  ]);
  assert.deepEqual(out.map((e) => e.employee), ['Blake', 'Avery', 'Casey']);
  assert.deepEqual(out[0].flagged, [['USD', 200], ['EUR', 80]]);
  assert.equal(out[0].exceptions, 1);
  assert.equal(out[0].review, 1);
  assert.deepEqual(out[2].flagged, []);
});

test('a blank employee column still gets a named line', () => {
  const [e] = employeeBreakdown([empRes('', 10, 'USD', 'exception')]);
  assert.equal(e.employee, '(no employee)');
});

// --------------------------------------------------------------------------
// Reviewer decisions land in the Exceptions tab, and never in the run hash.
// --------------------------------------------------------------------------

const stubXLSX = () => ({
  utils: {
    book_new: () => ({ Sheets: {}, SheetNames: [] }),
    aoa_to_sheet: (aoa) => ({ aoa, '!ref': 'A1:Z999' }),
    book_append_sheet: (wb, ws, name) => { wb.Sheets[name] = ws; wb.SheetNames.push(name); },
  },
});

const decidedResults = () => [{
  row: { txnId: 'T1', employee: 'A', date: '2026-07-02', vendor: 'V', category: 'Meals',
    amount: 120, currency: 'USD', receiptFile: 'r.pdf', purpose: 'x', approver: 'B' },
  extraction: null,
  findings: [{ code: 'MISSING_RECEIPT', severity: 'hard', message: 'No support document attached for 120.00', ruleset: '1.1.0' }],
  status: 'exception', hardCount: 1, softCount: 0,
}];

test('a decision fills the Exceptions sign-off columns; undecided stays blank', async () => {
  const { DEFAULT_POLICY } = await import('../app/rules.js');
  const meta = { policy: DEFAULT_POLICY, generatedAt: 'now', reportName: 'r', receiptCount: 1, ocrCount: 0, hash: 'h' };
  const reviews = new Map([['T1::MISSING_RECEIPT',
    { decision: 'approved', note: 'ok this once', reviewer: 'Wes', date: '2026-08-14' }]]);

  const withDecision = buildWorkbook(stubXLSX(), decidedResults(), { ...meta, reviews });
  const excRow = withDecision.Sheets['Exceptions'].aoa.find((r) => r[0] === 'T1');
  assert.deepEqual(excRow.slice(-4), ['Approved', 'Wes', '2026-08-14', 'ok this once']);

  const without = buildWorkbook(stubXLSX(), decidedResults(), meta);
  const blankRow = without.Sheets['Exceptions'].aoa.find((r) => r[0] === 'T1');
  assert.deepEqual(blankRow.slice(-4), ['', '', '', '']);
});

test('the run hash never sees reviewer decisions', async () => {
  // runHash takes results, policy, budget — there is no reviews parameter, and
  // the material must be identical whether or not decisions exist elsewhere.
  const { DEFAULT_POLICY } = await import('../app/rules.js');
  const a = await runHash(decidedResults(), DEFAULT_POLICY);
  const b = await runHash(decidedResults(), DEFAULT_POLICY);
  assert.ok(a === b && typeof a === 'string' && a.length === 64);
});
