// UI wiring.
//
// Everything here runs in the page. There is no server, no upload, no API key.
// The only network requests this app ever makes are for its own files in
// vendor/, and those are same-origin. A watchdog below proves that claim
// rather than just asserting it.

import * as pdfjsLib from '../vendor/pdf.min.mjs';
import { extractReceipt, extractReceiptImage, clampScale, IMAGE_EXTENSIONS } from './extract.js';
import { mapHeaders, normalizeDate, toNumber, pickTransactionSheet } from './sheet.js';
import { auditAll, sanitizePolicy, DEFAULT_POLICY } from './rules.js';
import { parseBudgetSheet, pickBudgetSheet, reconcileBudget, fxView } from './budget.js';
import { parseStatement, pickStatementSheet, reconcileStatement } from './statement.js';
import { buildWorkbook, downloadWorkbook, runHash, sumsByCurrency } from './report.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;

const $ = (id) => document.getElementById(id);
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const state = {
  sheetFile: null,
  receipts: new Map(),   // lowercased filename -> File
  rows: [],
  results: [],
  sheets: [],            // every sheet of the workbook, as {name, aoa}
  txnSheetIndex: -1,
  columnMap: null,       // field -> column index, user-correctable
  budgetSheetIndex: -1,  // -1 means no budget sheet in play
  budgetEntries: null,
  budgetRecon: null,
  stmtRows: null,        // parsed card-statement charges, or null
  stmtInfo: null,        // { fileName, sheetName, skipped }
  stmtRecon: null,       // reconcileStatement() output for the last run
  policy: structuredClone(DEFAULT_POLICY),
  filter: 'all',
  sort: { key: null, dir: 1 },
  selectedTxn: null,
  lastTrigger: null,     // element focus returns to when the panel closes
  panelToken: 0,         // guards against a slow PDF render landing in a newer panel
  panelTask: null,       // the open drawer's PDF, kept alive for page navigation
  panelImgUrl: null,     // the open drawer's photo object URL, revoked on close
  ocrWorker: null,
  ocrUsed: 0,
  reportName: '',
  // Reviewer decisions, keyed `${txnId}::${code}`. NEVER hash material: the
  // hash proves what was audited, and a human's verdict is not an input to
  // that. Survives re-running the audit; persists only as an explicit file.
  reviews: new Map(),
};

// --------------------------------------------------------------------------
// Prove the privacy claim instead of just printing it.
//
// Wrap fetch and XHR. Same-origin requests for our own assets are expected.
// Anything else flips the badge to a warning, so a sceptical user can watch
// the tool contradict itself if it ever tries to phone home.
// --------------------------------------------------------------------------
(function installNetworkWatchdog() {
  const sameOrigin = (u) => {
    try { return new URL(u, location.href).origin === location.origin; }
    catch { return false; }
  };
  const trip = (url) => {
    const badge = $('netBadge');
    badge.classList.add('tripped');
    $('netBadgeText').textContent = `External request: ${url}`;
    console.warn('[receipt-recon] unexpected external request', url);
  };
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input?.url ?? '';
    if (!sameOrigin(url)) trip(url);
    return origFetch.call(this, input, init);
  };
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (!sameOrigin(url)) trip(url);
    return origOpen.call(this, method, url, ...rest);
  };
})();

// --------------------------------------------------------------------------
// OCR, lazily. The engine is ~9.5MB, so it is only fetched the first time a
// receipt actually needs it. Most sets never trigger this at all.
// --------------------------------------------------------------------------
async function getOcrWorker() {
  if (state.ocrWorker) return state.ocrWorker;
  $('ocrNote').hidden = false;
  setProgressText('Loading the OCR engine (one time, from this page\'s own files)…');

  if (!window.Tesseract) {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/tesseract.min.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load vendor/tesseract.min.js'));
      document.head.appendChild(s);
    });
  }
  // corePath points at ONE specific core file, not at the directory. Given a
  // directory, tesseract.js probes for whichever variant the browser supports
  // and will ask for files we do not ship (it wanted the relaxed-SIMD build).
  // Pinning the SIMD LSTM core keeps the bundle to a single 3.7MB file that
  // every browser since Chrome 91 / Firefox 89 / Safari 16.4 can run.
  state.ocrWorker = await window.Tesseract.createWorker('eng', 1, {
    workerPath: 'vendor/tesseract.worker.min.js',
    corePath: 'vendor/tesseract-core-simd-lstm.wasm.js',
    langPath: 'vendor/',
  });
  return state.ocrWorker;
}

// --------------------------------------------------------------------------
// Spreadsheet reading
// --------------------------------------------------------------------------

async function readWorkbook(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  return wb.SheetNames.map((name) => ({
    name,
    aoa: XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, blankrows: false }),
  }));
}

function rowsFromSheet(aoa, map) {
  if (!aoa.length) throw new Error('That sheet has no rows.');

  if (map.amount === undefined) {
    throw new Error('Could not find an amount column on that sheet. Expected a header like "Amount" or "Total".');
  }
  const pick = (r, f) => (map[f] === undefined ? null : r[map[f]] ?? null);

  return aoa.slice(1)
    .filter((r) => r.some((c) => c !== null && c !== undefined && c !== ''))
    .map((r, i) => ({
      txnId: String(pick(r, 'txnId') ?? `Row ${i + 2}`),
      employee: pick(r, 'employee') ?? '',
      date: normalizeDate(pick(r, 'date')),
      vendor: pick(r, 'vendor') ?? '',
      category: pick(r, 'category') ?? '',
      amount: toNumber(pick(r, 'amount')),
      currency: (pick(r, 'currency') ?? 'USD') || 'USD',
      receiptFile: (pick(r, 'receiptFile') ?? '') || null,
      purpose: pick(r, 'purpose') ?? '',
      approver: pick(r, 'approver') ?? '',
    }));
}

// --------------------------------------------------------------------------
// Column mapping: visible, correctable, remembered.
//
// Which column feeds which field used to be decided silently by mapHeaders and
// the only fix for a bad guess was renaming headers in the source file — which
// a non-developer auditor has no reason to suspect. The mapping now renders as
// a disclosure of selects, and a correction is remembered on this computer,
// keyed on the exact header row, so a monthly export is fixed once.
// --------------------------------------------------------------------------

const MAP_FIELDS = [
  ['txnId', 'Transaction id'],
  ['employee', 'Employee'],
  ['date', 'Date'],
  ['vendor', 'Vendor'],
  ['category', 'Category'],
  ['amount', 'Amount'],
  ['currency', 'Currency'],
  ['receiptFile', 'Receipt file'],
  ['purpose', 'Business purpose'],
  ['approver', 'Approver'],
];

const COLMAP_KEY = 'receipt-recon-colmap';
const COLMAP_MAX = 20;

const headerSignature = (header) =>
  JSON.stringify(header.map((h) => String(h ?? '').trim().toLowerCase()));

function rememberedMap(header) {
  try {
    const list = JSON.parse(localStorage.getItem(COLMAP_KEY) || '[]');
    const hit = list.find(([sig]) => sig === headerSignature(header));
    return hit ? { ...hit[1] } : null;
  } catch { return null; }
}

function rememberMap(header, map) {
  try {
    const sig = headerSignature(header);
    const list = JSON.parse(localStorage.getItem(COLMAP_KEY) || '[]')
      .filter(([s]) => s !== sig);
    list.unshift([sig, map]);
    localStorage.setItem(COLMAP_KEY, JSON.stringify(list.slice(0, COLMAP_MAX)));
  } catch { /* storage blocked by policy */ }
}

/** Spreadsheet-style column letter: 0 -> A, 26 -> AA. */
function colLetter(i) {
  let s = '';
  let n = i + 1;
  while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
  return s;
}

