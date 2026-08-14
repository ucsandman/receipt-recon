// Card-statement reconciliation, from a local file only.
//
// The Methodology tab has always named this report's largest blind spot: a
// charge that exists with no expense row at all was invisible, and an expense
// row with no charge behind it looked exactly like a real one. Dropping in the
// card statement the user downloads THEMSELVES closes both, with no bank API,
// no OAuth and no live connection — a spreadsheet in, findings out, same as
// everything else here.
//
// Every tolerance is a named policy value, printed into the workbook. A fuzzy
// match nobody can restate is not an audit rule.

import { SEVERITY, RULESET_VERSION, vendorSimilarity } from './rules.js';
import { normalizeDate, toNumber } from './sheet.js';
import { CURRENCY_CODES } from './extract.js';

// Statement exports name their columns differently per issuer.
export const STATEMENT_ALIASES = {
  date: ['date', 'transaction date', 'trans date', 'posting date', 'post date', 'posted'],
  description: ['description', 'merchant', 'merchant name', 'details', 'payee', 'narrative', 'memo', 'transaction description'],
  amount: ['amount', 'debit', 'charge', 'transaction amount', 'billing amount'],
  currency: ['currency', 'ccy', 'cur', 'billing currency'],
};

// Payments toward the balance are not spend; matching them against expense
// rows would be noise. Skipped rows are counted and disclosed.
const RE_PAYMENT = /\b(payment|autopay|auto-pay|direct debit|thank you|credit adjustment|balance transfer)\b/i;

function findColumn(cells, aliases) {
  let idx = cells.findIndex((c) => aliases.includes(c));
  if (idx === -1) idx = cells.findIndex((c) => c && aliases.some((a) => c.includes(a)));
  return idx;
}

function normCode(v) {
  const s = String(v ?? '').trim().toUpperCase();
  return CURRENCY_CODES.includes(s) ? s : null;
}

function daysBetween(a, b) {
  if (!a || !b) return null;
  const da = new Date(a + 'T00:00:00Z'), db = new Date(b + 'T00:00:00Z');
  if (Number.isNaN(da) || Number.isNaN(db)) return null;
  return Math.round((db - da) / 86400000);
}

function finding(code, severity, message, extra = {}) {
  return { code, severity, message, ruleset: RULESET_VERSION, ...extra };
}

/** Read the statement table out of a sheet, wherever its header starts.
 *
 *  Amounts are taken as absolute values: issuers disagree on whether a charge
 *  is positive or negative, and a sign convention is not evidence. Returns
 *  null when no date + amount header pair exists in the first dozen rows. */
export function parseStatement(aoa) {
  if (!Array.isArray(aoa) || !aoa.length) return null;
  const scan = Math.min(aoa.length, 12);
  for (let i = 0; i < scan; i++) {
    const cells = (aoa[i] || []).map((c) => String(c ?? '').trim().toLowerCase());
    const date = findColumn(cells, STATEMENT_ALIASES.date);
    const amount = findColumn(cells, STATEMENT_ALIASES.amount);
    if (date === -1 || amount === -1 || date === amount) continue;
    const description = findColumn(cells, STATEMENT_ALIASES.description);
    const currency = findColumn(cells, STATEMENT_ALIASES.currency);

    const rows = [];
    let skipped = 0;
    for (let r = i + 1; r < aoa.length; r++) {
      const arr = aoa[r] || [];
      const d = normalizeDate(arr[date]);
      const amt = toNumber(arr[amount]);
      if (d === null || amt === null) continue;
      const desc = description !== -1 ? String(arr[description] ?? '').trim() : '';
      if (RE_PAYMENT.test(desc)) { skipped++; continue; }
      rows.push({
        line: r + 1,               // 1-based, the row the user sees in Excel
        date: d,
        description: desc,
        amount: Math.abs(amt),
        currency: currency !== -1 ? normCode(arr[currency]) : null,
      });
    }
    if (rows.length || skipped) return { rows, headerRow: i, skipped };
  }
  return null;
}

