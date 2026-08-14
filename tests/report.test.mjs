// Workbook helpers.
//
// sumsByCurrency exists because the "Value flagged" tile and the Summary tab
// used to add euro, yen and dollar amounts into one number and print it as
// USD. For the multi-currency reports this tool now targets, that number was
// simply false.

import assert from 'node:assert/strict';
import test from 'node:test';

import { sumsByCurrency } from '../app/report.js';

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