function renderColumnMap() {
  const box = $('colMap');
  if (state.txnSheetIndex < 0 || !state.columnMap) { box.hidden = true; return; }
  const header = state.sheets[state.txnSheetIndex].aoa[0] || [];

  $('colMapGrid').innerHTML = MAP_FIELDS.map(([field, label]) => {
    const bound = state.columnMap[field];
    const opts = [`<option value="-1"${bound === undefined ? ' selected' : ''}>Not in this sheet</option>`]
      .concat(header.map((h, i) =>
        `<option value="${i}"${i === bound ? ' selected' : ''}>${colLetter(i)} — ${esc(String(h ?? '').trim() || '(blank)')}</option>`));
    return `<div class="colmap-item">
      <label for="cm_${field}">${label}</label>
      <select id="cm_${field}" data-field="${field}">${opts.join('')}</select>
    </div>`;
  }).join('');

  for (const sel of $('colMapGrid').querySelectorAll('select[data-field]')) {
    sel.addEventListener('change', (e) => {
      const field = e.target.dataset.field;
      const idx = Number(e.target.value);
      if (idx === -1) delete state.columnMap[field];
      else state.columnMap[field] = idx;
      applyColumnMap();
    });
  }
  box.hidden = false;
}

/** Re-derive the rows from the current mapping and say what happened. */
function applyColumnMap() {
  const aoa = state.sheets[state.txnSheetIndex].aoa;
  if (state.columnMap.amount === undefined) {
    state.rows = [];
    showBanner('Pick a column for Amount. The audit cannot run without one.');
    updateRunButton();
    return;
  }
  state.rows = rowsFromSheet(aoa, state.columnMap);
  rememberMap(aoa[0], state.columnMap);
  clearBanner();
  paintSheetStatus();
  updateRunButton();
}

// --------------------------------------------------------------------------
// Running the audit
// --------------------------------------------------------------------------

function setProgress(pct, text) {
  const v = Math.max(0, Math.min(100, pct));
  $('progBar').style.width = `${v}%`;
  $('progBar').parentElement.setAttribute('aria-valuenow', String(Math.round(v)));
  if (text) setProgressText(text);
}
function setProgressText(text) { $('progText').textContent = text; }

/** Screen-reader announcements. Deliberately not wired to every row: a 350-row
 *  run would otherwise queue 350 utterances. Milestones only. */
function announce(msg) { $('srStatus').textContent = msg; }

/** Receipt filenames in the sheet rarely match the folder exactly: extra
 *  paths, different case, a missing .pdf. Resolve generously, then fall back
 *  to matching on the transaction id, which is how most exports name them. */
const RECEIPT_EXTENSIONS = ['.pdf', ...IMAGE_EXTENSIONS];
const isImageFile = (name) => IMAGE_EXTENSIONS.some((e) => name.toLowerCase().endsWith(e));

function resolveReceipt(row) {
  const tries = [];
  if (row.receiptFile) {
    const base = String(row.receiptFile).split(/[\\/]/).pop().toLowerCase();
    tries.push(base);
    // A sheet that omits the extension can mean a PDF or a photo; try both.
    if (!RECEIPT_EXTENSIONS.some((e) => base.endsWith(e))) {
      for (const e of RECEIPT_EXTENSIONS) tries.push(`${base}${e}`);
    } else if (base.endsWith('.pdf')) {
      tries.push(base.slice(0, -4));
    }
  }
  if (row.txnId) {
    for (const e of RECEIPT_EXTENSIONS) tries.push(`${String(row.txnId).toLowerCase()}${e}`);
  }
  for (const t of tries) if (state.receipts.has(t)) return state.receipts.get(t);
  return null;
}

async function runAudit() {
  $('step-progress').hidden = false;
  $('step-results').hidden = true;
  $('btnRun').disabled = true;
  $('btnRun').setAttribute('aria-busy', 'true');
  state.ocrUsed = 0;

  // Whatever happens below, the Run button comes back. Without this, a single
  // unreadable file left the button disabled and the progress bar frozen, with
  // no way back other than reloading the page.
  try {
    const extractions = new Map();
    const total = state.rows.length;
    let done = 0;
    let announcedAt = 0;

    for (const row of state.rows) {
      // One bad file costs one row, not the run.
      //
      // Every row used to sit inside a single try wrapping the whole loop, and
      // its catch never assigned state.results. So one receipt that threw threw
      // away every row already processed, including minutes of OCR, with no
      // partial output and no way to tell which file did it. The failed shape
      // recorded below is the same one the file-not-found branch writes, and
      // rules.js already turns it into a HARD UNREADABLE_RECEIPT naming the row.
      try {
        const file = resolveReceipt(row);
        // The sheet claims a receipt but the folder has no such file. That is a
        // real finding, so record the intent and let the rules engine report it.
        if (!file) {
          if (row.receiptFile) {
            extractions.set(row.txnId, {
              tier: 'failed', confidence: 0, text: '', fields: { warnings: [] },
              error: `File "${row.receiptFile}" was not found among the receipts you loaded.`,
            });
          }
        } else if (isImageFile(file.name)) {
          // A photo has no text layer; it enters the ladder at the OCR tier.
          const res = await extractReceiptImage(file, { getOcrWorker });
          if (res.tier === 'ocr') state.ocrUsed++;
          extractions.set(row.txnId, res);
        } else {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const res = await extractReceipt(bytes, { pdfjsLib, getOcrWorker });
          if (res.tier === 'ocr') state.ocrUsed++;
          extractions.set(row.txnId, res);
        }
      } catch (err) {
        extractions.set(row.txnId, {
          tier: 'failed', confidence: 0, text: '', fields: { warnings: [] },
          error: `This receipt could not be processed: ${err.message}`,
        });
      }

      done++;
      const pct = (done / total) * 100;
      setProgress(pct, `${done} of ${total} rows${state.ocrUsed ? ` · ${state.ocrUsed} needed OCR` : ''}`);
      if (pct - announcedAt >= 25) {
        announcedAt = pct;
        announce(`${done} of ${total} receipts read.`);
      }
      // Yield so the progress bar actually paints during a long run.
      if (done % 3 === 0) await new Promise((r) => setTimeout(r, 0));
    }

    // Statement findings must exist before auditAll so they drive row status.
    state.stmtRecon = state.stmtRows?.length
      ? reconcileStatement(state.rows, state.stmtRows, state.policy)
      : null;
    state.results = auditAll(state.rows, extractions, state.policy,
      state.stmtRecon?.rowFindings ?? null);
    state.budgetRecon = state.budgetEntries
      ? reconcileBudget(state.rows, state.budgetEntries, state.policy)
      : null;
    state.selectedTxn = null;
    setProgress(100, `Done. ${total} rows checked.`);
    renderResults();
    $('step-results').hidden = false;

    const bad = state.results.filter((x) => x.status !== 'clean').length;
    announce(`Audit finished. ${total} rows checked, ${bad} need attention.`);
    $('step-results').scrollIntoView({
      behavior: reduceMotion.matches ? 'auto' : 'smooth',
      block: 'start',
    });
  } catch (err) {
    setProgressText('The audit stopped before it finished.');
    showBanner(`The audit stopped: ${err.message}`);
    announce('The audit stopped before it finished.');
  } finally {
    $('btnRun').removeAttribute('aria-busy');
    updateRunButton();
  }
}

// --------------------------------------------------------------------------
// Rendering
// --------------------------------------------------------------------------

// Cached per currency: building an Intl formatter is not free, and this runs
// once per cell on a 350-row table.
const formatters = new Map();
function money(v, cur) {
  if (v == null || v === '') return '—';
  const code = String(cur || 'USD').toUpperCase();
  if (!formatters.has(code)) {
    let fmt;
    try {
      fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: code });
    } catch {
      fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
    }
    formatters.set(code, fmt);
  }
  return formatters.get(code).format(Number(v));
}

