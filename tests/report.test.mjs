// Workbook helpers.
//
// sumsByCurrency exists because the "Value flagged" tile and the Summary tab
// used to add euro, yen and dollar amounts into one number and print it as
// USD. For the multi-currency reports this tool now targets, that number was
// simply false.

import assert from 'node:assert/strict';
import test from 'node:test';

import { sumsByCurrency, employeeBreakdown } from '../app/report.js';

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
