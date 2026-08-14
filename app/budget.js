// Budget cover-sheet parsing and reconciliation.
//
// A real workbook often carries a cover sheet: a budget broken down by
// category, sometimes in several currencies, that the expense report is
// supposed to stay inside. This module finds that table, reads it, and
// cross-foots the report against it.
//
// One rule is absolute: no figure is ever converted between currencies.
// A budget line is only ever compared to spend in its own currency, and
// anything that cannot be compared without a conversion is reported as
// unverifiable instead of guessed. An FX rate would need a source, a date
// and a network call, and every one of those breaks the reproducibility
// this tool is built on.

import { SEVERITY, RULESET_VERSION } from './rules.js';
import { toNumber } from './sheet.js';
import { CURRENCY_SYMBOLS, CURRENCY_CODES } from './extract.js';

const LABEL_ALIASES = ['category', 'expense type', 'line item', 'budget line',
  'cost center', 'cost centre', 'item', 'account', 'description', 'type', 'line'];
const AMOUNT_ALIASES = ['budget', 'budgeted', 'allocated', 'allocation',
  'allowance', 'approved', 'planned', 'plan', 'limit'];
const CURRENCY_ALIASES = ['currency', 'ccy', 'cur'];

const RE_CODE = new RegExp(`\\b(${CURRENCY_CODES.join('|')})\\b`, 'i');
const RE_TOTAL_LABEL = /^(grand\s+|overall\s+)?total\b/i;

const round2 = (n) => Math.round(n * 100) / 100;
const catKey = (s) => String(s ?? '').trim().toLowerCase();

function finding(code, severity, message, extra = {}) {
  return { code, severity, message, ruleset: RULESET_VERSION, ...extra };
}

function findColumn(cells, aliases) {
  let idx = cells.findIndex((c) => aliases.includes(c));
  if (idx === -1) idx = cells.findIndex((c) => c && aliases.some((a) => c.includes(a)));
  return idx;
}

/** A currency riding inside the cell itself: "€1,200.00", "USD 3,000". */
function currencyInCell(v) {
  if (typeof v !== 'string') return null;
  const code = v.match(RE_CODE);
  if (code) return code[1].toUpperCase();
  for (const [sym, cur] of Object.entries(CURRENCY_SYMBOLS)) {
    if (v.includes(sym)) return cur;
  }
  return null;
}

function normCode(v) {
  const s = String(v ?? '').trim().toUpperCase();
  return CURRENCY_CODES.includes(s) ? s : null;
}

/** Find and read the budget table in a sheet, wherever it starts.
 *
 *  Cover sheets do not start at A1: there is a company name, a title, a blank
 *  row. The header row is searched for, not assumed. Returns null when the
 *  sheet holds no recognisable label + budget column pair. */
export function parseBudgetSheet(aoa) {
  if (!Array.isArray(aoa) || !aoa.length) return null;
  const scan = Math.min(aoa.length, 12);
  for (let i = 0; i < scan; i++) {
    const cells = (aoa[i] || []).map((c) => String(c ?? '').trim().toLowerCase());
    const label = findColumn(cells, LABEL_ALIASES);
    const budget = findColumn(cells, AMOUNT_ALIASES);
    if (label === -1 || budget === -1 || label === budget) continue;
    const currency = findColumn(cells, CURRENCY_ALIASES);

    const entries = [];
    for (let r = i + 1; r < aoa.length; r++) {
      const rowArr = aoa[r] || [];
      const name = String(rowArr[label] ?? '').trim();
      const raw = rowArr[budget];
      const amount = toNumber(raw);
      if (!name || amount === null) continue;
      const cur = (currency !== -1 ? normCode(rowArr[currency]) : null) ?? currencyInCell(raw);
      entries.push({ label: name, currency: cur, budget: amount });
    }
    if (entries.length) return { entries, headerRow: i };
  }
  return null;
}

/** Choose the most budget-shaped sheet that is not the transaction sheet. */
export function pickBudgetSheet(sheets, excludeIndex) {
  let best = -1, bestScore = 0;
  sheets.forEach((s, i) => {
    if (i === excludeIndex) return;
    const parsed = parseBudgetSheet(s.aoa);
    if (!parsed) return;
    const nameHint = /budget|cover|summary|allocation/i.test(s.name || '') ? 0.5 : 0;
    const score = parsed.entries.length + nameHint;
    if (score > bestScore) { best = i; bestScore = score; }
  });
  return best;
}

/** Cross-foot the report against the budget, per category and per currency.
 *
 *  @returns { lines, findings } where lines mirror the budget entries with the
 *  observed spend, and findings are report-level (not tied to one row). */
