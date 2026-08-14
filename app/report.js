// The audit workbook.
//
// This is the deliverable. Not the screen, not a chat answer -- an .xlsx the
// accountant can file, email to a reviewer, and defend in a year's time.
//
// Four tabs:
//   Summary       counts, what ran, what it could not verify
//   Audit Detail  every transaction, its status, and its findings
//   Exceptions    just the rows needing a decision, with sign-off columns
//   Methodology   the ruleset, the thresholds used, and the stated limits
//
// Every transaction appears, not only the exceptions. A report that lists only
// problems cannot be used as evidence that the other 335 rows were checked.

import { RULESET_VERSION, SEVERITY } from './rules.js';

const STATUS_LABEL = {
  clean: 'Clean',
  'needs-review': 'Needs review',
  exception: 'Exception',
};

function col(w) { return { wch: w }; }

/** SheetJS writes what it is given; widths and freeze panes are what make the
 *  file usable the moment it opens, so they are not cosmetic here. */
function styleSheet(ws, widths, freeze = 'A2') {
  ws['!cols'] = widths.map(col);
  ws['!freeze'] = { xSplit: 0, ySplit: 1, topLeftCell: freeze, activePane: 'bottomLeft', state: 'frozen' };
  ws['!autofilter'] = { ref: ws['!ref'] };
  return ws;
}

/** A fingerprint of exactly what was audited and under which thresholds.
 *
 *  Re-running the same expense report against the same receipts with the same
 *  policy produces the same hash, and therefore the same findings. That is what
 *  lets an auditor defend a conclusion months later: they can show the run was
 *  reproducible rather than asking a reviewer to trust a one-off answer. An
 *  LLM-based tool cannot offer this, because it cannot promise the same output
 *  twice.
 *
 *  Returns null on an insecure origin (crypto.subtle needs https or localhost),
 *  in which case the workbook simply says the hash was unavailable rather than
 *  printing something untrue. */
