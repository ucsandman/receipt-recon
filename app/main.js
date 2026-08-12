// UI wiring.
//
// Everything here runs in the page. There is no server, no upload, no API key.
// The only network requests this app ever makes are for its own files in
// vendor/, and those are same-origin. A watchdog below proves that claim
// rather than just asserting it.

import * as pdfjsLib from '../vendor/pdf.min.mjs';
import { extractReceipt } from './extract.js';
import { auditAll, DEFAULT_POLICY } from './rules.js';
import { buildWorkbook, downloadWorkbook, runHash } from './report.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;

const $ = (id) => document.getElementById(id);

const state = {
  sheetFile: null,
  receipts: new Map(),   // lowercased filename -> File
  rows: [],
  results: [],
  policy: structuredClone(DEFAULT_POLICY),
  filter: 'all',
  ocrWorker: null,
  ocrUsed: 0,
  reportName: '',
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

// Header names differ between expense systems. Match on intent, not on an
// exact string, so a report exported from a different tool still works.
const COLUMN_ALIASES = {
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

function mapHeaders(header) {
  const norm = header.map((h) => String(h ?? '').trim().toLowerCase());
  const map = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    let idx = norm.findIndex((h) => aliases.includes(h));
    if (idx === -1) idx = norm.findIndex((h) => h && aliases.some((a) => h.includes(a)));
    if (idx !== -1) map[field] = idx;
  }
  return map;
}

function excelSerialToISO(n) {
  // Excel day 0 is 1899-12-30 (Lotus leap-year bug included, on purpose).
  const ms = Math.round((n - 25569) * 86400000);
  return new Date(ms).toISOString().slice(0, 10);
}

function normalizeDate(v) {
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

function toNumber(v) {
  if (typeof v === 'number') return v;
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

async function readSheet(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, blankrows: false });
  if (!aoa.length) throw new Error('That spreadsheet has no rows.');

  const map = mapHeaders(aoa[0]);
  if (map.amount === undefined) {
    throw new Error('Could not find an amount column. Expected a header like "Amount" or "Total".');
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
// Running the audit
// --------------------------------------------------------------------------

function setProgress(pct, text) {
  $('progBar').style.width = `${Math.max(0, Math.min(100, pct))}%`;
  if (text) setProgressText(text);
}
function setProgressText(text) { $('progText').textContent = text; }

/** Receipt filenames in the sheet rarely match the folder exactly: extra
 *  paths, different case, a missing .pdf. Resolve generously, then fall back
 *  to matching on the transaction id, which is how most exports name them. */
function resolveReceipt(row) {
  const tries = [];
  if (row.receiptFile) {
    const base = String(row.receiptFile).split(/[\\/]/).pop().toLowerCase();
    tries.push(base, base.endsWith('.pdf') ? base.slice(0, -4) : `${base}.pdf`);
  }
  if (row.txnId) tries.push(`${String(row.txnId).toLowerCase()}.pdf`);
  for (const t of tries) if (state.receipts.has(t)) return state.receipts.get(t);
  return null;
}

async function runAudit() {
  $('step-progress').hidden = false;
  $('step-results').hidden = true;
  $('btnRun').disabled = true;
  state.ocrUsed = 0;

  const extractions = new Map();
  const total = state.rows.length;
  let done = 0;

  for (const row of state.rows) {
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
      done++;
      setProgress((done / total) * 100, `${done} of ${total} rows`);
      continue;
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const res = await extractReceipt(bytes, { pdfjsLib, getOcrWorker });
    if (res.tier === 'ocr') state.ocrUsed++;
    extractions.set(row.txnId, res);

    done++;
    setProgress((done / total) * 100,
      `${done} of ${total} rows${state.ocrUsed ? ` · ${state.ocrUsed} needed OCR` : ''}`);
    // Yield so the progress bar actually paints during a long run.
    if (done % 3 === 0) await new Promise((r) => setTimeout(r, 0));
  }

  state.extractions = extractions;
  state.results = auditAll(state.rows, extractions, state.policy);
  setProgress(100, `Done. ${total} rows checked.`);
  renderResults();
  $('step-results').hidden = false;
  $('btnRun').disabled = false;
  $('step-results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// --------------------------------------------------------------------------
// Rendering
// --------------------------------------------------------------------------

const money = (v, cur) => (v == null || v === '' ? '—'
  : `${cur === 'EUR' ? '€' : cur === 'GBP' ? '£' : '$'}${Number(v).toFixed(2)}`);

function renderResults() {
  const r = state.results;
  const exception = r.filter((x) => x.status === 'exception').length;
  const review = r.filter((x) => x.status === 'needs-review').length;
  const clean = r.filter((x) => x.status === 'clean').length;
  const value = r.filter((x) => x.status !== 'clean').reduce((s, x) => s + (x.row.amount || 0), 0);

  $('tiles').innerHTML = `
    <div class="tile"><div class="n">${r.length}</div><div class="k">Transactions checked</div></div>
    <div class="tile hard"><div class="n">${exception}</div><div class="k">Exceptions</div></div>
    <div class="tile soft"><div class="n">${review}</div><div class="k">Needs review</div></div>
    <div class="tile clean"><div class="n">${clean}</div><div class="k">Clean</div></div>
    <div class="tile"><div class="n">${money(value, 'USD')}</div><div class="k">Value flagged</div></div>`;

  renderRows();
}

function renderRows() {
  const rows = state.filter === 'all'
    ? state.results
    : state.results.filter((r) => r.status === state.filter);

  $('resultBody').innerHTML = rows.map((r) => {
    const f = r.extraction?.fields || {};
    const readBy = !r.extraction ? 'no receipt'
      : r.extraction.tier === 'text' ? 'PDF text'
      : r.extraction.tier === 'ocr' ? `OCR ${Math.round(r.extraction.confidence)}%`
      : 'unreadable';
    const findings = r.findings.filter((x) => x.severity !== 'info');
    return `<tr data-txn="${r.row.txnId}">
      <td class="mono">${esc(r.row.txnId)}</td>
      <td class="mono">${esc(r.row.date ?? '—')}</td>
      <td>${esc(r.row.vendor)}</td>
      <td>${esc(r.row.category)}</td>
      <td class="right">${money(r.row.amount, r.row.currency)}</td>
      <td class="right">${money(f.total, f.currency || r.row.currency)}</td>
      <td class="mono">${readBy}</td>
      <td><span class="pill ${r.status}">${r.status === 'needs-review' ? 'Review' : r.status === 'exception' ? 'Exception' : 'Clean'}</span></td>
      <td><ul class="findlist">${findings.map((x) => `<li><code>${x.code}</code></li>`).join('') || '<li>—</li>'}</ul></td>
    </tr>`;
  }).join('') || '<tr><td colspan="9" style="padding:22px;text-align:center;color:var(--ink-3)">Nothing in this view.</td></tr>';

  for (const tr of $('resultBody').querySelectorAll('tr[data-txn]')) {
    tr.addEventListener('click', () => openPanel(tr.dataset.txn, tr));
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function openPanel(txnId, tr) {
  const r = state.results.find((x) => x.row.txnId === txnId);
  if (!r) return;
  for (const el of $('resultBody').querySelectorAll('tr.selected')) el.classList.remove('selected');
  tr?.classList.add('selected');

  $('panelTitle').textContent = `${r.row.txnId} · ${r.row.vendor || 'receipt'}`;
  const findings = r.findings.filter((x) => x.severity !== 'info');
  $('panelFindings').innerHTML = findings.length
    ? findings.map((f) => `<div class="finding ${f.severity}">
        <span class="code">${f.code}</span>${esc(f.message)}</div>`).join('')
    : '<div class="finding">No findings. Every check passed on this row.</div>';

  const f = r.extraction?.fields || {};
  const line = (label, sheet, receipt) => {
    const differs = receipt != null && sheet != null &&
      String(sheet).trim().toLowerCase() !== String(receipt).trim().toLowerCase();
    return `<tr class="${differs ? 'differs' : ''}"><td>${label}</td><td>${esc(sheet ?? '—')}</td><td>${esc(receipt ?? '—')}</td></tr>`;
  };
  $('panelCompare').innerHTML =
    `<tr><td></td><td style="color:var(--ink-3)">report says</td><td style="color:var(--ink-3)">receipt says</td></tr>` +
    line('Amount', r.row.amount?.toFixed(2), f.total?.toFixed(2)) +
    line('Date', r.row.date, f.date) +
    line('Vendor', r.row.vendor, f.vendor) +
    line('Currency', r.row.currency, f.currency);

  $('panelRaw').textContent = r.extraction?.text?.trim() || 'Nothing was read from this file.';

  // Render the actual receipt, so the auditor sees the document, not a claim
  // about the document.
  const holder = $('panelPdf');
  holder.innerHTML = '';
  const file = resolveReceipt(r.row);
  if (file) {
    try {
      const task = pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
      const doc = await task.promise;
      const page = await doc.getPage(1);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width; canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport, canvas }).promise;
      holder.appendChild(canvas);
      await task.destroy();
    } catch {
      holder.innerHTML = '<p class="microcopy">This receipt could not be displayed.</p>';
    }
  } else {
    holder.innerHTML = '<p class="microcopy">No support document was loaded for this row.</p>';
  }

  $('panel').hidden = false;
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

function renderPolicy() {
  $('policyGrid').innerHTML = POLICY_FIELDS.map(([key, label]) => `
    <div class="policy-item">
      <label for="p_${key}">${label}</label>
      <input id="p_${key}" type="number" step="any" value="${state.policy[key]}">
    </div>`).join('') +
    Object.entries(state.policy.categoryLimits).map(([cat, v]) => `
    <div class="policy-item">
      <label for="pc_${cat}">Limit: ${esc(cat)}</label>
      <input id="pc_${cat}" data-cat="${esc(cat)}" type="number" step="any" value="${v}">
    </div>`).join('');

  for (const [key] of POLICY_FIELDS) {
    $(`p_${key}`).addEventListener('change', (e) => {
      const n = parseFloat(e.target.value);
      if (Number.isFinite(n)) state.policy[key] = n;
    });
  }
  for (const input of $('policyGrid').querySelectorAll('input[data-cat]')) {
    input.addEventListener('change', (e) => {
      const n = parseFloat(e.target.value);
      if (Number.isFinite(n)) state.policy.categoryLimits[e.target.dataset.cat] = n;
    });
  }
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
    state.rows = await readSheet(file);
    $('statusSheet').textContent = `${file.name} · ${state.rows.length} rows`;
    $('dropSheet').classList.add('filled');
    clearBanner();
  } catch (err) {
    state.rows = [];
    $('statusSheet').textContent = 'Could not read that file';
    $('dropSheet').classList.remove('filled');
    showBanner(err.message);
  }
  updateRunButton();
}

function acceptReceipts(files) {
  for (const f of files) {
    if (f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')) {
      state.receipts.set(f.name.split(/[\\/]/).pop().toLowerCase(), f);
    }
  }
  $('statusReceipts').textContent = `${state.receipts.size} PDF${state.receipts.size === 1 ? '' : 's'} loaded`;
  $('dropReceipts').classList.toggle('filled', state.receipts.size > 0);
  updateRunButton();
}

function showBanner(msg) {
  clearBanner();
  const el = document.createElement('div');
  el.className = 'banner'; el.id = 'banner'; el.textContent = msg;
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
// Sample data. One click, no files needed. This is what makes the tool
// evaluable by a stranger in ten seconds.
// --------------------------------------------------------------------------

async function loadSample() {
  $('btnSample').disabled = true;
  $('btnSample').textContent = 'Loading sample…';
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
    acceptReceipts(files);
    await runAudit();
  } catch (err) {
    showBanner(err.message);
  } finally {
    $('btnSample').disabled = false;
    $('btnSample').textContent = 'Try it with sample data';
  }
}

// --------------------------------------------------------------------------

function init() {
  $('fileSheet').addEventListener('change', (e) => e.target.files[0] && acceptSheet(e.target.files[0]));
  $('fileReceipts').addEventListener('change', (e) => acceptReceipts([...e.target.files]));
  wireDrop('dropSheet', (files) => acceptSheet(files[0]));
  wireDrop('dropReceipts', (files) => acceptReceipts(files));

  $('btnRun').addEventListener('click', runAudit);
  $('btnSample').addEventListener('click', loadSample);

  $('btnPolicy').addEventListener('click', () => {
    const panel = $('step-policy');
    panel.hidden = !panel.hidden;
    $('btnPolicy').setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden) renderPolicy();
  });
  $('btnPolicyReset').addEventListener('click', () => {
    state.policy = structuredClone(DEFAULT_POLICY);
    renderPolicy();
  });

  for (const chip of $('filters').querySelectorAll('.chip')) {
    chip.addEventListener('click', () => {
      for (const c of $('filters').querySelectorAll('.chip')) c.classList.remove('active');
      chip.classList.add('active');
      state.filter = chip.dataset.filter;
      renderRows();
    });
  }

  $('btnDownload').addEventListener('click', async () => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const hash = await runHash(state.results, state.policy);
    const wb = buildWorkbook(XLSX, state.results, {
      hash,
      policy: state.policy,
      generatedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
      reportName: state.reportName,
      receiptCount: state.receipts.size,
      ocrCount: state.ocrUsed,
    });
    downloadWorkbook(XLSX, wb, `audit-${stamp}.xlsx`);
  });

  $('panelClose').addEventListener('click', () => { $('panel').hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('panel').hidden = true; });
}

init();
