// The audit rules engine.
//
// Every check here is deterministic: same inputs, same output, every time.
// That is the whole point. An auditor has to be able to re-run last month's
// audit and get last month's answer, and has to be able to explain to a
// partner exactly why a row was flagged. A model that "looks it over" and
// gives a slightly different answer on Tuesday cannot do either.
//
// No network calls. No AI. Just arithmetic and table lookups over the fields
// the extractor read off the PDF.

export const RULESET_VERSION = '1.0.0';

export const DEFAULT_POLICY = {
  // ---- documentation thresholds -----------------------------------------
  // The IRS documentary-evidence floor. Below this, a receipt is not strictly
  // required, but amount / date / place / business purpose still are.
  receiptRequiredAtOrAbove: 75.00,
  // Lodging always needs a receipt regardless of amount.
  receiptAlwaysRequiredCategories: ['Lodging', 'Hotel'],
  itemizationRequiredAtOrAbove: 75.00,
  itemizationCategories: ['Meals', 'Client Entertainment'],

  // ---- matching tolerances ----------------------------------------------
  // Cash tolerance absorbs rounding, not real differences.
  amountToleranceAbs: 0.02,
  // A card charge legitimately exceeding the printed total by a tip is normal.
  // Anything inside this band is reported as an unsupported tip (soft), not as
  // a mismatch (hard). Without this the exception queue floods with non-issues.
  tipTolerancePct: 0.25,
  tipEligibleCategories: ['Meals', 'Client Entertainment', 'Travel'],
  dateToleranceDays: 3,
  vendorSimilarityThreshold: 0.60,

  // ---- spend limits, per category ---------------------------------------
  categoryLimits: {
    Meals: 150.00,
    'Client Entertainment': 500.00,
  },
  // Approval threshold used by the split-transaction check.
  approvalThreshold: 500.00,
  splitWindowDays: 3,

  // ---- disallowed content ------------------------------------------------
  alcoholKeywords: ['wine', 'beer', 'vodka', 'whisky', 'whiskey', 'tequila', 'rum',
    'gin', 'cabernet', 'merlot', 'chardonnay', 'pinot', 'single malt', 'bourbon',
    'champagne', 'prosecco', 'cocktail', 'liquor', 'spirits', 'brewery', 'ale'],
  personalKeywords: ['netflix', 'streamflix', 'hulu', 'disney+', 'spotify', 'xbox',
    'playstation', 'personal account', 'gym membership', 'grocery'],

  // ---- process -----------------------------------------------------------
  staleSubmissionDays: 60,
  // A weekend date is only a signal for discretionary, in-person spend. Travel
  // happens on weekends by nature, and a recurring subscription bills on
  // whatever day the billing cycle lands on, so flagging those is pure noise.
  weekendExemptCategories: ['Travel', 'Lodging', 'Hotel', 'Software',
    'Subscriptions', 'Utilities', 'Telecom', 'Dues and Subscriptions'],
  flagRoundAmountsAtOrAbove: 100.00,
};

// Severity drives how the report sorts and what an auditor must action.
//   hard   a rule was violated; requires a decision before sign-off
//   soft   a risk signal; worth a look, not a finding on its own
//   info   context, including where the tool could not verify something
export const SEVERITY = { HARD: 'hard', SOFT: 'soft', INFO: 'info' };

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------

const round2 = (n) => Math.round(n * 100) / 100;