/** Choose the most statement-shaped sheet of a workbook. */
export function pickStatementSheet(sheets) {
  let best = -1, bestScore = 0;
  sheets.forEach((s, i) => {
    const cells = (s.aoa?.[0] ?? []).map((c) => String(c ?? '').trim().toLowerCase());
    // Cheap pre-score on the first row plus a real parse for offset headers.
    const parsed = parseStatement(s.aoa);
    if (!parsed) return;
    const mapped = ['date', 'description', 'amount', 'currency']
      .filter((f) => findColumn(cells, STATEMENT_ALIASES[f]) !== -1).length;
    const score = parsed.rows.length + mapped;
    if (score > bestScore) { best = i; bestScore = score; }
  });
  return best;
}

/** Match expense rows to statement charges, one-to-one, and report both
 *  leftovers.
 *
 *  A match needs: same currency when both sides state one; amounts within
 *  policy.amountToleranceAbs (of the charge's absolute value); dates within
 *  policy.statementDateToleranceDays (card post dates lag purchase dates).
 *  Among candidates the smallest date gap wins, with the vendor-descriptor
 *  similarity as the tiebreak — issuer descriptors like "SQ *COFFEE SHOP"
 *  are too mangled to REQUIRE a name match, so the name only ever breaks ties.
 *
 *  Leftover statement charge  -> UNCLAIMED_CHARGE, HARD, report-level: spend
 *    that never entered the expense report is the exact thing the Methodology
 *    tab used to admit it could not see.
 *  Leftover expense row       -> CLAIMED_NOT_ON_STATEMENT, SOFT, on the row:
 *    cash or a personal card is an innocent explanation, so it needs a look,
 *    not a verdict. */
export function reconcileStatement(rows, stmtRows, policy) {
  const dateTol = policy.statementDateToleranceDays ?? 5;
  const amtTol = policy.amountToleranceAbs ?? 0.02;

  const takenLines = new Set();
  const matches = [];
  const rowFindings = new Map();
  const notOnStatement = [];

  for (const row of rows) {
    if (typeof row.amount !== 'number' || !row.date) continue;
    let best = null;
    for (const s of stmtRows) {
      if (takenLines.has(s.line)) continue;
      if (s.currency && row.currency && s.currency !== String(row.currency).toUpperCase()) continue;
      if (Math.abs(s.amount - row.amount) > amtTol) continue;
      const gap = Math.abs(daysBetween(row.date, s.date) ?? Infinity);
      if (gap > dateTol) continue;
      const sim = vendorSimilarity(s.description, row.vendor);
      if (!best || gap < best.gap || (gap === best.gap && sim > best.sim)) {
        best = { s, gap, sim };
      }
    }
    if (best) {
      takenLines.add(best.s.line);
      matches.push({ txnId: row.txnId, line: best.s.line, gapDays: best.gap });
    } else {
      notOnStatement.push(row.txnId);
      rowFindings.set(row.txnId, [finding('CLAIMED_NOT_ON_STATEMENT', SEVERITY.SOFT,
        `No charge of ${row.amount.toFixed(2)} ${row.currency || ''} within ${dateTol} days of ` +
        `${row.date} appears on the card statement. Paid in cash or on a personal card, ` +
        `or not a real charge — either way it needs a look.`,
        { claimed: row.amount, threshold: dateTol })]);
    }
  }

  const unclaimed = stmtRows.filter((s) => !takenLines.has(s.line));
  const findings = unclaimed.map((s) => finding('UNCLAIMED_CHARGE', SEVERITY.HARD,
    `Statement line ${s.line}: "${s.description || '(no description)'}" for ` +
    `${s.amount.toFixed(2)}${s.currency ? ` ${s.currency}` : ''} on ${s.date} has no matching ` +
    `expense row within ${dateTol} days and ${amtTol.toFixed(2)} tolerance. ` +
    `This spend was never reported.`,
    { line: s.line, actual: s.amount, threshold: dateTol }));

  return { matchedCount: matches.length, matches, unclaimed, notOnStatement, rowFindings, findings };
}
