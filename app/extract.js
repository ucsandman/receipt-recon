// Receipt field extraction.
//
// The ladder, cheapest tier first. Measured on the bundled sample set:
//   Tier 1  PDF text layer   33/37 receipts, exact, ~5ms each
//   Tier 2  WASM OCR          4/37 receipts, exact, ~460ms each
//   Tier 3  give up loudly    0/37, flagged for a human
//
// Tier 3 is a feature. An audit tool that guesses when it cannot read a
// document is worse than one that says "read this one yourself".

export const CURRENCY_SYMBOLS = { $: 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR', '₩': 'KRW', '₪': 'ILS', '₫': 'VND', '₺': 'TRY', '₱': 'PHP' };

// The old list was twelve codes. Anything outside it returned null, and because
// CURRENCY_MISMATCH is gated on a parsed currency, an SGD or ZAR receipt raised
// no currency finding at all while the amount check above it still compared the
// claimed number against the receipt total as if they were the same unit.
export const CURRENCY_CODES = [
  'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'JPY', 'CHF', 'SEK', 'NOK', 'DKK',
  'MXN', 'INR', 'SGD', 'HKD', 'CNY', 'KRW', 'TWD', 'THB', 'MYR', 'IDR', 'PHP',
  'VND', 'ZAR', 'BRL', 'ARS', 'CLP', 'COP', 'PEN', 'PLN', 'CZK', 'HUF', 'RON',
  'BGN', 'ISK', 'TRY', 'ILS', 'AED', 'SAR', 'QAR', 'KWD', 'EGP', 'NGN', 'KES',
  'PKR', 'BDT', 'LKR', 'RUB', 'UAH',
];

// Order matters: longest alternates first, so "TOTAL DUE" is not shadowed by
// a bare "TOTAL". The \b is load-bearing -- without it, a case-insensitive
// "TOTAL" matches inside "Subtotal" and the parser silently returns the
// subtotal. See docs/ERRORS.md.
const TOTAL_LABELS = [
  'GRAND\\s*TOTAL', 'TOTAL\\s*DUE', 'TOTAL\\s*FARE', 'TOTAL\\s*AMOUNT',
  'BALANCE\\s*DUE', 'AMOUNT\\s*DUE', 'AMOUNT\\s*PAID', 'TOTAL\\s*CHARGE',
  'TOTAL',
];
const AMOUNT = '([\\-\\u2212]?[\\d,]+\\.\\d{2})';
const RE_TOTAL = new RegExp(
  `\\b(?:${TOTAL_LABELS.join('|')})\\b\\s*:?\\s*[$\\u20AC\\u00A3\\u00A5]?\\s*${AMOUNT}`, 'i');
const RE_SUBTOTAL = new RegExp(`\\bSUB\\s*-?\\s*TOTAL\\b\\s*:?\\s*[$\\u20AC\\u00A3\\u00A5]?\\s*${AMOUNT}`, 'i');
const RE_TAX = new RegExp(`\\b(?:SALES\\s*TAX|VAT(?:\\s*\\d+%)?|GST|HST|TAX)\\b\\s*:?\\s*[$\\u20AC\\u00A3\\u00A5]?\\s*${AMOUNT}`, 'i');
const RE_TIP = new RegExp(`\\b(?:TIP|GRATUITY|SERVICE\\s*CHARGE)\\b\\s*:?\\s*[$\\u20AC\\u00A3\\u00A5]?\\s*${AMOUNT}`, 'i');
const RE_MONEY_ANY = /[$€£¥]\s?([\d,]+\.\d{2})/g;

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function num(s) {
  if (s == null) return null;
  const v = parseFloat(String(s).replace(/,/g, '').replace(/−/g, '-'));
  return Number.isFinite(v) ? v : null;
}

function firstMatch(re, text) {
  const m = text.match(re);
  return m ? num(m[1]) : null;
}

/** Total, with a guard against the subtotal trap and a last-resort fallback. */
function parseTotal(text) {
  const labelled = firstMatch(RE_TOTAL, text);
  if (labelled !== null) return { value: labelled, basis: 'labelled' };

  // No total label at all (common on rideshare and minimal receipts).
  // Fall back to the largest money figure on the page, but say so, because
  // "largest number wins" is a guess and the auditor deserves to know.
  // reduce, not Math.max(...all): a receipt carrying six figures of money
  // matches spreads that wide over the argument stack and throws a RangeError.
  // Because parseFields runs outside extractReceipt's try, that escaped and
  // took down the whole run rather than this one row.
  let best = null;
  for (const m of text.matchAll(RE_MONEY_ANY)) {
    const v = num(m[1]);
    if (v !== null && (best === null || v > best)) best = v;
  }
  if (best !== null) return { value: best, basis: 'largest-figure-guess' };
  return { value: null, basis: 'none' };
}

const RE_CODE_NEAR_NUMBER = new RegExp(
  `\\b(${CURRENCY_CODES.join('|')})\\b\\s*[\\d]|[\\d]\\s*\\b(${CURRENCY_CODES.join('|')})\\b`);

function parseCurrency(text) {
  // A code sitting next to a number is how a currency actually appears on a
  // receipt. Matching a bare code anywhere would let "PLEASE TRY OUR APP" book
  // the row as Turkish lira, and the wider code list above makes that likelier.
  const near = text.match(RE_CODE_NEAR_NUMBER);
  if (near) return near[1] || near[2];
  for (const [sym, cur] of Object.entries(CURRENCY_SYMBOLS)) {
    if (text.includes(sym)) return cur;
  }
  // A VAT line and an EU address strongly imply a euro invoice even when the
  // symbol was mangled by OCR.
  if (/\bVAT\b/i.test(text) && /\b(NL|DE|FR|IE|ES|IT|BE)\s?\d/i.test(text)) return 'EUR';
  return null;
}

/** Dates in the wild: 07/02/2026, 2026-07-02, 02 JUL 2026, July 2, 2026. */
function parseDate(text) {
  let m = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  m = text.match(/\b(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})\b/);
  if (m) {
    let [, a, b, y] = m;
    // Ambiguous: 03/04/2026. Assume US month-first unless the first field
    // cannot be a month. Flagged as ambiguous by the caller.
    let mo = +a, da = +b;
    if (mo > 12) { mo = +b; da = +a; }
    return `${y}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`;
  }

  m = text.match(/\b(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{4})\b/);
  if (m && MONTHS[m[2].toLowerCase()]) {
    return `${m[3]}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, '0')}-${String(+m[1]).padStart(2, '0')}`;
  }

  m = text.match(/\b([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/);
  if (m && MONTHS[m[1].toLowerCase()]) {
    return `${m[3]}-${String(MONTHS[m[1].toLowerCase()]).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}`;
  }
  return null;
}

const VENDOR_NOISE = /^(invoice|receipt|statement|tax\s*invoice|guest\s*folio|electronic\s*ticket|thank\s*you|customer\s*copy|merchant\s*copy)\b/i;

/** Vendor name: the first substantive line that is not boilerplate, an address,
 *  a date, or a number. Crude on purpose -- the rules engine compares it
 *  fuzzily, and a wrong guess surfaces as a reviewable exception, not a
 *  silent pass. */
function parseVendor(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const line of lines.slice(0, 8)) {
    if (line.length < 3 || line.length > 60) continue;
    if (VENDOR_NOISE.test(line)) continue;
    if (/\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/.test(line)) continue;   // phone
    if (/\b\d{5}(-\d{4})?\b/.test(line)) continue;              // zip
    if (/^\d/.test(line)) continue;                             // street number
    if (/[$€£]/.test(line)) continue;                 // money
    if (parseDate(line)) continue;
    const letters = (line.match(/[A-Za-z]/g) || []).length;
    if (letters < line.length * 0.5) continue;
    // OCR often merges the header row, so "Nordvane Analytics BV" and the word
    // "INVOICE" arrive as one line. Strip that trailing boilerplate.
    return line
      .replace(/\s+(invoice|receipt|statement|tax\s*invoice|bill)\s*$/i, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }
  return lines[0] || null;
}

function parseFields(text) {
  const flat = text.replace(/[ \t]+/g, ' ');
  const total = parseTotal(flat);
  const subtotal = firstMatch(RE_SUBTOTAL, flat);
  const tax = firstMatch(RE_TAX, flat);
  const tip = firstMatch(RE_TIP, flat);
  const warnings = [];

  if (total.basis === 'largest-figure-guess') {
    warnings.push('No total label found; used the largest figure on the page.');
  }
  if (total.basis === 'none') warnings.push('No monetary amount found at all.');

  // Arithmetic self-check. If the parts do not add up to the total, one of the
  // numbers was misread, and the auditor needs to know before trusting the row.
  if (total.value !== null && subtotal !== null) {
    const parts = subtotal + (tax || 0) + (tip || 0);
    if (Math.abs(parts - total.value) > 0.02) {
      warnings.push(
        `Receipt does not foot: subtotal ${subtotal.toFixed(2)} + tax ${(tax || 0).toFixed(2)} ` +
        `+ tip ${(tip || 0).toFixed(2)} = ${parts.toFixed(2)}, but total reads ${total.value.toFixed(2)}.`);
    }
  }

  return {
    total: total.value,
    totalBasis: total.basis,
    subtotal, tax, tip,
    currency: parseCurrency(flat),
    date: parseDate(flat),
    vendor: parseVendor(text),
    warnings,
  };
}

// --------------------------------------------------------------------------
// Tier 1: PDF text layer
// --------------------------------------------------------------------------

async function readTextLayer(pdfjsLib, bytes) {
  const task = pdfjsLib.getDocument({ data: bytes, useSystemFonts: true, isEvalSupported: false });
  const doc = await task.promise;
  let text = '';
  const pages = Math.min(doc.numPages, 10); // hotel folios can run long; 10 is plenty
  for (let i = 1; i <= pages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    // Rebuild line structure from glyph coordinates. Joining items blindly
    // destroys the "LABEL: value" adjacency the parsers rely on.
    let lastY = null;
    for (const item of tc.items) {
      const y = item.transform[5];
      if (lastY !== null && Math.abs(y - lastY) > 2) text += '\n';
      else if (text && !text.endsWith(' ') && !text.endsWith('\n')) text += ' ';
      text += item.str;
      lastY = y;
    }
    text += '\n';
  }
  return { text, doc, task, numPages: doc.numPages };
}

// --------------------------------------------------------------------------
// Tier 2: render the page and OCR it
// --------------------------------------------------------------------------

export const OCR_SCALE = 3.0;

// Roughly 160 MB of RGBA backing store. A US Letter page at 3.0x is 4.4M px, so
// every real receipt renders untouched and only an absurd page box is clamped.
export const MAX_RASTER_PX = 40_000_000;

/** The scale to actually render at.
 *
 *  A PDF may declare a page box up to 14400x14400 pt. At a fixed 3.0x that is
 *  43200x43200 px, about 7.5 GB. The dangerous outcome is not the crash: it is
 *  a blank canvas, which OCR then reads as nothing, which parseFields reports
 *  as "no monetary amount found", which looks like a real result. */
export function clampScale(width, height, desired = OCR_SCALE) {
  const area = width * height;
  if (!(area > 0)) return desired;
  return Math.min(desired, Math.sqrt(MAX_RASTER_PX / area));
}

async function renderToCanvas(doc, desired = OCR_SCALE) {
  const page = await doc.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const scale = clampScale(base.width, base.height, desired);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvasContext: canvas.getContext('2d', { willReadFrequently: true }), viewport, canvas }).promise;
  return { canvas, scale, downscaled: scale < desired };
}