function normalizeVendor(s) {
  if (!s) return '';
  return String(s).toLowerCase()
    .replace(/[.,'"()]/g, ' ')
    .replace(/\b(inc|llc|ltd|bv|gmbh|co|corp|company|the|nv|sa|plc|pty)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Dice coefficient over character bigrams. Cheap, no dependency, and good
 *  enough to tell "Ashcroft Chophouse" from "Lakeshore Wine & Spirits" while
 *  still matching "MetroLift" to "Metrolift Inc.". The score is reported so a
 *  human can see why two names were or were not treated as the same vendor. */
export function vendorSimilarity(a, b) {
  const x = normalizeVendor(a);
  const y = normalizeVendor(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.95;
  const bigrams = (s) => {
    const out = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      out.set(g, (out.get(g) || 0) + 1);
    }
    return out;
  };
  const ba = bigrams(x), bb = bigrams(y);
  let shared = 0, total = 0;
  for (const n of ba.values()) total += n;
  for (const n of bb.values()) total += n;
  for (const [g, n] of ba) if (bb.has(g)) shared += Math.min(n, bb.get(g));
  return total ? (2 * shared) / total : 0;
}

function daysBetween(a, b) {
  if (!a || !b) return null;
  const da = new Date(a + 'T00:00:00Z'), db = new Date(b + 'T00:00:00Z');
  if (Number.isNaN(da) || Number.isNaN(db)) return null;
  return Math.round((db - da) / 86400000);
}

function isWeekend(iso) {
  if (!iso) return false;
  const d = new Date(iso + 'T00:00:00Z').getUTCDay();
  return d === 0 || d === 6;
}

/** Whole-word keyword matching.
 *
 *  Substring matching is a trap here, the same one that made "Subtotal" match
 *  "TOTAL". A naive `includes('ale')` fires on "S-ale-s Tax", which appears on
 *  literally every receipt, so every row gets flagged for alcohol and the
 *  exception report becomes worthless. Multi-word keywords are matched as
 *  phrases with boundaries on both ends. See docs/ERRORS.md. */
function keywordHits(haystack, keywords) {
  const t = (haystack || '').toLowerCase();
  return keywords.filter((k) => {
    const escaped = k.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'i').test(t);
  });
}

function finding(code, severity, message, extra = {}) {
  return { code, severity, message, ruleset: RULESET_VERSION, ...extra };
}

// --------------------------------------------------------------------------
// per-row checks
// --------------------------------------------------------------------------

/**
 * @param row   { txnId, employee, date, vendor, category, amount, currency,
 *                receiptFile, purpose, approver }
 * @param ext   extractReceipt() result, or null when no receipt was supplied
 */
export function checkRow(row, ext, policy = DEFAULT_POLICY) {
  const out = [];
  const cat = row.category || '';
  const amt = typeof row.amount === 'number' ? row.amount : null;

  // ---- presence ----------------------------------------------------------
  if (!row.receiptFile) {
    const alwaysNeeded = policy.receiptAlwaysRequiredCategories.includes(cat);
    const overFloor = amt !== null && amt >= policy.receiptRequiredAtOrAbove;
    if (alwaysNeeded || overFloor) {
      out.push(finding('MISSING_RECEIPT', SEVERITY.HARD,
        `No support document attached for ${amt !== null ? amt.toFixed(2) : 'this expense'}` +
        (alwaysNeeded ? ` (${cat} always requires a receipt).`
                      : `, at or above the ${policy.receiptRequiredAtOrAbove.toFixed(2)} documentation floor.`),
        { threshold: policy.receiptRequiredAtOrAbove, actual: amt }));
    } else {
      // Under the floor a receipt is not required, but the row still has to
      // carry the substantiating detail. Saying so is more useful than silence.
      const missing = [];
      if (!row.date) missing.push('date');
      if (!row.vendor) missing.push('place');
      if (!row.purpose) missing.push('business purpose');
      out.push(finding('NO_RECEIPT_UNDER_FLOOR',
        missing.length ? SEVERITY.HARD : SEVERITY.INFO,
        missing.length
          ? `Under the ${policy.receiptRequiredAtOrAbove.toFixed(2)} floor a receipt is not required, but this row is missing: ${missing.join(', ')}.`
          : `No receipt, but the amount is under the ${policy.receiptRequiredAtOrAbove.toFixed(2)} documentation floor and the row carries amount, date, place and purpose.`,
        { threshold: policy.receiptRequiredAtOrAbove, actual: amt }));
    }
    return out;  // nothing further to compare against
  }

  if (!ext || ext.tier === 'failed') {
    out.push(finding('UNREADABLE_RECEIPT', SEVERITY.HARD,
      `Receipt ${row.receiptFile} could not be read automatically${ext?.error ? `: ${ext.error}` : ''}. Verify this one by hand.`,
      { receiptFile: row.receiptFile }));
    return out;
  }

  const f = ext.fields || {};

  // Surface the extractor's own doubts as findings, so a shaky read never
  // silently backs a clean verdict.
  for (const w of f.warnings || []) {
    out.push(finding(/does not foot/i.test(w) ? 'RECEIPT_DOES_NOT_FOOT' : 'EXTRACTION_WARNING',
      SEVERITY.SOFT, w, { receiptFile: row.receiptFile }));
  }

  // ---- amount ------------------------------------------------------------
  if (f.total === null || f.total === undefined) {
    out.push(finding('NO_TOTAL_FOUND', SEVERITY.HARD,
      `No total could be read from ${row.receiptFile}. Verify by hand.`,
      { receiptFile: row.receiptFile }));
  } else if (amt !== null) {
    const diff = round2(amt - f.total);
    const tipEligible = policy.tipEligibleCategories.includes(cat);
    const tipBand = round2(f.total * policy.tipTolerancePct);

    if (Math.abs(diff) <= policy.amountToleranceAbs) {
      // matches
    } else if (diff > 0 && tipEligible && diff <= tipBand && (f.tip === null || f.tip === undefined || f.tip === 0)) {
      out.push(finding('UNSUPPORTED_TIP', SEVERITY.SOFT,
        `Claimed ${amt.toFixed(2)} exceeds the printed receipt total ${f.total.toFixed(2)} by ${diff.toFixed(2)}, ` +
        `consistent with a tip added after printing. Within the ${(policy.tipTolerancePct * 100).toFixed(0)}% tip band, so not treated as a mismatch.`,
        { claimed: amt, receipt: f.total, difference: diff, threshold: tipBand }));
    } else {
      out.push(finding('AMOUNT_MISMATCH', SEVERITY.HARD,
        `Claimed ${amt.toFixed(2)} but the receipt totals ${f.total.toFixed(2)}, ` +
        `an ${diff > 0 ? 'overclaim' : 'underclaim'} of ${Math.abs(diff).toFixed(2)}.`,
        { claimed: amt, receipt: f.total, difference: diff }));
    }
  }

  // ---- currency ----------------------------------------------------------
  if (f.currency && row.currency && f.currency !== row.currency) {
    out.push(finding('CURRENCY_MISMATCH', SEVERITY.HARD,
      `Receipt is denominated in ${f.currency} but the report books this row as ${row.currency}. ` +
      `Confirm an FX conversion was applied; booking the face value across currencies misstates the amount.`,
      { receiptCurrency: f.currency, sheetCurrency: row.currency }));
  }

  // ---- date --------------------------------------------------------------
  if (f.date && row.date) {
    const gap = daysBetween(f.date, row.date);
    if (gap !== null && Math.abs(gap) > policy.dateToleranceDays) {
      out.push(finding('DATE_MISMATCH', SEVERITY.HARD,
        `Report dates this ${row.date} but the receipt reads ${f.date}, a gap of ${Math.abs(gap)} days.`,
        { sheetDate: row.date, receiptDate: f.date, gapDays: gap, threshold: policy.dateToleranceDays }));
    }
  }

  // ---- vendor ------------------------------------------------------------
  if (f.vendor && row.vendor) {
    const score = vendorSimilarity(f.vendor, row.vendor);
    if (score < policy.vendorSimilarityThreshold) {
      out.push(finding('VENDOR_MISMATCH', SEVERITY.HARD,
        `Report names "${row.vendor}" but the receipt reads "${f.vendor}" (similarity ${score.toFixed(2)}, ` +
        `threshold ${policy.vendorSimilarityThreshold.toFixed(2)}).`,
        { sheetVendor: row.vendor, receiptVendor: f.vendor, score, threshold: policy.vendorSimilarityThreshold }));
    }
  }

  // ---- disallowed content ------------------------------------------------
  const body = [f.vendor, row.vendor, ext.text].filter(Boolean).join(' ');
  const booze = keywordHits(body, policy.alcoholKeywords);
  if (booze.length) {
    out.push(finding('POLICY_ALCOHOL', SEVERITY.HARD,
      `Receipt references alcohol (${booze.slice(0, 4).join(', ')}), which policy disallows.`,
      { matched: booze }));
  }
  const personal = keywordHits([f.vendor, row.vendor, row.purpose].filter(Boolean).join(' '),
    policy.personalKeywords);
  if (personal.length) {
    out.push(finding('PERSONAL_EXPENSE', SEVERITY.HARD,
      `Vendor or purpose looks personal rather than business (${personal.join(', ')}).`,
      { matched: personal }));
  }

  // ---- category limit ----------------------------------------------------
  const limit = policy.categoryLimits[cat];
  if (limit !== undefined && amt !== null && amt > limit) {
    out.push(finding('OVER_CATEGORY_LIMIT', SEVERITY.HARD,
      `${amt.toFixed(2)} exceeds the ${cat} limit of ${limit.toFixed(2)}.`,
      { actual: amt, threshold: limit }));
  }

  // ---- itemization -------------------------------------------------------
  if (policy.itemizationCategories.includes(cat) && amt !== null &&
      amt >= policy.itemizationRequiredAtOrAbove) {
    // Count only genuine item lines. A receipt's total, tax, tip and card
    // footer all carry money figures, so counting every money line would make
    // a single-line "Dinner $268.40" receipt look fully itemized.
    const SUMMARY_LINE = /\b(sub\s*-?\s*total|total|balance|amount\s+(due|paid)|sales\s*tax|tax|vat|gst|hst|tip|gratuity|service\s*charge|change|cash|visa|mastercard|amex|discover|card)\b/i;
    const lineCount = (ext.text || '').split('\n')
      .filter((l) => /[$€£]\s?[\d,]+\.\d{2}/.test(l) && !SUMMARY_LINE.test(l)).length;
    if (lineCount <= 1) {
      out.push(finding('MISSING_ITEMIZATION', SEVERITY.HARD,
        `${cat} of ${amt.toFixed(2)} is at or above the ${policy.itemizationRequiredAtOrAbove.toFixed(2)} ` +
        `itemization threshold, but the receipt shows no itemized detail.`,
        { actual: amt, threshold: policy.itemizationRequiredAtOrAbove, lineCount }));
    }
  }

  // ---- soft process signals ---------------------------------------------
  if (isWeekend(row.date) && !policy.weekendExemptCategories.includes(cat)) {
    out.push(finding('WEEKEND_CHARGE', SEVERITY.SOFT,
      `${cat || 'Expense'} dated ${row.date}, a weekend, and ${cat || 'this category'} is not travel-related.`,
      { date: row.date }));
  }
  if (amt !== null && amt >= policy.flagRoundAmountsAtOrAbove && Number.isInteger(amt) && amt % 50 === 0) {
    out.push(finding('ROUND_AMOUNT', SEVERITY.SOFT,
      `Amount is exactly ${amt.toFixed(2)}. Round figures are a weak signal only, not a finding on their own.`,
      { actual: amt }));
  }
  if (f.date && row.date) {
    const age = daysBetween(f.date, row.date);
    if (age !== null && age > policy.staleSubmissionDays) {
      out.push(finding('STALE_SUBMISSION', SEVERITY.SOFT,
        `Receipt is ${age} days older than the report date, beyond the ${policy.staleSubmissionDays}-day submission window.`,
        { gapDays: age, threshold: policy.staleSubmissionDays }));
    }
  }

  return out;
}

// --------------------------------------------------------------------------
// batch checks
//
// These cannot be per-row. A split transaction is invisible to any check that
// only ever looks at one line at a time, which is exactly why it is the
// classic way to get around an approval threshold.
// --------------------------------------------------------------------------

export function checkBatch(rows, policy = DEFAULT_POLICY) {
  const byTxn = new Map();
  const add = (txnId, f) => {
    if (!byTxn.has(txnId)) byTxn.set(txnId, []);
    byTxn.get(txnId).push(f);
  };

  // ---- same support document cited more than once ------------------------
  const byFile = new Map();
  for (const r of rows) {
    if (!r.receiptFile) continue;
    const key = r.receiptFile.toLowerCase();
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key).push(r);
  }
  for (const [file, group] of byFile) {
    if (group.length < 2) continue;
    const ids = group.map((g) => g.txnId);
    for (const r of group) {
      add(r.txnId, finding('DUPLICATE_RECEIPT', SEVERITY.HARD,
        `Support document ${file} is cited by ${group.length} rows: ${ids.join(', ')}. ` +
        `One expense cannot be claimed twice on the same receipt.`,
        { receiptFile: file, rows: ids }));
    }
  }

  // ---- same charge claimed twice under different receipts ----------------
  const seen = new Map();
  for (const r of rows) {
    if (r.amount == null || !r.date) continue;
    const key = `${normalizeVendor(r.vendor)}|${r.date}|${r.amount.toFixed(2)}`;
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(r);
  }
  for (const group of seen.values()) {
    if (group.length < 2) continue;
    // Already reported above if they share one file.
    const files = new Set(group.map((g) => (g.receiptFile || '').toLowerCase()));
    if (files.size <= 1) continue;
    const ids = group.map((g) => g.txnId);
    for (const r of group) {
      add(r.txnId, finding('DUPLICATE_CHARGE', SEVERITY.HARD,
        `Same vendor, date and amount claimed on ${group.length} rows: ${ids.join(', ')}.`,
        { rows: ids }));
    }
  }

  // ---- split transactions ------------------------------------------------
  // Group by employee + fuzzy vendor + short date window. Flag when the group
  // total crosses the approval threshold but no single row in it does.
  const remaining = rows.filter((r) => r.amount != null && r.date);
  const used = new Set();
  for (let i = 0; i < remaining.length; i++) {
    if (used.has(remaining[i].txnId)) continue;
    const seed = remaining[i];
    const group = [seed];
    for (let j = i + 1; j < remaining.length; j++) {
      const cand = remaining[j];
      if (used.has(cand.txnId)) continue;
      if (cand.employee !== seed.employee) continue;
      const gap = Math.abs(daysBetween(seed.date, cand.date) ?? 999);
      if (gap > policy.splitWindowDays) continue;
      if (vendorSimilarity(seed.vendor, cand.vendor) < 0.8) continue;
      group.push(cand);
    }
    if (group.length < 2) continue;
    const sum = round2(group.reduce((s, g) => s + g.amount, 0));
    const anySingleOver = group.some((g) => g.amount > policy.approvalThreshold);
    if (sum > policy.approvalThreshold && !anySingleOver) {
      const ids = group.map((g) => g.txnId);
      for (const r of group) {
        used.add(r.txnId);
        add(r.txnId, finding('SPLIT_TRANSACTION', SEVERITY.HARD,
          `${group.length} charges by ${seed.employee} at "${seed.vendor}" within ${policy.splitWindowDays} days ` +
          `total ${sum.toFixed(2)}, above the ${policy.approvalThreshold.toFixed(2)} approval threshold, ` +
          `while no single charge crosses it. Rows: ${ids.join(', ')}.`,
          { rows: ids, groupTotal: sum, threshold: policy.approvalThreshold }));
      }
    }
  }

  return byTxn;
}

// --------------------------------------------------------------------------

/** Run every check and return one result per row, in input order. */
export function auditAll(rows, extractions, policy = DEFAULT_POLICY) {
  const batch = checkBatch(rows, policy);
  return rows.map((row) => {
    const ext = extractions.get(row.txnId) ?? null;
    const findings = [...checkRow(row, ext, policy), ...(batch.get(row.txnId) || [])];
    const hard = findings.filter((f) => f.severity === SEVERITY.HARD);
    const soft = findings.filter((f) => f.severity === SEVERITY.SOFT);
    return {
      row,
      extraction: ext,
      findings,
      status: hard.length ? 'exception' : soft.length ? 'needs-review' : 'clean',
      hardCount: hard.length,
      softCount: soft.length,
    };
  });
}
