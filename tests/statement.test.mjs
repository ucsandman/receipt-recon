// Card-statement reconciliation tests.
//
// The Methodology tab used to name this as the report's largest blind spot: a
// charge with no expense row at all was invisible. The reconciliation is
// local-file only — the user downloads their own statement export — and every
// tolerance it applies is a named policy value asserted here, because a fuzzy
// match nobody can restate is not an audit rule.

import assert from 'node:assert/strict';
import test from 'node:test';

import { parseStatement, pickStatementSheet, reconcileStatement } from '../app/statement.js';
import { auditAll, DEFAULT_POLICY } from '../app/rules.js';

const row = (over = {}) => ({
  txnId: 'T1', employee: 'A', date: '2026-07-02', vendor: 'Bluebird Diner',
  category: 'Meals', amount: 42.50, currency: 'USD', receiptFile: null,
  purpose: 'Lunch', approver: 'B', ...over,
});

const stmt = (over = {}) => ({
  line: 2, date: '2026-07-03', description: 'SQ *BLUEBIRD DINER', amount: 42.50,
  currency: 'USD', ...over,
});

// --------------------------------------------------------------------------
// parsing
// --------------------------------------------------------------------------

test('the statement header is found below junk rows, like the budget table', () => {
  const parsed = parseStatement([
    ['First Provincial Bank'],
    [],
    ['Posting Date', 'Description', 'Amount'],
    ['2026-07-03', 'SQ *BLUEBIRD DINER', -42.5],
    ['2026-07-05', 'PAYMENT THANK YOU', 500],
  ]);
  assert.equal(parsed.headerRow, 2);
  assert.equal(parsed.rows.length, 1, 'the payment line is skipped, not treated as a charge');
  assert.equal(parsed.rows[0].amount, 42.5, 'a debit-negative export is read as a positive charge');
  assert.equal(parsed.rows[0].date, '2026-07-03');
  assert.equal(parsed.skipped, 1);
});

test('a sheet with no date+amount header pair is not a statement', () => {
  assert.equal(parseStatement([['Name', 'Notes'], ['x', 'y']]), null);
  assert.equal(pickStatementSheet([{ name: 'S', aoa: [['Name', 'Notes']] }]), -1);
});

test('the best-qualifying sheet wins, mirroring the transaction-sheet picker', () => {
  const idx = pickStatementSheet([
    { name: 'Cover', aoa: [['Anything']] },
    { name: 'Charges', aoa: [['Date', 'Description', 'Amount'], ['2026-07-01', 'X', 10]] },
  ]);
  assert.equal(idx, 1);
});

// --------------------------------------------------------------------------
// matching
// --------------------------------------------------------------------------

test('a match at the exact date-tolerance boundary is a match, not a finding', () => {
  const policy = { ...DEFAULT_POLICY, statementDateToleranceDays: 5 };
  const r = reconcileStatement([row({ date: '2026-07-02' })],
    [stmt({ date: '2026-07-07' })], policy);
  assert.equal(r.matchedCount, 1);
  assert.equal(r.unclaimed.length, 0);
  assert.equal(r.rowFindings.size, 0);
});

test('a statement charge one day past tolerance is UNCLAIMED_CHARGE, hard', () => {
  const policy = { ...DEFAULT_POLICY, statementDateToleranceDays: 5 };
  const r = reconcileStatement([row({ date: '2026-07-02' })],
    [stmt({ date: '2026-07-08' })], policy);
  assert.equal(r.matchedCount, 0);
  assert.equal(r.unclaimed.length, 1);
  const f = r.findings.find((x) => x.code === 'UNCLAIMED_CHARGE');
  assert.ok(f, 'the unmatched charge is a report-level finding');
  assert.equal(f.severity, 'hard');
  assert.match(f.message, /no matching expense row/i);
});

test('an expense row with no charge behind it is CLAIMED_NOT_ON_STATEMENT, soft', () => {
  const r = reconcileStatement([row()], [], DEFAULT_POLICY);
  const fs = r.rowFindings.get('T1');
  assert.ok(fs?.length === 1);
  assert.equal(fs[0].code, 'CLAIMED_NOT_ON_STATEMENT');
  assert.equal(fs[0].severity, 'soft', 'cash or a personal card is an innocent explanation');
  assert.match(fs[0].message, /cash|personal/i);
  assert.deepEqual(r.notOnStatement, ['T1']);
});

test('matching is one-to-one: one charge cannot absolve two identical rows', () => {
  const r = reconcileStatement(
    [row({ txnId: 'T1' }), row({ txnId: 'T2' })],
    [stmt()], DEFAULT_POLICY);
  assert.equal(r.matchedCount, 1);
  assert.equal(r.rowFindings.size, 1, 'exactly one of the twins is left unbacked');
});

test('currencies are respected when both sides state one', () => {
  const r = reconcileStatement([row({ currency: 'USD' })],
    [stmt({ currency: 'EUR' })], DEFAULT_POLICY);
  assert.equal(r.matchedCount, 0, 'EUR 42.50 is not USD 42.50');
});

test('a statement with no currency column matches any row currency', () => {
  const r = reconcileStatement([row({ currency: 'EUR' })],
    [stmt({ currency: null })], DEFAULT_POLICY);
  assert.equal(r.matchedCount, 1);
});

test('the closest date wins when two charges could back one row', () => {
  const r = reconcileStatement(
    [row({ date: '2026-07-02' })],
    [stmt({ line: 5, date: '2026-07-06' }), stmt({ line: 6, date: '2026-07-03' })],
    DEFAULT_POLICY);
  assert.equal(r.matches[0].line, 6);
});

// --------------------------------------------------------------------------
// integration with the rules engine
// --------------------------------------------------------------------------

test('statement findings ride into auditAll and drive row status', () => {
  const rows = [row({ amount: 20 })];   // under floor, would otherwise be clean-ish
  const recon = reconcileStatement(rows, [], DEFAULT_POLICY);
  const withStmt = auditAll(rows, new Map(), DEFAULT_POLICY, recon.rowFindings);
  assert.ok(withStmt[0].findings.some((f) => f.code === 'CLAIMED_NOT_ON_STATEMENT'));
  assert.notEqual(withStmt[0].status, 'clean');
  const without = auditAll(rows, new Map(), DEFAULT_POLICY);
  assert.ok(!without[0].findings.some((f) => f.code === 'CLAIMED_NOT_ON_STATEMENT'),
    'omitting the extra map keeps behaviour byte-identical');
});
