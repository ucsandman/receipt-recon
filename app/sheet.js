// Spreadsheet intake: header mapping and value normalization.
//
// These are pure functions, deliberately kept out of main.js. main.js imports
// pdf.min.mjs and calls init() at load, so nothing in it can be reached from a
// node test. That is why roughly forty lines that decide the fate of every row
// in the report had no unit coverage at all. They live here now so they can be
// tested directly.

// Header names differ between expense systems. Match on intent, not on an
// exact string, so a report exported from a different tool still works.
export const COLUMN_ALIASES = {
  txnId:      ['txn id', 'txn', 'transaction id', 'id', 'ref', 'reference', 'expense id', 'line'],
  employee:   ['employee', 'name', 'submitted by', 'claimant', 'staff', 'user'],
  date:       ['date', 'transaction date', 'expense date', 'txn date'],
  vendor:     ['vendor', 'merchant', 'supplier', 'payee', 'description'],
  category:   ['category', 'expense type', 'type', 'account'],
  amount:     ['amount', 'total', 'value', 'claimed', 'gross'],
  currency:   ['currency', 'ccy', 'cur'],
  receiptFile:['receipt file', 'receipt', 'attachment', 'file', 'document', 'support'],
  purpose:    ['business purpose', 'purpose', 'notes', 'justification', 'memo'],
  approver:   ['approver', 'approved by', 'manager'],
};

export function mapHeaders(header) {
  const norm = header.map((h) => String(h ?? '').trim().toLowerCase());
  const map = {};
  const claimed = new Set();
  const fields = Object.entries(COLUMN_ALIASES);

  // Every exact match binds before ANY substring fallback runs, and a bound
  // column is claimed. Without this, a header like 'Receipt Amount' — which
  // contains both the amount alias 'amount' and the receiptFile alias
  // 'receipt' — let one column feed two fields, and the guess that lost was
  // invisible: every row just came out UNREADABLE_RECEIPT. Field order in
  // COLUMN_ALIASES settles a contested exact tie, deterministically.
  for (const [field, aliases] of fields) {
    const idx = norm.findIndex((h, i) => !claimed.has(i) && aliases.includes(h));
    if (idx !== -1) { map[field] = idx; claimed.add(idx); }
  }
  for (const [field, aliases] of fields) {
    if (map[field] !== undefined) continue;
    const idx = norm.findIndex((h, i) =>
      !claimed.has(i) && h && aliases.some((a) => h.includes(a)));
    if (idx !== -1) { map[field] = idx; claimed.add(idx); }
  }
  return map;
}

/** Which sheet of a workbook is the transaction table.
 *
 *  Real workbooks put a cover sheet first, and reading SheetNames[0] blindly
 *  either failed the import or audited the cover sheet. A sheet qualifies only
 *  if its first row maps to an amount column; among qualifiers, the one whose
 *  header maps the most transaction fields wins, and a tie keeps workbook
 *  order. Returns -1 when no sheet qualifies. */
export function pickTransactionSheet(sheets) {
  let best = -1, bestScore = 0;
  sheets.forEach((s, i) => {
    const map = mapHeaders(s.aoa?.[0] ?? []);
    if (map.amount === undefined) return;
    const score = Object.keys(map).length;
    if (score > bestScore) { best = i; bestScore = score; }
  });
  return best;
}

export function excelSerialToISO(n) {
  // Excel day 0 is 1899-12-30 (Lotus leap-year bug included, on purpose).
  const ms = Math.round((n - 25569) * 86400000);
  return new Date(ms).toISOString().slice(0, 10);
}

const MONTH_NAMES = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const monthNum = (word) => MONTH_NAMES[String(word).slice(0, 3).toLowerCase()];

/** Sheet dates to YYYY-MM-DD.
 *
 *  Every accepted format is parsed by hand. There is deliberately no
 *  `new Date(s)` fallback. The ambient parser resolves a spelled-out date like
 *  "July 2, 2026" in LOCAL time, so calling .toISOString() on it moves the day
 *  backwards for any auditor east of UTC: that exact input returned 2026-07-01
 *  in UTC+14 and 2026-07-02 in UTC-11. row.date is hashed material in
 *  report.js runHash, which made the reproducible run hash depend on the
 *  machine the audit ran on, and reproducibility is the one thing this tool
 *  offers that a model cannot.
 *
 *  A format that is not recognised returns null, and the row is then reported
 *  as missing a date. That is honest. Silently off by one is not. */
export function normalizeDate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return excelSerialToISO(v);
  const s = String(v).trim();

  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return iso(m[1], +m[2], +m[3]);

  m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
  if (m) {
    let mo = +m[1], da = +m[2];
    if (mo > 12) { mo = +m[2]; da = +m[1]; }
    return iso(m[3], mo, da);
  }

  // "July 2, 2026", "Jul 2 2026", "July 2nd, 2026".
  m = s.match(/^([A-Za-z]{3,})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/);
  if (m && monthNum(m[1])) return iso(m[3], monthNum(m[1]), +m[2]);

  // "2 July 2026", "2-Jul-2026", "02 JUL 2026".
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]{3,})\.?[\s,-]+(\d{4})$/);
  if (m && monthNum(m[2])) return iso(m[3], monthNum(m[2]), +m[1]);

  return null;
}

export function toNumber(v) {
  if (typeof v === 'number') return v;
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}
