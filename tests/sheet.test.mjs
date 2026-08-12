// Spreadsheet intake tests.
//
// These cover the ~40 lines that decide the fate of every row in the report:
// which column means what, and what a date string turns into. The date half is
// hashed material (report.js runHash), so a value that depends on the machine
// the audit ran on breaks the reproducibility promise the whole tool is sold on.

import assert from 'node:assert/strict';
import test from 'node:test';

import { mapHeaders, normalizeDate, toNumber, excelSerialToISO } from '../app/sheet.js';

// Two zones 25 hours apart. Anything parsed through the ambient Date parser and
// then run through .toISOString() lands on a different calendar day in these two.
const EAST = 'Pacific/Kiritimati';   // UTC+14
const WEST = 'Pacific/Midway';       // UTC-11

function inZone(tz, fn) {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev;
  }
}

test('the timezone control actually bites, so the test below is not vacuous', () => {
  // If this ever stops failing to differ, the platform stopped honouring a
  // runtime TZ change and the reproducibility test underneath proves nothing.
  const east = inZone(EAST, () => new Date('July 2, 2026').toISOString().slice(0, 10));
  const west = inZone(WEST, () => new Date('July 2, 2026').toISOString().slice(0, 10));
  assert.notEqual(east, west,
    'the ambient Date parser must resolve this differently per zone, or this suite has no teeth');
});

test('a spelled-out date is the same day in every timezone', () => {
  const cases = {
    'July 2, 2026': '2026-07-02',
    'Jul 2 2026': '2026-07-02',
    '2 July 2026': '2026-07-02',
    '2-Jul-2026': '2026-07-02',
    'December 31, 2026': '2026-12-31',
    'January 1, 2026': '2026-01-01',
  };
  for (const [input, want] of Object.entries(cases)) {
    for (const tz of [EAST, WEST, 'UTC']) {
      assert.equal(inZone(tz, () => normalizeDate(input)), want,
        `normalizeDate(${JSON.stringify(input)}) under TZ=${tz}`);
    }
  }
});

test('the formats that already worked still work, in every timezone', () => {
  const cases = {
    '2026-07-02': '2026-07-02',
    '2026-7-2': '2026-07-02',
    '07/02/2026': '2026-07-02',
    '25/12/2026': '2026-12-25',   // day-first when field 1 cannot be a month
    '07-02-2026': '2026-07-02',
  };
  for (const [input, want] of Object.entries(cases)) {
    for (const tz of [EAST, WEST, 'UTC']) {
      assert.equal(inZone(tz, () => normalizeDate(input)), want, `${input} under TZ=${tz}`);
    }
  }
  // Excel serials are a UTC day count and must not drift either.
  for (const tz of [EAST, WEST, 'UTC']) {
    assert.equal(inZone(tz, () => normalizeDate(46205)), '2026-07-02', `excel serial under TZ=${tz}`);
    assert.equal(inZone(tz, () => excelSerialToISO(46205)), '2026-07-02', `excelSerialToISO under TZ=${tz}`);
  }
});

test('an unreadable date is null, never a guess', () => {
  for (const bad of ['', null, undefined, 'sometime last week', 'Q3', 'Jarvuary 4, 2026', '13/13/2026']) {
    const got = normalizeDate(bad);
    assert.ok(got === null || /^\d{4}-\d{2}-\d{2}$/.test(got),
      `normalizeDate(${JSON.stringify(bad)}) returned ${JSON.stringify(got)}; must be null or a real ISO date`);
  }
  assert.equal(normalizeDate('sometime last week'), null,
    'a date the parser does not understand must be reported missing, not invented');
});

test('headers are matched on intent, not on an exact string', () => {
  const m = mapHeaders(['Txn ID', 'Employee', 'Date', 'Merchant', 'Expense Type',
    'Gross', 'CCY', 'Attachment', 'Business Purpose', 'Approved By']);
  assert.equal(m.txnId, 0);
  assert.equal(m.employee, 1);
  assert.equal(m.date, 2);
  assert.equal(m.vendor, 3);
  assert.equal(m.category, 4);
  assert.equal(m.amount, 5);
  assert.equal(m.currency, 6);
  assert.equal(m.receiptFile, 7);
  assert.equal(m.purpose, 8);
  assert.equal(m.approver, 9);
});

test('an exact header match wins over a substring match', () => {
  // 'Total' is an amount alias; 'Total Due Date' contains 'date'. The exact
  // pass must claim column 1 for date rather than the substring pass taking 0.
  const m = mapHeaders(['Total Due Date', 'Date', 'Amount']);
  assert.equal(m.date, 1, 'the column literally named Date is the date column');
  assert.equal(m.amount, 2);
});

test('money parses out of the formats a spreadsheet actually holds', () => {
  assert.equal(toNumber(1234.5), 1234.5);
  assert.equal(toNumber('$1,234.50'), 1234.5);
  assert.equal(toNumber('1234.50'), 1234.5);
  assert.equal(toNumber('-42.00'), -42);
  assert.equal(toNumber(''), null);
  assert.equal(toNumber(null), null);
  assert.equal(toNumber('not a number'), null);
});
