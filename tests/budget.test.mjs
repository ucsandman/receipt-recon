// Budget cover-sheet reconciliation tests.
//
// The feature exists because a real user's workbook carries a cover sheet with
// a budget breakdown in several currencies that has to reconcile against the
// expense report. Two hard promises are tested here: parsing survives a cover
// sheet that does not start at A1, and reconciliation NEVER converts between
// currencies -- a figure is only ever compared to spend in its own currency.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseBudgetSheet, pickBudgetSheet, reconcileBudget,
} from '../app/budget.js';

// --------------------------------------------------------------------------
// parsing
// --------------------------------------------------------------------------

test('finds the budget table below cover-sheet title rows', () => {
  const aoa = [
    ['Acme GmbH'],
    ['Expense report — July 2026'],
    [],
    ['Category', 'Currency', 'Budget'],
    ['Meals', 'EUR', 1200],
    ['Travel', 'USD', 3000],
  ];
  const parsed = parseBudgetSheet(aoa);
  assert.ok(parsed, 'a budget table three rows down must still be found');
  assert.deepEqual(parsed.entries, [
    { label: 'Meals', currency: 'EUR', budget: 1200 },
    { label: 'Travel', currency: 'USD', budget: 3000 },
  ]);
});

test('reads a currency embedded in the budget cell when there is no currency column', () => {
  const aoa = [
    ['Line item', 'Budgeted'],
    ['Meals', '€1,200.00'],
    ['Travel', 'USD 3,000'],
    ['Lodging', 2500],
  ];
  const parsed = parseBudgetSheet(aoa);
  assert.ok(parsed);
  assert.deepEqual(parsed.entries, [
    { label: 'Meals', currency: 'EUR', budget: 1200 },
    { label: 'Travel', currency: 'USD', budget: 3000 },
    { label: 'Lodging', currency: null, budget: 2500 },
  ]);
});

test('returns null for a sheet with no recognisable budget table', () => {
  assert.equal(parseBudgetSheet([['Notes'], ['Call finance about Q3']]), null);
  assert.equal(parseBudgetSheet([]), null);
});

test('pickBudgetSheet prefers the parseable non-transaction sheet', () => {
  const sheets = [
    { name: 'Expenses', aoa: [['Txn ID', 'Amount'], ['T1', 10]] },
    { name: 'Notes', aoa: [['Remember to file']] },
    { name: 'Cover', aoa: [['Category', 'Budget'], ['Meals', 500]] },
  ];
  assert.equal(pickBudgetSheet(sheets, 0), 2);
});

test('pickBudgetSheet returns -1 when nothing parses as a budget', () => {
  const sheets = [
    { name: 'Expenses', aoa: [['Txn ID', 'Amount'], ['T1', 10]] },
    { name: 'Notes', aoa: [['Remember to file']] },
  ];
  assert.equal(pickBudgetSheet(sheets, 0), -1);
});

// --------------------------------------------------------------------------
// reconciliation
// --------------------------------------------------------------------------

const row = (category, amount, currency = 'USD') => ({ category, amount, currency });

test('spend over a budget line raises a hard BUDGET_EXCEEDED with the delta', () => {
  const { lines, findings } = reconcileBudget(
    [row('Meals', 900, 'EUR'), row('Meals', 400, 'EUR')],
    [{ label: 'Meals', currency: 'EUR', budget: 1200 }]);
  const line = lines.find((l) => l.label === 'Meals');
  assert.equal(line.status, 'over');
  assert.equal(line.actual, 1300);
  assert.equal(line.delta, 100);
  const f = findings.find((x) => x.code === 'BUDGET_EXCEEDED');
  assert.equal(f.severity, 'hard');
  assert.match(f.message, /EUR/);
});

test('spend within budget is an ok line and no finding', () => {
  const { lines, findings } = reconcileBudget(
    [row('Travel', 100)],
    [{ label: 'Travel', currency: 'USD', budget: 3000 }]);
  assert.equal(lines[0].status, 'ok');
  assert.equal(findings.filter((f) => f.code === 'BUDGET_EXCEEDED').length, 0);
});

test('never converts: same-category spend in another currency is flagged, not summed', () => {
  const { lines, findings } = reconcileBudget(
    [row('Meals', 1000, 'EUR'), row('Meals', 5000, 'JPY')],
    [{ label: 'Meals', currency: 'EUR', budget: 1200 }]);
  // The EUR line only sees EUR spend.
  const line = lines.find((l) => l.label === 'Meals');
  assert.equal(line.actual, 1000);
  assert.equal(line.status, 'ok');
  // The JPY spend is reported as unverifiable, never converted.
  const f = findings.find((x) => x.code === 'BUDGET_CURRENCY_UNMATCHED');
  assert.equal(f.severity, 'soft');
  assert.match(f.message, /JPY/);
});

test('a currency-less budget line adopts the single currency the category was spent in', () => {
  const { lines } = reconcileBudget(
    [row('Lodging', 2600, 'GBP')],
    [{ label: 'Lodging', currency: null, budget: 2500 }]);
  assert.equal(lines[0].currency, 'GBP');
  assert.equal(lines[0].status, 'over');
});

test('a currency-less budget line over multi-currency spend is unverified, not guessed', () => {
  const { lines, findings } = reconcileBudget(
    [row('Lodging', 100, 'GBP'), row('Lodging', 100, 'USD')],
    [{ label: 'Lodging', currency: null, budget: 2500 }]);
  assert.equal(lines[0].status, 'unverified');
  const f = findings.find((x) => x.code === 'BUDGET_CURRENCY_AMBIGUOUS');
  assert.equal(f.severity, 'soft');
});

test('a Total budget line reconciles against all spend in its currency', () => {
  const { lines } = reconcileBudget(
    [row('Meals', 700, 'EUR'), row('Travel', 600, 'EUR')],
    [{ label: 'Grand Total', currency: 'EUR', budget: 1200 }]);
  const line = lines.find((l) => l.label === 'Grand Total');
  assert.equal(line.actual, 1300);
  assert.equal(line.status, 'over');
});

test('spend in categories with no budget line is reported once, softly', () => {
  const { findings } = reconcileBudget(
    [row('Meals', 10), row('Taxis', 20), row('Flowers', 30)],
    [{ label: 'Meals', currency: 'USD', budget: 500 }]);
  const f = findings.filter((x) => x.code === 'BUDGET_UNBUDGETED_SPEND');
  assert.equal(f.length, 1);
  assert.match(f[0].message, /Taxis/);
  assert.match(f[0].message, /Flowers/);
});

test('an untouched budget line is marked unspent', () => {
  const { lines } = reconcileBudget(
    [row('Meals', 10)],
    [{ label: 'Meals', currency: 'USD', budget: 500 },
     { label: 'Conferences', currency: 'USD', budget: 800 }]);
  assert.equal(lines.find((l) => l.label === 'Conferences').status, 'unspent');
});

test('category matching ignores case and surrounding space', () => {
  const { lines } = reconcileBudget(
    [row('  meals ', 600, 'USD')],
    [{ label: 'MEALS', currency: 'USD', budget: 500 }]);
  assert.equal(lines[0].status, 'over');
});