function renderResults() {
  const r = state.results;
  const exception = r.filter((x) => x.status === 'exception').length;
  const review = r.filter((x) => x.status === 'needs-review').length;
  const clean = r.filter((x) => x.status === 'clean').length;
  // Per currency: adding euro and dollar figures into one number labelled USD
  // was simply false on a multi-currency report.
  const flagged = sumsByCurrency(r, (x) => x.status !== 'clean');
  const flaggedHtml = flagged.length
    ? flagged.map(([cur, v]) => money(v, cur)).join('<br>')
    : money(0, 'USD');

  $('tiles').innerHTML = `
    <div class="tile"><div class="n">${r.length}</div><div class="k">Transactions checked</div></div>
    <div class="tile hard"><div class="n">${exception}</div><div class="k">Exceptions</div></div>
    <div class="tile soft"><div class="n">${review}</div><div class="k">Needs review</div></div>
    <div class="tile clean"><div class="n">${clean}</div><div class="k">Clean</div></div>
    <div class="tile"><div class="n${flagged.length > 1 ? ' n-multi' : ''}">${flaggedHtml}</div><div class="k">Value flagged</div></div>`;

  renderBudget();
  renderStatement();
  renderRows();
  updateReviewProgress();
}

function renderStatement() {
  const card = $('stmtCard');
  if (!state.stmtRecon) { card.hidden = true; return; }
  const { matchedCount, unclaimed, notOnStatement } = state.stmtRecon;
  const bits = [`${matchedCount} charge${matchedCount === 1 ? '' : 's'} matched to expense rows`];
  if (notOnStatement.length) {
    bits.push(`${notOnStatement.length} expense row${notOnStatement.length === 1 ? '' : 's'} with no matching charge (flagged in the table below as CLAIMED_NOT_ON_STATEMENT)`);
  }
  if (!unclaimed.length) bits.push('every statement charge is accounted for');
  $('stmtMeta').textContent = `From “${state.stmtInfo?.fileName ?? 'statement'}”. ${bits.join(' · ')}.`;

  $('stmtBody').innerHTML = unclaimed.map((s) => `<tr>
      <td class="mono">${s.line}</td>
      <td class="mono">${esc(s.date)}</td>
      <td>${esc(s.description || '(no description)')}</td>
      <td class="right">${money(s.amount, s.currency || 'USD')}</td>
      <td><span class="pill exception">Never expensed</span></td>
    </tr>`).join('');
  $('stmtTableWrap').hidden = unclaimed.length === 0;
  card.hidden = false;
}

// Budget statuses map onto the row-status colours: over budget is an
// exception, unverified needs a human, within budget is clean.
const BUDGET_BADGE = {
  ok: ['clean', 'Within budget'],
  over: ['exception', 'Over budget'],
  unspent: ['', 'Unspent'],
  unverified: ['needs-review', 'Unverified'],
};

function renderBudget() {
  const card = $('budgetCard');
  if (!state.budgetRecon) { card.hidden = true; return; }
  const { lines, findings } = state.budgetRecon;
  const cell = (v, cur) => v == null ? '—' : cur ? money(v, cur) : Number(v).toFixed(2);

  $('budgetBody').innerHTML = lines.map((l) => {
    const [cls, label] = BUDGET_BADGE[l.status] ?? ['', l.status];
    return `<tr>
      <td>${esc(l.label)}</td>
      <td class="mono">${esc(l.currency ?? '—')}</td>
      <td class="right">${cell(l.budget, l.currency)}</td>
      <td class="right">${cell(l.actual, l.currency)}</td>
      <td class="right">${cell(l.delta, l.currency)}</td>
      <td><span class="pill ${cls}">${label}</span></td>
    </tr>`;
  }).join('');

  $('budgetFindings').innerHTML = findings.map((f) => `
    <div class="finding ${esc(f.severity)}">
      <div class="finding-head">
        <span class="code">${esc(f.code)}</span>
        <span class="finding-sev">${f.severity === 'hard' ? 'Exception' : 'Needs review'}</span>
      </div>
      <p class="finding-msg">${esc(f.message)}</p>
    </div>`).join('');

  const sheetName = state.budgetSheetIndex >= 0 ? state.sheets[state.budgetSheetIndex].name : '';
  $('budgetMeta').textContent =
    `Read from sheet “${sheetName}”. Each line is compared only to spend in its own currency; nothing was converted.`;

  // The one labelled exception: an orientation view at rates the user typed.
  const fx = fxView(lines, state.policy);
  const fxBox = $('budgetFx');
  if (fx) {
    fxBox.innerHTML = `
      <h4>At your stated rates</h4>
      <p class="microcopy">${fx.rates.length
        ? fx.rates.map(([c, r]) => `1 ${esc(c)} = ${r} ${esc(fx.base)}`).join(' · ')
        : `every line is already in ${esc(fx.base)}`}</p>
      <p class="budgetfx-totals">Budget ≈ ${money(fx.totals.budget, fx.base)} ·
        Spent ≈ ${money(fx.totals.actual, fx.base)} ·
        Difference ${money(fx.totals.delta, fx.base)}</p>
      ${fx.missingRates.length ? `<p class="microcopy">No rate entered for ${fx.missingRates.map(esc).join(', ')}, so those lines are not in this estimate.</p>` : ''}
      ${fx.excluded.length ? `<p class="microcopy">Left out (no stated currency): ${fx.excluded.map(esc).join(', ')}.</p>` : ''}
      <p class="microcopy">Estimate only, converted at rates you entered by hand.
        Every finding above compares within one currency; nothing was converted there.</p>`;
    fxBox.hidden = false;
  } else {
    fxBox.hidden = true;
    fxBox.innerHTML = '';
  }
  card.hidden = false;
}

// Sort accessors. Anything blank sorts last in BOTH directions: a missing
// amount is not "the smallest amount", and burying real rows under blanks on
// a descending sort is exactly the wrong thing for an auditor scanning.
const SORT_KEYS = {
  txn:      (r) => r.row.txnId,
  date:     (r) => r.row.date,
  vendor:   (r) => r.row.vendor,
  category: (r) => r.row.category,
  claimed:  (r) => r.row.amount,
  receipt:  (r) => r.extraction?.fields?.total,
  readby:   (r) => (!r.extraction ? 4 : ({ text: 0, ocr: 1, failed: 2 })[r.extraction.tier] ?? 3),
  status:   (r) => ({ exception: 0, 'needs-review': 1, clean: 2 })[r.status] ?? 3,
};

function compareBy(key, dir) {
  const get = SORT_KEYS[key];
  return (a, b) => {
    const x = get(a), y = get(b);
    const xBlank = x == null || x === '';
    const yBlank = y == null || y === '';
    if (xBlank || yBlank) return xBlank && yBlank ? 0 : xBlank ? 1 : -1;
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
    return String(x).localeCompare(String(y), 'en', { numeric: true, sensitivity: 'base' }) * dir;
  };
}

// Unsorted -> ascending -> descending -> unsorted. The third state matters
// here: unsorted is the order the report was submitted in, which is itself
// information an auditor wants to get back to.
function toggleSort(key) {
  const s = state.sort;
  if (s.key !== key) { s.key = key; s.dir = 1; }
  else if (s.dir === 1) { s.dir = -1; }
  else { s.key = null; s.dir = 1; }
  renderRows();
}

function paintSortHeaders() {
  for (const btn of document.querySelectorAll('.th-sort')) {
    const th = btn.closest('th');
    const ind = btn.querySelector('.sort-ind');
    if (state.sort.key === btn.dataset.sort) {
      th.setAttribute('aria-sort', state.sort.dir === 1 ? 'ascending' : 'descending');
      ind.textContent = state.sort.dir === 1 ? '↑' : '↓';
    } else {
      th.removeAttribute('aria-sort');
      ind.textContent = '↕';
    }
  }
}