export async function runHash(results, policy, budget = null, statement = null) {
  if (!globalThis.crypto?.subtle) return null;
  const material = JSON.stringify({
    ruleset: RULESET_VERSION,
    policy,
    rows: results.map((r) => [
      r.row.txnId, r.row.date, r.row.vendor, r.row.category,
      r.row.amount, r.row.currency, r.row.receiptFile,
      r.extraction?.tier ?? null,
      r.extraction?.fields?.total ?? null,
      r.findings.map((f) => f.code).sort(),
    ]),
    // Only present when a budget was reconciled, so every hash produced before
    // this feature existed still reproduces byte for byte.
    ...(budget ? { budgetLines: budget.lines } : {}),
    // Same rule for the card statement: absent means absent, and the parsed
    // lines (not the raw file) are what the reconciliation actually consumed.
    ...(statement ? {
      statementLines: statement.map((s) => [s.line, s.date, s.description, s.amount, s.currency]),
    } : {}),
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Per-currency sums over result rows, largest first.
 *
 *  Adding euro, yen and dollar figures into one number and labelling it USD is
 *  simply false, and that is what the "Value flagged" tile and the Summary tab
 *  used to do. Anything money-shaped that spans rows goes through here. */
export function sumsByCurrency(results, keep = () => true) {
  const sums = new Map();
  for (const r of results) {
    if (!keep(r) || typeof r.row.amount !== 'number') continue;
    const cur = String(r.row.currency || 'USD').toUpperCase();
    sums.set(cur, (sums.get(cur) || 0) + r.row.amount);
  }
  return [...sums.entries()]
    .map(([c, v]) => [c, Number(v.toFixed(2))])
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
}

/** One line per employee: exception count, review count, flagged value.
 *
 *  Auditors think per person — "who do I call first" — and pivoting the Detail
 *  tab by hand every close is busywork. Ordered by each employee's largest
 *  single-currency flagged value; the flagged figures themselves stay per
 *  currency, because a summed EUR+USD number beside a named person would be
 *  the exact defect sumsByCurrency exists to prevent, at finer grain. */
export function employeeBreakdown(results) {
  const byEmp = new Map();
  for (const r of results) {
    const key = String(r.row.employee || '').trim() || '(no employee)';
    if (!byEmp.has(key)) byEmp.set(key, []);
    byEmp.get(key).push(r);
  }
  return [...byEmp.entries()]
    .map(([employee, rs]) => ({
      employee,
      exceptions: rs.filter((x) => x.status === 'exception').length,
      review: rs.filter((x) => x.status === 'needs-review').length,
      flagged: sumsByCurrency(rs, (x) => x.status !== 'clean'),
    }))
    .sort((a, b) =>
      Math.abs(b.flagged[0]?.[1] ?? 0) - Math.abs(a.flagged[0]?.[1] ?? 0) ||
      a.employee.localeCompare(b.employee));
}

export function buildWorkbook(XLSX, results, meta) {
  const wb = XLSX.utils.book_new();
  const { policy, generatedAt, reportName, receiptCount, ocrCount, hash } = meta;

  const exceptions = results.filter((r) => r.status === 'exception');
  const review = results.filter((r) => r.status === 'needs-review');
  const clean = results.filter((r) => r.status === 'clean');

  // Per currency, never added together across currencies.
  const claimedBy = sumsByCurrency(results);
  const flaggedBy = sumsByCurrency(results, (r) => r.status !== 'clean');

  // ---- Summary -----------------------------------------------------------
  const summary = [
    ['Expense audit summary'],
    [],
    ['Report', reportName || 'expense report'],
    ['Generated', generatedAt],
    ['Ruleset version', RULESET_VERSION],
    ['Run hash (SHA-256)', hash || 'unavailable on this origin'],
    ['', 'Re-running the same inputs under the same policy reproduces this hash.'],
    [],
    ['Transactions examined', results.length],
    ['Support documents read', receiptCount],
    ['  of which needed OCR', ocrCount],
    [],
    ['Clean', clean.length],
    ['Needs review (soft signals)', review.length],
    ['Exceptions (require a decision)', exceptions.length],
    [],
    ...claimedBy.map(([cur, v]) => [`Total claimed (${cur})`, v]),
    ...claimedBy.map(([cur, v]) => {
      const fl = flaggedBy.find(([c]) => c === cur)?.[1] ?? 0;
      return [`Value on flagged rows (${cur})`, `${fl} (${v ? ((fl / v) * 100).toFixed(1) : '0.0'}%)`];
    }),
    [],
    ['Findings by rule'],
  ];

  const byRule = new Map();
  for (const r of results) {
    for (const f of r.findings) {
      if (f.severity === SEVERITY.INFO) continue;
      byRule.set(f.code, (byRule.get(f.code) || 0) + 1);
    }
  }
  for (const [code, n] of [...byRule].sort((a, b) => b[1] - a[1])) summary.push([`  ${code}`, n]);

  summary.push([], ['By employee', 'Exceptions', 'Needs review', 'Value on flagged rows']);
  for (const e of employeeBreakdown(results)) {
    summary.push([
      `  ${e.employee}`, e.exceptions, e.review,
      e.flagged.map(([cur, v]) => `${v.toFixed(2)} ${cur}`).join(' + ') || '—',
    ]);
  }

  if (meta.budget) {
    summary.push([], ['Budget reconciliation (details on the Budget Recon tab)']);
    summary.push(['  Budget lines checked', meta.budget.lines.length]);
    summary.push(['  Over budget', meta.budget.lines.filter((l) => l.status === 'over').length]);
    summary.push(['  Could not be verified', meta.budget.lines.filter((l) => l.status === 'unverified').length]);
  }

  if (meta.statement) {
    summary.push([], ['Card statement reconciliation (details on the Statement Recon tab)']);
    summary.push(['  Statement charges considered', meta.statement.lineCount]);
    summary.push(['  Matched to expense rows', meta.statement.recon.matchedCount]);
    summary.push(['  Charges never expensed (UNCLAIMED_CHARGE)', meta.statement.recon.unclaimed.length]);
    summary.push(['  Expense rows with no charge (CLAIMED_NOT_ON_STATEMENT)', meta.statement.recon.notOnStatement.length]);
  }

  const wsSummary = XLSX.utils.aoa_to_sheet(summary);
  wsSummary['!cols'] = [col(34), col(46), col(13), col(24)];
  XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary');

  // ---- Audit Detail ------------------------------------------------------
  const detailHeader = [
    'Txn ID', 'Employee', 'Date', 'Vendor', 'Category', 'Claimed', 'Currency',
    'Receipt File', 'Receipt Total', 'Receipt Date', 'Receipt Vendor',
    'Read By', 'Confidence', 'Status', 'Hard', 'Soft', 'Findings',
  ];
  const detail = [detailHeader];
  for (const r of results) {
    const f = r.extraction?.fields || {};
    detail.push([
      r.row.txnId, r.row.employee, r.row.date, r.row.vendor, r.row.category,
      r.row.amount, r.row.currency, r.row.receiptFile || '',
      f.total ?? '', f.date ?? '', f.vendor ?? '',
      r.extraction ? (r.extraction.tier === 'text' ? 'PDF text layer' : r.extraction.tier === 'ocr' ? 'OCR' : 'could not read') : 'no receipt',
      r.extraction ? `${Math.round(r.extraction.confidence)}%` : '',
      STATUS_LABEL[r.status], r.hardCount, r.softCount,
      r.findings.map((x) => `${x.code}: ${x.message}`).join('\n'),
    ]);
  }
  const wsDetail = XLSX.utils.aoa_to_sheet(detail);
  styleSheet(wsDetail, [10, 20, 11, 26, 20, 11, 9, 16, 13, 12, 26, 15, 11, 13, 7, 7, 90]);
  XLSX.utils.book_append_sheet(wb, wsDetail, 'Audit Detail');

  // ---- Exceptions --------------------------------------------------------
  // One row per finding, not per transaction, so a reviewer signs off on each
  // issue individually rather than on a row that had three different problems.
  const excHeader = [
    'Txn ID', 'Severity', 'Rule', 'What was found', 'Claimed', 'Per receipt',
    'Difference', 'Threshold', 'Receipt File', 'Ruleset',
    'Reviewer decision', 'Reviewer', 'Date reviewed', 'Note',
  ];
  const exc = [excHeader];
  const order = { hard: 0, soft: 1, info: 2 };
  const flat = [];
  for (const r of results) {
    for (const f of r.findings) {
      if (f.severity === SEVERITY.INFO) continue;
      flat.push({ r, f });
    }
  }
  flat.sort((a, b) => (order[a.f.severity] - order[b.f.severity]) || a.r.row.txnId.localeCompare(b.r.row.txnId));
  // Decisions made in the evidence drawer pre-fill the sign-off columns.
  // Anything undecided stays blank: a blank means the item is still open.
  const REVIEW_LABEL = { approved: 'Approved', rejected: 'Rejected', 'follow-up': 'Needs follow-up' };
  for (const { r, f } of flat) {
    const rv = meta.reviews?.get(`${r.row.txnId}::${f.code}`);
    exc.push([
      r.row.txnId,
      f.severity === SEVERITY.HARD ? 'Exception' : 'Review',
      f.code, f.message,
      f.claimed ?? r.row.amount ?? '',
      f.receipt ?? r.extraction?.fields?.total ?? '',
      f.difference ?? '',
      f.threshold ?? '',
      r.row.receiptFile || '',
      f.ruleset,
      rv?.decision ? REVIEW_LABEL[rv.decision] ?? '' : '',
      rv?.reviewer ?? '',
      rv?.date ?? '',
      rv?.note ?? '',
    ]);
  }
  const wsExc = XLSX.utils.aoa_to_sheet(exc);
  styleSheet(wsExc, [10, 11, 22, 82, 11, 12, 11, 11, 16, 9, 18, 16, 14, 34]);
  XLSX.utils.book_append_sheet(wb, wsExc, 'Exceptions');

  // ---- Budget Recon ------------------------------------------------------
  // Only present when the workbook carried a budget to reconcile against.
  if (meta.budget) {
    const BUDGET_STATUS = { ok: 'Within budget', over: 'OVER BUDGET', unspent: 'Unspent', unverified: 'Unverified' };
    const bud = [
      ['Budget reconciliation'],
      [],
      ['Read from sheet', meta.budget.sheetName || ''],
      ['Rule', 'Each budget line is compared only to spend in its own currency. Nothing was converted between currencies.'],
      [],
      ['Budget line', 'Currency', 'Budget', 'Spent', 'Difference', 'Status'],
      ...meta.budget.lines.map((l) => [
        l.label, l.currency ?? 'not stated', l.budget,
        l.actual ?? '', l.delta ?? '', BUDGET_STATUS[l.status] ?? l.status,
      ]),
    ];
    if (meta.budget.findings.length) {
      bud.push([], ['Findings']);
      for (const f of meta.budget.findings) bud.push([f.code, f.message]);
    }
    // The one labelled conversion in the whole workbook: rates the user typed.
    if (meta.budget.fx) {
      const fx = meta.budget.fx;
      bud.push([], ['At your stated rates (estimate only)']);
      for (const [c, r] of fx.rates) bud.push([`  1 ${c}`, `${r} ${fx.base}`]);
      bud.push([`  Converted budget (${fx.base})`, fx.totals.budget]);
      bud.push([`  Converted spend (${fx.base})`, fx.totals.actual]);
      bud.push([`  Difference (${fx.base})`, fx.totals.delta]);
      if (fx.missingRates.length) bud.push(['  No rate entered for', fx.missingRates.join(', ')]);
      if (fx.excluded.length) bud.push(['  Left out (no stated currency)', fx.excluded.join(', ')]);
      bud.push(['  Rule', 'Converted at rates the user typed by hand, for orientation only. Every finding and every line above compares within one currency.']);
    }
    const wsBud = XLSX.utils.aoa_to_sheet(bud);
    wsBud['!cols'] = [26, 11, 12, 12, 12, 110].map(col);
    XLSX.utils.book_append_sheet(wb, wsBud, 'Budget Recon');
  }

  // ---- Statement Recon ---------------------------------------------------
  // Only present when the user supplied a card-statement export.
  if (meta.statement) {
    const st = meta.statement;
    const stm = [
      ['Card statement reconciliation'],
      [],
      ['Statement file', st.fileName || ''],
      ['Statement charges considered', st.lineCount],
      ['Payment / credit lines skipped', st.skipped],
      ['Rule', `A charge matches an expense row when the amounts agree within ` +
        `${policy.amountToleranceAbs.toFixed(2)} and the dates within ` +
        `${policy.statementDateToleranceDays} days, in the same currency when both state one. ` +
        `Amounts are compared as absolute values because issuers disagree on sign. ` +
        `Matching is one-to-one: a charge absolves at most one row.`],
      [],
      ['Matched', st.recon.matchedCount],
      ['Charges never expensed (UNCLAIMED_CHARGE, exception)', st.recon.unclaimed.length],
      ['Expense rows with no charge (CLAIMED_NOT_ON_STATEMENT, review)', st.recon.notOnStatement.length],
    ];
    if (st.recon.unclaimed.length) {
      stm.push([], ['Unclaimed charges'], ['Statement line', 'Date', 'Description', 'Amount', 'Currency']);
      for (const s of st.recon.unclaimed) {
        stm.push([s.line, s.date, s.description, s.amount, s.currency ?? '']);
      }
    }
    if (st.recon.notOnStatement.length) {
      stm.push([], ['Expense rows with no matching charge (flagged on the Exceptions tab)'],
        [st.recon.notOnStatement.join(', ')]);
    }
    const wsStm = XLSX.utils.aoa_to_sheet(stm);
    wsStm['!cols'] = [26, 12, 40, 12, 10].map(col);
    XLSX.utils.book_append_sheet(wb, wsStm, 'Statement Recon');
  }

  // ---- Methodology -------------------------------------------------------
  // Stating the limits is not a disclaimer, it is the part that makes the
  // report honest. A reader must know what was NOT verified.
  const method = [
    ['Methodology and limits'],
    [],
    ['Ruleset version', RULESET_VERSION],
    ['Generated', generatedAt],
    [],
    ['How each receipt was read'],
    ['  1. PDF text layer', 'Exact. Used whenever the PDF carries real text.'],
    ['  2. OCR', 'Used only for image-only PDFs. Confidence is reported per row.'],
    ['  3. Neither', 'Flagged as UNREADABLE_RECEIPT for manual check. Never guessed.'],
    [],
    ['What this report does NOT do'],
    meta.statement
      ? ['  Card statement compared from a local file only', 'The supplied statement export was reconciled line by line against the expense rows (see the Statement Recon tab). No bank connection exists; only the file the user chose was read.']
      : ['  No bank or card statement was compared', 'Only the expense report and its attached documents were examined. A charge could exist with no row at all and this report would not see it.'],
    ['  Business purpose was not judged', 'Whether a stated purpose is genuine is a human judgement and was not assessed.'],
    ['  Mileage and per-diem rows cannot be verified', 'These have no support document by nature. Only arithmetic plausibility can be checked.'],
    ['  Categories exempted from the receipt requirement',
      (policy.noReceiptCategories || []).length
        ? `${policy.noReceiptCategories.join(', ')}. Rows in these categories were not asked for a receipt at any amount. They were still checked for date, place and business purpose.`
        : 'None. Every row was held to the receipt requirement.'],
    ['  Currencies were never converted', 'Every comparison — row against receipt, spend against budget — happens within one currency. Cross-currency figures are flagged for a human, not converted with a rate this tool would have to guess.'],
    ['  Vendor matching is a similarity score', 'Names are compared fuzzily. The score and threshold are recorded on each finding so a reviewer can second-guess it.'],
    ['  Nothing was auto-cleared', 'Every exception needs a human decision. A blank reviewer column means the item is still open.'],
    [],
    ['Thresholds applied'],
    ['  Receipt required at or above', policy.receiptRequiredAtOrAbove],
    ['  Itemization required at or above', policy.itemizationRequiredAtOrAbove],
    ['  Amount tolerance', policy.amountToleranceAbs],
    ['  Tip tolerance', `${(policy.tipTolerancePct * 100).toFixed(0)}%`],
    ['  Date tolerance (days)', policy.dateToleranceDays],
    ['  Vendor similarity threshold', policy.vendorSimilarityThreshold],
    ['  Approval threshold', policy.approvalThreshold],
    ['  Split-transaction window (days)', policy.splitWindowDays],
    ['  Stale submission (days)', policy.staleSubmissionDays],
    [],
    ['Category limits'],
    ...Object.entries(policy.categoryLimits).map(([k, v]) => [`  ${k}`, v]),
    [],
    ['Processing location', 'Every document was read inside this browser on this computer. No file, page or extracted value was uploaded anywhere.'],
  ];
  const wsMethod = XLSX.utils.aoa_to_sheet(method);
  wsMethod['!cols'] = [col(38), col(100)];
  XLSX.utils.book_append_sheet(wb, wsMethod, 'Methodology');

  return wb;
}

export function downloadWorkbook(XLSX, wb, filename) {
  XLSX.writeFile(wb, filename, { compression: true });
}