// --------------------------------------------------------------------------

const MIN_TEXT_CHARS = 20;  // below this, treat the PDF as image-only

/**
 * @param {Uint8Array} bytes      the PDF
 * @param {object} deps           { pdfjsLib, getOcrWorker }
 *        getOcrWorker is async and lazy: the 9.5MB OCR bundle is only fetched
 *        the first time a scan-only receipt actually shows up.
 */
export async function extractReceipt(bytes, deps) {
  const { pdfjsLib, getOcrWorker } = deps;
  let handle = null;
  try {
    handle = await readTextLayer(pdfjsLib, bytes);
  } catch (err) {
    return {
      tier: 'failed', confidence: 0, text: '',
      fields: { warnings: [] },
      error: `PDF could not be opened: ${err.message}`,
    };
  }

  const { text, doc, task, numPages } = handle;

  if (text.replace(/\s/g, '').length >= MIN_TEXT_CHARS) {
    const fields = parseFields(text);
    await task.destroy();
    return { tier: 'text', confidence: 100, text, numPages, fields };
  }

  // Image-only PDF. Escalate.
  if (!getOcrWorker) {
    await task.destroy();
    return {
      tier: 'failed', confidence: 0, text: '', numPages,
      fields: { warnings: ['Image-only PDF and OCR is disabled.'] },
      error: 'Image-only PDF; OCR disabled.',
    };
  }

  try {
    const { canvas, scale, downscaled } = await renderToCanvas(doc);
    const worker = await getOcrWorker();
    const { data } = await worker.recognize(canvas);
    canvas.width = canvas.height = 0; // release the bitmap promptly
    await task.destroy();

    const fields = parseFields(data.text);
    if (downscaled) {
      // rules.js turns any string in fields.warnings into a visible SOFT
      // EXTRACTION_WARNING, so a degraded read is never mistaken for a clean one.
      fields.warnings.push(
        `Receipt page is unusually large, so it was rendered at ${scale.toFixed(2)}x instead of ` +
        `${OCR_SCALE.toFixed(2)}x to stay within a safe canvas size. Text may have been harder to read.`);
    }
    if (data.confidence < 70) {
      fields.warnings.push(
        `Low OCR confidence (${data.confidence.toFixed(0)}%). Verify this receipt by hand.`);
    }
    return { tier: 'ocr', confidence: data.confidence, text: data.text, numPages, fields };
  } catch (err) {
    await task.destroy();
    return {
      tier: 'failed', confidence: 0, text: '', numPages,
      fields: { warnings: [] },
      error: `OCR failed: ${err.message}`,
    };
  }
}

export const __test__ = { parseFields, parseTotal, parseDate, parseVendor, parseCurrency };