const EMPTY_COPY = {
  all: 'No rows to show yet. Load an expense report, then run the audit.',
  exception: 'No exceptions. Every row matched its receipt and cleared policy.',
  'needs-review': 'Nothing needs review. No soft signals were raised on this run.',
  clean: 'No clean rows. Every transaction raised at least one finding.',
};

function renderRows() {
  let rows = state.filter === 'all'
    ? state.results
    : state.results.filter((r) => r.status === state.filter);

  if (state.sort.key) rows = [...rows].sort(compareBy(state.sort.key, state.sort.dir));

  $('resultBody').innerHTML = rows.map((r) => {
    const f = r.extraction?.fields || {};
    const readBy = !r.extraction ? 'no receipt'
      : r.extraction.tier === 'text' ? 'PDF text'
      : r.extraction.tier === 'ocr' ? `OCR ${Math.round(r.extraction.confidence)}%`
      : 'unreadable';
    const findings = r.findings.filter((x) => x.severity !== 'info');
    const label = r.status === 'needs-review' ? 'Review' : r.status === 'exception' ? 'Exception' : 'Clean';
    const sel = r.row.txnId === state.selectedTxn ? ' class="selected"' : '';
    return `<tr data-txn="${esc(r.row.txnId)}"${sel}>
      <td class="mono"><button type="button" class="rowbtn">${esc(r.row.txnId)}</button></td>
      <td class="mono">${esc(r.row.date ?? '—')}</td>
      <td>${esc(r.row.vendor)}</td>
      <td>${esc(r.row.category)}</td>
      <td class="right">${money(r.row.amount, r.row.currency)}</td>
      <td class="right">${money(f.total, f.currency || r.row.currency)}</td>
      <td class="mono">${readBy}</td>
      <td><span class="pill ${r.status}">${label}</span></td>
      <td><ul class="findlist">${findings.map((x) =>
        `<li><code>${x.code}</code>${state.reviews.get(`${r.row.txnId}::${x.code}`)?.decision
          ? '<span class="decided-mark" aria-hidden="true"> ✓</span><span class="sr-only"> decided</span>' : ''}</li>`
      ).join('') || '<li>—</li>'}</ul></td>
    </tr>`;
  }).join('') ||
    `<tr class="empty-row"><td colspan="9">${esc(EMPTY_COPY[state.filter] ?? EMPTY_COPY.all)}</td></tr>`;

  paintSortHeaders();
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// --------------------------------------------------------------------------
// Reviewer decisions.
//
// The auditor reviews in the drawer, where the receipt and the comparison
// table already are, so the decision control lives there too. The decisions
// feed the Exceptions tab's sign-off columns instead of the blanks the user
// used to re-derive in Excel. Persistence is an explicit session FILE, saved
// and loaded like the policy: on a shared corporate laptop, silently keeping
// review verdicts in browser storage is the wrong default.
// --------------------------------------------------------------------------

const DECISIONS = [
  ['approved', 'Approve'],
  ['rejected', 'Reject'],
  ['follow-up', 'Needs follow-up'],
];

function updateReviewProgress() {
  const el = $('reviewProgress');
  if (!state.results.length) { el.textContent = ''; return; }
  let total = 0;
  let decided = 0;
  for (const r of state.results) {
    for (const f of r.findings) {
      if (f.severity === 'info') continue;
      total++;
      if (state.reviews.get(`${r.row.txnId}::${f.code}`)?.decision) decided++;
    }
  }
  el.textContent = total ? `${decided} of ${total} findings decided` : 'No findings to decide';
}

function setDecision(key, decision) {
  const cur = state.reviews.get(key) ?? {};
  if (cur.decision === decision) {
    // Clicking the active choice withdraws it; a note alone may stay.
    delete cur.decision;
  } else {
    cur.decision = decision;
  }
  cur.reviewer = $('reviewerName').value.trim();
  cur.date = new Date().toISOString().slice(0, 10);
  if (!cur.decision && !cur.note) state.reviews.delete(key);
  else state.reviews.set(key, cur);
}

async function saveReviewSession() {
  if (!state.results.length) { showBanner('Run an audit before saving a review session.'); return; }
  const hash = await runHash(state.results, state.policy, state.budgetRecon, state.stmtRows);
  const decisions = [...state.reviews.entries()].map(([key, v]) => {
    const i = key.lastIndexOf('::');
    return { txnId: key.slice(0, i), code: key.slice(i + 2), ...v };
  });
  downloadTextFile('receipt-recon-review.json', JSON.stringify({
    app: 'receipt-recon-review',
    version: 1,
    reportName: state.reportName,
    runHash: hash,
    reviewer: $('reviewerName').value.trim(),
    decisions,
  }, null, 2));
  announce('Review session downloaded.');
}

async function loadReviewSession(file) {
  if (!state.results.length) { showBanner('Run the audit first, then load the review session over it.'); return; }
  let raw;
  try { raw = JSON.parse(await file.text()); }
  catch { showBanner(`"${file.name}" is not valid JSON.`); return; }
  if (raw?.app !== 'receipt-recon-review' || !Array.isArray(raw.decisions)) {
    showBanner(`"${file.name}" is not a review session file.`);
    return;
  }
  // Only decisions that match a finding in THIS run are applied.
  const valid = new Set();
  for (const r of state.results) for (const f of r.findings) valid.add(`${r.row.txnId}::${f.code}`);
  let applied = 0;
  let skipped = 0;
  for (const d of raw.decisions) {
    const key = `${d.txnId}::${d.code}`;
    const entry = {};
    if (DECISIONS.some(([v]) => v === d.decision)) entry.decision = d.decision;
    if (typeof d.note === 'string' && d.note) entry.note = d.note;
    if (typeof d.reviewer === 'string' && d.reviewer) entry.reviewer = d.reviewer;
    if (typeof d.date === 'string' && d.date) entry.date = d.date;
    if (valid.has(key) && Object.keys(entry).length) { state.reviews.set(key, entry); applied++; }
    else skipped++;
  }
  if (raw.reviewer && !$('reviewerName').value) $('reviewerName').value = raw.reviewer;
  const currentHash = await runHash(state.results, state.policy, state.budgetRecon, state.stmtRows);
  const mismatch = raw.runHash && currentHash && raw.runHash !== currentHash;
  if (mismatch || skipped) {
    showBanner(`${applied} decision${applied === 1 ? '' : 's'} applied, ${skipped} did not match this run.` +
      (mismatch ? ' This session was saved against a DIFFERENT run (the run hashes differ) — re-check what carried over.' : ''));
  } else {
    clearBanner();
  }
  renderRows();
  updateReviewProgress();
  if (state.selectedTxn) openPanel(state.selectedTxn,
    $('resultBody').querySelector(`tr[data-txn="${CSS.escape(state.selectedTxn)}"]`));
  announce(`Review session loaded: ${applied} decisions applied.`);
}

async function openPanel(txnId, tr) {
  const r = state.results.find((x) => x.row.txnId === txnId);
  if (!r) return;
  for (const el of $('resultBody').querySelectorAll('tr.selected')) el.classList.remove('selected');
  tr?.classList.add('selected');
  state.selectedTxn = txnId;
  state.lastTrigger = tr?.querySelector('.rowbtn') ?? tr ?? null;

  $('panelTitle').textContent = `${r.row.txnId} · ${r.row.vendor || 'receipt'}`;
  const findings = r.findings.filter((x) => x.severity !== 'info');
  // Severity is written out, not just coloured, so the tier survives colour
  // blindness and a black-and-white print.
  $('panelFindings').innerHTML = findings.length
    ? findings.map((f) => {
        const key = `${r.row.txnId}::${f.code}`;
        const rv = state.reviews.get(key);
        return `<div class="finding ${esc(f.severity)}">
        <div class="finding-head">
          <span class="code">${esc(f.code)}</span>
          <span class="finding-sev">${f.severity === 'hard' ? 'Exception' : 'Needs review'}</span>
        </div>
        <p class="finding-msg">${esc(f.message)}</p>
        <div class="decide" role="group" aria-label="Decision for ${esc(f.code)} on ${esc(r.row.txnId)}">
          ${DECISIONS.map(([d, label]) => `<button type="button"
            class="btn quiet small decide-btn" data-key="${esc(key)}" data-decision="${d}"
            aria-pressed="${String(rv?.decision === d)}">${label}</button>`).join('')}
          <input type="text" class="decide-note" data-key="${esc(key)}"
            value="${esc(rv?.note ?? '')}" placeholder="Note (optional)"
            aria-label="Note for ${esc(f.code)} on ${esc(r.row.txnId)}">
        </div>
      </div>`;
      }).join('')
    : '<div class="finding"><p class="finding-msg">No findings. Every check passed on this row.</p></div>';

  const f = r.extraction?.fields || {};
  const line = (label, sheet, receipt) => {
    const differs = receipt != null && sheet != null &&
      String(sheet).trim().toLowerCase() !== String(receipt).trim().toLowerCase();
    return `<tr class="${differs ? 'differs' : ''}"><td>${label}</td><td>${esc(sheet ?? '—')}</td><td>${esc(receipt ?? '—')}</td></tr>`;
  };
  $('panelCompare').innerHTML =
    `<thead><tr><th><span class="sr-only">Field</span></th><th>Report says</th><th>Receipt says</th></tr></thead><tbody>` +
    line('Amount', r.row.amount?.toFixed(2), f.total?.toFixed(2)) +
    line('Date', r.row.date, f.date) +
    line('Vendor', r.row.vendor, f.vendor) +
    line('Currency', r.row.currency, f.currency) +
    `</tbody>`;

  $('panelRaw').textContent = r.extraction?.text?.trim() || 'Nothing was read from this file.';

  // Show the panel before rendering the PDF. The render can take a second on a
  // big scan, and making the whole drawer wait on it reads as a broken click.
  const holder = $('panelPdf');
  holder.innerHTML = '<p class="microcopy">Rendering the receipt…</p>';
  $('panel').hidden = false;
  $('panel').focus();

  // Clicking a second row while the first is still rendering must not append
  // that first canvas into the second row's panel.
  const token = ++state.panelToken;
  releasePanelPdf();
  const file = resolveReceipt(r.row);
  if (!file) {
    holder.innerHTML = '<p class="microcopy">No support document was loaded for this row.</p>';
    return;
  }
  // A photo needs no pdf.js: show it directly, at its own aspect ratio.
  if (isImageFile(file.name)) {
    state.panelImgUrl = URL.createObjectURL(file);
    const img = document.createElement('img');
    img.src = state.panelImgUrl;
    img.alt = `Receipt photo for ${r.row.txnId}`;
    img.className = 'panel-photo';
    holder.replaceChildren(img);
    return;
  }
  try {
    const task = pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
    const doc = await task.promise;
    if (token !== state.panelToken) { await task.destroy(); return; }
    // Held open so the page controls can render other pages. Released by
    // releasePanelPdf() when the drawer closes or another row is opened.
    state.panelTask = task;
    await renderPanelPdf(doc, task, token);
  } catch {
    if (token !== state.panelToken) return;
    holder.innerHTML = '<p class="microcopy">This receipt could not be displayed.</p>';
  }
}

/** The evidence drawer used to hardcode page 1, while the extractor reads up to
 *  10 pages and hotel folios are its own named example. When the flagged total
 *  or the itemization sat on page 2, the auditor could not see the evidence for
 *  the finding anywhere in the tool. */
async function renderPanelPdf(doc, task, token) {
  const holder = $('panelPdf');
  const pages = doc.numPages;
  let current = 1;

  const canvas = document.createElement('canvas');
  const nav = document.createElement('div');
  nav.className = 'pdfnav';
  const prev = document.createElement('button');
  const next = document.createElement('button');
  const label = document.createElement('span');
  prev.type = next.type = 'button';
  prev.className = next.className = 'btn quiet small';
  prev.textContent = 'Previous page';
  next.textContent = 'Next page';
  label.className = 'pdfnav-label';
  label.id = 'pdfPageLabel';
  // The canvas is the thing that changes, so point the live region at it.
  holder.setAttribute('aria-live', 'polite');
  nav.append(prev, label, next);

  const paint = async () => {
    const page = await doc.getPage(current);
    const base = page.getViewport({ scale: 1 });
    // Same clamp as the OCR tier: an absurd page box must not try to allocate
    // gigabytes here either.
    const viewport = page.getViewport({ scale: clampScale(base.width, base.height, 1.5) });
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport, canvas }).promise;
    if (token !== state.panelToken) return;
    label.textContent = `Page ${current} of ${pages}`;
    prev.disabled = current === 1;
    next.disabled = current === pages;
  };

  const go = async (delta) => {
    const want = Math.min(pages, Math.max(1, current + delta));
    if (want === current) return;
    current = want;
    await paint();
  };
  prev.addEventListener('click', () => go(-1));
  next.addEventListener('click', () => go(1));

  await paint();
  if (token !== state.panelToken) { await task.destroy(); return; }
  // Single-page receipts get no controls; there is nothing to navigate.
  holder.replaceChildren(...(pages > 1 ? [nav, canvas] : [canvas]));
}