export function reconcileBudget(rows, entries, policy = {}) {
  const tol = policy.amountToleranceAbs ?? 0.02;

  // Spend per category per currency, plus per-currency grand totals.
  const spendByCat = new Map();   // catKey -> Map(currency -> sum)
  const displayName = new Map();  // catKey -> first-seen trimmed name
  const totals = new Map();       // currency -> sum
  for (const r of rows) {
    if (typeof r.amount !== 'number') continue;
    const key = catKey(r.category);
    const cur = String(r.currency || 'USD').toUpperCase();
    if (!spendByCat.has(key)) spendByCat.set(key, new Map());
    const m = spendByCat.get(key);
    m.set(cur, round2((m.get(cur) || 0) + r.amount));
    totals.set(cur, round2((totals.get(cur) || 0) + r.amount));
    if (!displayName.has(key)) displayName.set(key, String(r.category ?? '').trim());
  }

  const lines = [];
  const findings = [];

  // Currencies covered per budget label, so cross-currency spend is only
  // flagged when NO line of that label carries it.
  const covered = new Map();      // labelKey -> Set(currency)
  const addCovered = (key, cur) => {
    if (!covered.has(key)) covered.set(key, new Set());
    if (cur) covered.get(key).add(cur);
  };

  const nonTotalKeys = new Set();
  for (const e of entries) {
    const key = catKey(e.label);
    if (!RE_TOTAL_LABEL.test(e.label)) nonTotalKeys.add(key);
  }

  for (const e of entries) {
    const key = catKey(e.label);
    const isTotal = RE_TOTAL_LABEL.test(e.label);
    const spend = isTotal ? totals : (spendByCat.get(key) || new Map());
    const spentCurrencies = [...spend.keys()].filter((c) => spend.get(c));

    let cur = e.currency;
    if (!cur) {
      if (spentCurrencies.length > 1) {
        addCovered(key, null);
        lines.push({ label: e.label, currency: null, budget: e.budget, actual: null, delta: null, status: 'unverified' });
        findings.push(finding('BUDGET_CURRENCY_AMBIGUOUS', SEVERITY.SOFT,
          `The budget line "${e.label}" (${e.budget.toFixed(2)}) names no currency, and the report spends ` +
          `against it in ${spentCurrencies.join(' and ')}. Without a stated currency this line cannot be ` +
          `verified, and converting would require an FX rate this tool refuses to guess.`,
          { label: e.label, budget: e.budget, currencies: spentCurrencies }));
        continue;
      }
      cur = spentCurrencies[0] ?? null;
    }
    addCovered(key, cur);

    const actual = cur ? (spend.get(cur) || 0) : 0;
    if (!actual) {
      lines.push({ label: e.label, currency: cur, budget: e.budget, actual: 0, delta: round2(-e.budget), status: 'unspent' });
      continue;
    }
    const delta = round2(actual - e.budget);
    if (actual > e.budget + tol) {
      lines.push({ label: e.label, currency: cur, budget: e.budget, actual, delta, status: 'over' });
      findings.push(finding('BUDGET_EXCEEDED', SEVERITY.HARD,
        `${e.label}: the report claims ${actual.toFixed(2)} ${cur} against a budget of ` +
        `${e.budget.toFixed(2)} ${cur}, over by ${delta.toFixed(2)}.`,
        { label: e.label, currency: cur, budget: e.budget, actual, difference: delta }));
    } else {
      lines.push({ label: e.label, currency: cur, budget: e.budget, actual, delta, status: 'ok' });
    }
  }

  // Spend in a currency no line of that label covers. Reported, never summed
  // into another currency's line.
  for (const [key, cov] of covered) {
    const isTotal = !nonTotalKeys.has(key);
    const spend = isTotal ? totals : (spendByCat.get(key) || new Map());
    const label = entries.find((e) => catKey(e.label) === key)?.label ?? key;
    const others = [...spend.keys()].filter((c) => spend.get(c) && !cov.has(c));
    if (others.length && cov.size) {
      findings.push(finding('BUDGET_CURRENCY_UNMATCHED', SEVERITY.SOFT,
        `"${label}" also has spend in ${others.map((c) => `${spend.get(c).toFixed(2)} ${c}`).join(', ')}, ` +
        `but no budget line in ${others.length === 1 ? 'that currency' : 'those currencies'}. ` +
        `It was not converted or counted against the ${[...cov].join('/')} line; check it by hand.`,
        { label, currencies: others }));
    }
  }

  // Categories that were spent against but budgeted nowhere. Only meaningful
  // when the budget actually itemizes categories.
  if (nonTotalKeys.size) {
    const unbudgeted = [...spendByCat.keys()]
      .filter((k) => k && !nonTotalKeys.has(k))
      .map((k) => displayName.get(k) || k);
    if (unbudgeted.length) {
      findings.push(finding('BUDGET_UNBUDGETED_SPEND', SEVERITY.SOFT,
        `The report spends in ${unbudgeted.length === 1 ? 'a category' : 'categories'} the budget has no ` +
        `line for: ${unbudgeted.join(', ')}.`,
        { categories: unbudgeted }));
    }
  }

  return { lines, findings };
}
