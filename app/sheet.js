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
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    let idx = norm.findIndex((h) => aliases.includes(h));
    if (idx === -1) idx = norm.findIndex((h) => h && aliases.some((a) => h.includes(a)));
    if (idx !== -1) map[field] = idx;
  }
  return map;
}

export function excelSerialToISO(n) {
  // Excel day 0 is 1899-12-30 (Lotus leap-year bug included, on purpose).
  const ms = Math.round((n - 25569) * 86400000);
  return new Date(ms).toISOString().slice(0, 10);
}

export function normalizeDate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return excelSerialToISO(v);
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
  if (m) {
    let mo = +m[1], da = +m[2];
    if (mo > 12) { mo = +m[2]; da = +m[1]; }
    return `${m[3]}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export function toNumber(v) {
  if (typeof v === 'number') return v;
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}