/** The drawer holds its PDF open so the page controls work, so something has to
 *  let it go. Without this, opening 350 rows in a session keeps 350 documents
 *  alive. */
function releasePanelPdf() {
  const task = state.panelTask;
  state.panelTask = null;
  if (task) Promise.resolve(task.destroy()).catch(() => { /* already gone */ });
  if (state.panelImgUrl) {
    URL.revokeObjectURL(state.panelImgUrl);
    state.panelImgUrl = null;
  }
}

function closePanel({ restoreFocus = true } = {}) {
  const panel = $('panel');
  if (panel.hidden) return;
  panel.hidden = true;
  state.panelToken++;
  releasePanelPdf();
  if (restoreFocus) state.lastTrigger?.focus();
  state.lastTrigger = null;
}

// --------------------------------------------------------------------------
// Policy editor
// --------------------------------------------------------------------------

const POLICY_FIELDS = [
  ['receiptRequiredAtOrAbove', 'Receipt required at or above'],
  ['itemizationRequiredAtOrAbove', 'Itemization required at or above'],
  ['amountToleranceAbs', 'Amount tolerance'],
  ['tipTolerancePct', 'Tip tolerance (0.25 = 25%)'],
  ['dateToleranceDays', 'Date tolerance (days)'],
  ['vendorSimilarityThreshold', 'Vendor similarity threshold (0-1)'],
  ['approvalThreshold', 'Approval threshold'],
  ['splitWindowDays', 'Split-transaction window (days)'],
  ['staleSubmissionDays', 'Stale submission (days)'],
];

// Every list the rules engine consults is editable here. This is how an
// in-house policy gets taught to the tool: change the words, not the code.
const POLICY_LIST_FIELDS = [
  ['noReceiptCategories', 'Categories with no receipt by nature',
    'These are never asked for a receipt, at any amount, and the list is printed into the workbook.'],
  ['receiptAlwaysRequiredCategories', 'Categories that always need a receipt',
    'A receipt is required at any amount, not just above the floor.'],
  ['itemizationCategories', 'Categories that need an itemized receipt',
    'Applies at or above the itemization threshold.'],
  ['tipEligibleCategories', 'Tip-eligible categories',
    'A claimed amount may exceed the printed total by the tip tolerance without being a mismatch.'],
  ['weekendExemptCategories', 'Weekend-exempt categories',
    'Weekend dates in these categories are not flagged.'],
  ['alcoholKeywords', 'Alcohol keywords',
    'Any of these words on a receipt raises POLICY_ALCOHOL.'],
  ['personalKeywords', 'Personal-expense keywords',
    'Any of these in the vendor or purpose raises PERSONAL_EXPENSE.'],
];

// The policy survives a reload, so an in-house policy is taught once, on this
// computer only. Nothing is uploaded; it sits in this browser's localStorage.
const POLICY_KEY = 'receipt-recon-policy';

function savePolicy() {
  try { localStorage.setItem(POLICY_KEY, JSON.stringify(state.policy)); } catch { /* storage blocked by policy */ }
}

/** Download a small text file. Used for the policy file and the review
 *  session: both are explicit user actions, mirroring the workbook download. */
function downloadTextFile(filename, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** The explicit half of policy persistence: a file the user can keep in
 *  version control, diff, and hand to a colleague. The localStorage mirror
 *  below stays; this is for moving the policy between machines and months. */
function loadPolicyFile(file) {
  file.text().then((text) => {
    let raw;
    try { raw = JSON.parse(text); }
    catch { showBanner(`"${file.name}" is not valid JSON, so the policy was not changed.`); return; }
    const { policy, errors } = sanitizePolicy(raw);
    if (errors.length) {
      showBanner(`"${file.name}" was refused: ${errors[0]} The policy was not changed.`);
      return;
    }
    state.policy = policy;
    savePolicy();
    renderPolicy();
    clearBanner();
    announce('Policy loaded from file.');
  }).catch(() => showBanner(`"${file.name}" could not be read.`));
}

function storedPolicy() {
  try {
    const raw = localStorage.getItem(POLICY_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    // Merged over the defaults, so a policy saved before a knob existed still
    // carries that knob's default instead of dropping it.
    const merged = structuredClone(DEFAULT_POLICY);
    for (const [k, v] of Object.entries(saved)) {
      if (k in merged) merged[k] = v;
    }
    return merged;
  } catch { return null; }
}

function renderPolicy() {
  $('policyGrid').innerHTML = POLICY_FIELDS.map(([key, label]) => `
    <div class="policy-item">
      <label for="p_${key}">${label}</label>
      <input id="p_${key}" type="number" step="any" value="${state.policy[key]}">
    </div>`).join('') +
    Object.entries(state.policy.categoryLimits).map(([cat, v]) => `
    <div class="policy-item">
      <label for="pc_${esc(cat)}">Limit: ${esc(cat)}</label>
      <input id="pc_${esc(cat)}" data-cat="${esc(cat)}" type="number" step="any" value="${v}">
    </div>`).join('') + `
    <div class="policy-item">
      <label for="pc_newName">Add a category limit</label>
      <div class="policy-addrow">
        <input id="pc_newName" type="text" placeholder="Category">
        <input id="pc_newValue" type="number" step="any" placeholder="Limit">
        <button type="button" class="btn quiet small" id="pc_newAdd">Add</button>
      </div>
    </div>` + `
    <div class="policy-item">
      <label for="p_fxBase">Converted view: base currency</label>
      <input id="p_fxBase" type="text" maxlength="3" value="${esc(state.policy.fxBase)}" autocapitalize="characters">
    </div>` +
    Object.entries(state.policy.fxRates).map(([code, v]) => `
    <div class="policy-item">
      <label for="fx_${esc(code)}">1 ${esc(code)} in ${esc(state.policy.fxBase)}</label>
      <input id="fx_${esc(code)}" data-fx="${esc(code)}" type="number" step="any" min="0" value="${v}">
    </div>`).join('') + `
    <div class="policy-item">
      <label for="fx_newCode">Add an FX rate</label>
      <div class="policy-addrow">
        <input id="fx_newCode" type="text" maxlength="3" placeholder="EUR" autocapitalize="characters">
        <input id="fx_newRate" type="number" step="any" min="0" placeholder="1.08">
        <button type="button" class="btn quiet small" id="fx_newAdd">Add</button>
      </div>
      <span class="policy-hint">Month-end rates you choose, kept on this computer. They feed only the
      clearly labelled “at your stated rates” view. No finding ever converts a currency.
      Clear a rate to remove it.</span>
    </div>` +
    POLICY_LIST_FIELDS.map(([key, label, hint]) => `
    <div class="policy-item wide">
      <label for="p_${key}">${label}</label>
      <input id="p_${key}" type="text" value="${esc((state.policy[key] || []).join(', '))}">
      <span class="policy-hint">Comma separated. ${hint}</span>
    </div>`).join('');

  for (const [key] of POLICY_LIST_FIELDS) {
    $(`p_${key}`).addEventListener('change', (e) => {
      state.policy[key] = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
      savePolicy();
    });
  }

  for (const [key] of POLICY_FIELDS) {
    $(`p_${key}`).addEventListener('change', (e) => {
      const n = parseFloat(e.target.value);
      if (Number.isFinite(n)) { state.policy[key] = n; savePolicy(); }
    });
  }
  for (const input of $('policyGrid').querySelectorAll('input[data-cat]')) {
    input.addEventListener('change', (e) => {
      const n = parseFloat(e.target.value);
      if (Number.isFinite(n)) { state.policy.categoryLimits[e.target.dataset.cat] = n; savePolicy(); }
    });
  }
  $('p_fxBase').addEventListener('change', (e) => {
    const code = e.target.value.trim().toUpperCase();
    if (/^[A-Z]{3}$/.test(code)) {
      state.policy.fxBase = code;
      savePolicy();
      renderPolicy();          // rate labels name the base, so they re-render
      renderBudget();          // a visible converted view follows the rates live
    } else {
      e.target.value = state.policy.fxBase;
    }
  });
  for (const input of $('policyGrid').querySelectorAll('input[data-fx]')) {
    input.addEventListener('change', (e) => {
      const code = e.target.dataset.fx;
      const n = parseFloat(e.target.value);
      if (Number.isFinite(n) && n > 0) {
        state.policy.fxRates[code] = n;
        savePolicy();
      } else {
        // Clearing the field removes the rate, and with it the converted line.
        delete state.policy.fxRates[code];
        savePolicy();
        renderPolicy();
      }
      renderBudget();
    });
  }
  $('fx_newAdd').addEventListener('click', () => {
    const code = $('fx_newCode').value.trim().toUpperCase();
    const n = parseFloat($('fx_newRate').value);
    if (!/^[A-Z]{3}$/.test(code) || !Number.isFinite(n) || n <= 0) return;
    state.policy.fxRates[code] = n;
    savePolicy();
    renderPolicy();
    renderBudget();
    $('fx_newCode').focus();
  });
  $('pc_newAdd').addEventListener('click', () => {
    const cat = $('pc_newName').value.trim();
    const n = parseFloat($('pc_newValue').value);
    if (!cat || !Number.isFinite(n)) return;
    state.policy.categoryLimits[cat] = n;
    savePolicy();
    renderPolicy();          // the new limit appears as its own editable field
    $('pc_newName').focus();
  });
}

// --------------------------------------------------------------------------
// File input plumbing
// --------------------------------------------------------------------------

function updateRunButton() {
  $('btnRun').disabled = !(state.sheetFile && state.rows.length);
}

async function acceptSheet(file) {
  state.sheetFile = file;
  state.reportName = file.name;
  try {
    state.sheets = await readWorkbook(file);
    const txn = pickTransactionSheet(state.sheets);
    if (txn === -1) {
      throw new Error('Could not find a sheet with an amount column. Expected a header like "Amount" or "Total".');
    }
    state.txnSheetIndex = txn;
    state.budgetSheetIndex = pickBudgetSheet(state.sheets, txn);
    applySheetSelection();
    clearBanner();
  } catch (err) {
    state.rows = [];
    state.sheets = [];
    state.budgetEntries = null;
    state.columnMap = null;
    $('sheetChoice').hidden = true;
    $('colMap').hidden = true;
    $('statusSheet').textContent = 'Could not read that file';
    $('dropSheet').classList.remove('filled');
    showBanner(err.message);
  }
  updateRunButton();
}

/** Re-derive rows and budget from the currently selected sheets, and say in
 *  the drop status exactly which sheet is being audited against which budget,
 *  so a wrong guess is visible before the run rather than after it. */
function applySheetSelection() {
  const txnSheet = state.sheets[state.txnSheetIndex];
  const header = txnSheet.aoa[0] || [];
  // A correction made last month for this exact header row outranks the guess.
  state.columnMap = rememberedMap(header) ?? mapHeaders(header);
  state.rows = rowsFromSheet(txnSheet.aoa, state.columnMap);
  const parsed = state.budgetSheetIndex >= 0
    ? parseBudgetSheet(state.sheets[state.budgetSheetIndex].aoa)
    : null;
  state.budgetEntries = parsed?.entries ?? null;

  renderSheetChoice();
  renderColumnMap();
  paintSheetStatus();
}

function paintSheetStatus() {
  const txnSheet = state.sheets[state.txnSheetIndex];
  const bits = [`${state.reportName} · ${state.rows.length} rows`];
  if (state.sheets.length > 1) bits.push(`from “${txnSheet.name}”`);
  if (state.budgetEntries) {
    bits.push(`budget: ${state.budgetEntries.length} line${state.budgetEntries.length === 1 ? '' : 's'}`);
  }
  $('statusSheet').textContent = bits.join(' · ');
  $('dropSheet').classList.add('filled');
}

function renderSheetChoice() {
  const box = $('sheetChoice');
  if (state.sheets.length < 2) { box.hidden = true; return; }

  const options = (selected, skip = -1) => state.sheets.map((s, i) =>
    i === skip ? '' :
    `<option value="${i}"${i === selected ? ' selected' : ''}>${esc(s.name)}</option>`).join('');
  $('selTxnSheet').innerHTML = options(state.txnSheetIndex);
  $('selBudgetSheet').innerHTML =
    `<option value="-1"${state.budgetSheetIndex === -1 ? ' selected' : ''}>None</option>` +
    options(state.budgetSheetIndex, state.txnSheetIndex);

  const hint = $('budgetHint');
  if (state.budgetSheetIndex >= 0 && !state.budgetEntries) {
    hint.textContent = `No budget table was found on “${state.sheets[state.budgetSheetIndex].name}”. It needs a label column (like Category) and a budget column.`;
  } else if (state.budgetEntries) {
    hint.textContent = 'The report will be reconciled against this budget, each line in its own currency.';
  } else {
    hint.textContent = '';
  }
  box.hidden = false;
}

function changeSheetSelection() {
  try {
    applySheetSelection();
    clearBanner();
  } catch (err) {
    state.rows = [];
    state.columnMap = null;
    $('colMap').hidden = true;
    $('statusSheet').textContent = 'That sheet does not hold the transactions';
    showBanner(err.message);
  }
  updateRunButton();
}

function paintReceiptStatus(skippedNames = []) {
  const n = state.receipts.size;
  // Skipped files are reported BY NAME: "3 ignored" tells the user nothing
  // about whether their receipts made it in.
  let skippedNote = '';
  if (skippedNames.length) {
    const shown = skippedNames.slice(0, 3).join(', ');
    const more = skippedNames.length - 3;
    skippedNote = ` · ignored: ${shown}${more > 0 ? ` and ${more} more` : ''}`;
  }
  $('statusReceipts').textContent = n
    ? `${n} receipt${n === 1 ? '' : 's'} loaded${skippedNote}`
    : 'No receipts chosen';
  $('dropReceipts').classList.toggle('filled', n > 0);
  $('btnClearReceipts').hidden = n === 0;
  updateRunButton();
}

/** @param replace  true when the whole set is being chosen again.
 *
 *  Picking the folder is always a complete choice, so a second pick replaces
 *  the first. Nothing ever cleared this Map before, so choosing the wrong
 *  folder and then the right one left every file from the wrong one still
 *  eligible: resolveReceipt matches generously on basename and txn id, so a
 *  stale PDF could be resolved and then cited as evidence in the workbook.
 *  Drag and drop stays additive, because dropping is how you add a few
 *  stragglers to a set you already have. */
function acceptReceipts(files, { replace = false } = {}) {
  if (replace) state.receipts.clear();
  const skipped = [];
  for (const f of files) {
    const name = f.name.toLowerCase();
    if (f.type === 'application/pdf' || RECEIPT_EXTENSIONS.some((e) => name.endsWith(e))) {
      state.receipts.set(name.split(/[\\/]/).pop(), f);
    } else {
      skipped.push(f.name);
    }
  }
  paintReceiptStatus(skipped);
}

function clearReceipts() {
  state.receipts.clear();
  paintReceiptStatus();
  announce('Receipts cleared.');
}

/** The optional third input: the card statement the user downloads themselves.
 *  Local file only, by design — no bank API, no OAuth, no live connection. */
async function acceptStatement(file) {
  try {
    const sheets = await readWorkbook(file);
    const idx = pickStatementSheet(sheets);
    if (idx === -1) {
      throw new Error('No statement table found in that file. It needs a date column and an amount column.');
    }
    const parsed = parseStatement(sheets[idx].aoa);
    state.stmtRows = parsed.rows;
    state.stmtInfo = { fileName: file.name, sheetName: sheets[idx].name, skipped: parsed.skipped };
    const bits = [`${file.name} · ${parsed.rows.length} charge${parsed.rows.length === 1 ? '' : 's'}`];
    if (parsed.skipped) bits.push(`${parsed.skipped} payment line${parsed.skipped === 1 ? '' : 's'} skipped`);
    $('statusStatement').textContent = bits.join(' · ');
    $('dropStatement').classList.add('filled');
    $('btnClearStatement').hidden = false;
    clearBanner();
  } catch (err) {
    clearStatement();
    $('statusStatement').textContent = 'Could not read that file';
    showBanner(err.message);
  }
}

function clearStatement() {
  state.stmtRows = null;
  state.stmtInfo = null;
  state.stmtRecon = null;
  $('statusStatement').textContent = 'None loaded';
  $('dropStatement').classList.remove('filled');
  $('btnClearStatement').hidden = true;
}

function showBanner(msg) {
  clearBanner();
  const el = document.createElement('div');
  el.className = 'banner';
  el.id = 'banner';
  el.setAttribute('role', 'alert');   // otherwise the error is silent to a screen reader
  el.textContent = msg;
  $('step-input').appendChild(el);
}
function clearBanner() { $('banner')?.remove(); }

function wireDrop(dropId, handler) {
  const el = $(dropId);
  for (const ev of ['dragenter', 'dragover']) {
    el.addEventListener(ev, (e) => { e.preventDefault(); el.classList.add('dragover'); });
  }
  for (const ev of ['dragleave', 'drop']) {
    el.addEventListener(ev, (e) => { e.preventDefault(); el.classList.remove('dragover'); });
  }
  el.addEventListener('drop', async (e) => {
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) await handler(files);
  });
}

// --------------------------------------------------------------------------
// Theme. The stylesheet carries both palettes; this decides which one applies
// and remembers it. app/theme-boot.js replays the choice before first paint.
// --------------------------------------------------------------------------

const THEME_KEY = 'receipt-recon-theme';

function applyTheme(value) {
  const root = document.documentElement;
  if (value === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', value);
  for (const b of document.querySelectorAll('.themebtn')) {
    b.setAttribute('aria-pressed', String(b.dataset.themeValue === value));
  }
  try { localStorage.setItem(THEME_KEY, value); } catch { /* storage blocked by policy */ }
}

function storedTheme() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch { /* storage blocked by policy */ }
  return 'system';
}

// --------------------------------------------------------------------------
// Sample data. One click, no files needed. This is what makes the tool
// evaluable by a stranger in ten seconds.
// --------------------------------------------------------------------------

async function loadSample() {
  const btn = $('btnSample');
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  btn.textContent = 'Loading sample…';
  try {
    const manifest = await fetch('sample-data/manifest.json').then((r) => {
      if (!r.ok) throw new Error('Sample data is not available on this copy.');
      return r.json();
    });

    const sheetBlob = await fetch('sample-data/expense-report.xlsx').then((r) => r.blob());
    await acceptSheet(new File([sheetBlob], 'expense-report.xlsx'));

    const files = [];
    for (const name of manifest.receipts) {
      const blob = await fetch(`sample-data/receipts/${name}`).then((r) => r.blob());
      files.push(new File([blob], name, { type: 'application/pdf' }));
    }
    acceptReceipts(files, { replace: true });
    await runAudit();
  } catch (err) {
    showBanner(err.message);
  } finally {
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
    btn.textContent = 'Try it with sample data';
  }
}

// --------------------------------------------------------------------------

function init() {
  applyTheme(storedTheme());
  const saved = storedPolicy();
  if (saved) state.policy = saved;
  for (const b of document.querySelectorAll('.themebtn')) {
    b.addEventListener('click', () => applyTheme(b.dataset.themeValue));
  }

  $('fileSheet').addEventListener('change', (e) => e.target.files[0] && acceptSheet(e.target.files[0]));
  $('selTxnSheet').addEventListener('change', (e) => {
    state.txnSheetIndex = Number(e.target.value);
    // The transaction sheet cannot double as the budget sheet.
    if (state.budgetSheetIndex === state.txnSheetIndex) state.budgetSheetIndex = -1;
    changeSheetSelection();
  });
  $('selBudgetSheet').addEventListener('change', (e) => {
    state.budgetSheetIndex = Number(e.target.value);
    changeSheetSelection();
  });
  // A folder pick replaces the set; a drop adds to it.
  $('fileReceipts').addEventListener('change', (e) => acceptReceipts([...e.target.files], { replace: true }));
  $('btnClearReceipts').addEventListener('click', clearReceipts);
  wireDrop('dropSheet', (files) => acceptSheet(files[0]));
  wireDrop('dropReceipts', (files) => acceptReceipts(files));
  $('fileStatement').addEventListener('change', (e) => e.target.files[0] && acceptStatement(e.target.files[0]));
  $('btnClearStatement').addEventListener('click', () => { clearStatement(); announce('Statement cleared.'); });
  wireDrop('dropStatement', (files) => acceptStatement(files[0]));

  $('btnRun').addEventListener('click', runAudit);
  $('btnSample').addEventListener('click', loadSample);

  $('btnPolicy').addEventListener('click', () => {
    const panel = $('step-policy');
    panel.hidden = !panel.hidden;
    $('btnPolicy').setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden) renderPolicy();
  });
  $('btnPolicySave').addEventListener('click', () => {
    downloadTextFile('receipt-recon-policy.json', JSON.stringify(state.policy, null, 2));
    announce('Policy file downloaded.');
  });
  $('btnPolicyLoad').addEventListener('click', () => $('filePolicy').click());
  $('filePolicy').addEventListener('change', (e) => {
    if (e.target.files[0]) loadPolicyFile(e.target.files[0]);
    e.target.value = '';   // so loading the same file again still fires change
  });
  $('btnPolicyReset').addEventListener('click', () => {
    state.policy = structuredClone(DEFAULT_POLICY);
    try { localStorage.removeItem(POLICY_KEY); } catch { /* storage blocked by policy */ }
    renderPolicy();
  });

  for (const chip of $('filters').querySelectorAll('.chip')) {
    chip.addEventListener('click', () => {
      for (const c of $('filters').querySelectorAll('.chip')) {
        c.classList.remove('active');
        c.setAttribute('aria-pressed', 'false');
      }
      chip.classList.add('active');
      chip.setAttribute('aria-pressed', 'true');
      state.filter = chip.dataset.filter;
      renderRows();
    });
  }

  for (const btn of document.querySelectorAll('.th-sort')) {
    btn.addEventListener('click', () => toggleSort(btn.dataset.sort));
  }

  // Delegated: rows are replaced on every filter and sort, and rebinding a
  // listener per row on a 350-row table is work for nothing. This also means
  // the transaction-id button and a click anywhere else on the row share one
  // path, so keyboard and mouse cannot drift apart.
  $('resultBody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-txn]');
    if (tr) openPanel(tr.dataset.txn, tr);
  });

  $('btnDownload').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const label = btn.textContent;
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    btn.textContent = 'Building workbook…';
    try {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const budget = state.budgetRecon ? {
        ...state.budgetRecon,
        sheetName: state.budgetSheetIndex >= 0 ? state.sheets[state.budgetSheetIndex].name : '',
        // The converted view rides along for the workbook; it is not hash
        // material and reconcileBudget's lines are untouched by it.
        fx: fxView(state.budgetRecon.lines, state.policy),
      } : null;
      const hash = await runHash(state.results, state.policy, state.budgetRecon, state.stmtRows);
      const statement = state.stmtRecon ? {
        fileName: state.stmtInfo?.fileName ?? '',
        lineCount: state.stmtRows.length,
        skipped: state.stmtInfo?.skipped ?? 0,
        recon: state.stmtRecon,
      } : null;
      const wb = buildWorkbook(XLSX, state.results, {
        hash,
        budget,
        statement,
        reviews: state.reviews,
        policy: state.policy,
        generatedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
        reportName: state.reportName,
        receiptCount: state.receipts.size,
        ocrCount: state.ocrUsed,
      });
      downloadWorkbook(XLSX, wb, `audit-${stamp}.xlsx`);
      announce('Audit workbook downloaded.');
    } catch (err) {
      showBanner(`The workbook could not be built: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
      btn.textContent = label;
    }
  });

  // Decision controls, delegated: the drawer's findings are re-rendered on
  // every open, and delegation keeps one code path for mouse and keyboard.
  $('panelFindings').addEventListener('click', (e) => {
    const btn = e.target.closest('.decide-btn');
    if (!btn) return;
    setDecision(btn.dataset.key, btn.dataset.decision);
    const chosen = state.reviews.get(btn.dataset.key)?.decision ?? null;
    for (const b of btn.closest('.decide').querySelectorAll('.decide-btn')) {
      b.setAttribute('aria-pressed', String(b.dataset.decision === chosen));
    }
    renderRows();
    updateReviewProgress();
  });
  $('panelFindings').addEventListener('change', (e) => {
    const note = e.target.closest('.decide-note');
    if (!note) return;
    const key = note.dataset.key;
    const cur = state.reviews.get(key) ?? {};
    if (note.value.trim()) {
      cur.note = note.value.trim();
      cur.reviewer = cur.reviewer || $('reviewerName').value.trim();
      cur.date = new Date().toISOString().slice(0, 10);
      state.reviews.set(key, cur);
    } else {
      delete cur.note;
      if (!cur.decision) state.reviews.delete(key);
    }
  });
  $('btnSaveReview').addEventListener('click', saveReviewSession);
  $('btnLoadReview').addEventListener('click', () => $('fileReview').click());
  $('fileReview').addEventListener('change', (e) => {
    if (e.target.files[0]) loadReviewSession(e.target.files[0]);
    e.target.value = '';
  });

  $('panelClose').addEventListener('click', () => closePanel());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePanel(); });

  // Click away to dismiss, the way a drawer should. Focus is not pulled back to
  // the row here: the pointer is already on its way somewhere else.
  document.addEventListener('pointerdown', (e) => {
    if ($('panel').hidden) return;
    if (e.target.closest('#panel') || e.target.closest('#resultBody tr[data-txn]')) return;
    closePanel({ restoreFocus: false });
  });
}

init();
