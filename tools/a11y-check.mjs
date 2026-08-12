// Accessibility and interaction check: asserts the behaviours that are easy to
// break by accident and invisible when they do.
//
//   npm run serve          (in one terminal)
//   node tools/a11y-check.mjs
//
// browser-check.mjs proves the audit is CORRECT. This one proves the audit is
// USABLE: keyboard reach, focus return, sticky header, sort order, theme
// persistence, and severity that does not depend on colour. Every assertion
// here maps to a defect that shipped in the MVP, so it is a regression guard,
// not a checklist.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:8080';
const SHOTS = 'docs/screenshots';
const pass = (l) => console.log(`  PASS  ${l}`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(BASE, { waitUntil: 'networkidle' });

// ---- 1. file inputs are keyboard reachable (were [hidden] = untabbable) ----
for (const id of ['fileSheet', 'fileReceipts']) {
  const reachable = await page.evaluate((i) => {
    const el = document.getElementById(i);
    el.focus();
    return document.activeElement === el;
  }, id);
  assert.equal(reachable, true, `#${id} must be focusable`);
}
pass('both file pickers are keyboard focusable');

// Tab from the top actually reaches the sheet picker.
await page.evaluate(() => document.querySelector('.brand span').setAttribute('tabindex', '-1'));
await page.keyboard.press('Tab');
const tabOrder = [];
for (let i = 0; i < 12; i++) {
  tabOrder.push(await page.evaluate(() => document.activeElement?.id || document.activeElement?.className || document.activeElement?.tagName));
  await page.keyboard.press('Tab');
}
assert.ok(tabOrder.includes('fileSheet'), `fileSheet not in tab order: ${tabOrder.join(' > ')}`);
pass('sheet picker is reached by Tab from the top of the page');

// ---- 2. run the audit so the table exists ----
await page.click('#btnSample');
await page.waitForSelector('#step-results:not([hidden])', { timeout: 180000 });
await page.waitForFunction(() => document.querySelectorAll('#resultBody tr[data-txn]').length > 0);
pass('sample audit completed');

// ---- 3. sticky header actually sticks (the container is a real scrollport) ----
const sticky = await page.evaluate(() => {
  const wrap = document.querySelector('.tablewrap');
  const scrollable = wrap.scrollHeight > wrap.clientHeight;
  const before = document.querySelector('thead th').getBoundingClientRect().top;
  wrap.scrollTop = 400;
  const after = document.querySelector('thead th').getBoundingClientRect().top;
  wrap.scrollTop = 0;
  return { scrollable, before, after, moved: Math.abs(after - before) };
});
assert.equal(sticky.scrollable, true, 'tablewrap must actually scroll internally');
assert.ok(sticky.moved < 2, `header moved ${sticky.moved}px while scrolling 400px; it is not sticking`);
pass(`sticky header holds position through a 400px internal scroll (moved ${sticky.moved.toFixed(1)}px)`);

// ---- 4. keyboard can open the evidence panel (was mouse-only) ----
await page.evaluate(() => document.querySelector('#resultBody tr[data-txn] .rowbtn').focus());
await page.keyboard.press('Enter');
await page.waitForSelector('#panel:not([hidden])');
const focusInPanel = await page.evaluate(() => document.getElementById('panel').contains(document.activeElement));
assert.equal(focusInPanel, true, 'focus must move into the panel on open');
pass('Enter on a transaction id opens the panel and moves focus into it');

// ---- 5. Escape closes and returns focus to the row that opened it ----
await page.keyboard.press('Escape');
await page.waitForSelector('#panel[hidden]', { state: 'attached' });
const returned = await page.evaluate(() => document.activeElement?.classList.contains('rowbtn'));
assert.equal(returned, true, 'focus must return to the triggering row button');
pass('Escape closes the panel and returns focus to the triggering row');

// ---- 6. column sorting, including the blanks-last rule ----
const sortResult = await page.evaluate(() => {
  const txt = () => [...document.querySelectorAll('#resultBody tr[data-txn] td:nth-child(5)')]
    .map((td) => td.textContent.trim());
  const btn = document.querySelector('.th-sort[data-sort="claimed"]');
  btn.click();
  const asc = txt();
  const ariaAsc = btn.closest('th').getAttribute('aria-sort');
  btn.click();
  const desc = txt();
  const ariaDesc = btn.closest('th').getAttribute('aria-sort');
  btn.click();
  const ariaOff = btn.closest('th').getAttribute('aria-sort');
  return { asc, desc, ariaAsc, ariaDesc, ariaOff };
});
const num = (s) => parseFloat(s.replace(/[^0-9.]/g, ''));
const ascNums = sortResult.asc.map(num);
assert.deepEqual(ascNums, [...ascNums].sort((a, b) => a - b), 'ascending sort is not ascending');
assert.equal(sortResult.ariaAsc, 'ascending');
assert.equal(sortResult.ariaDesc, 'descending');
assert.equal(sortResult.ariaOff, null, 'third click must clear the sort back to report order');
pass('Claimed column sorts asc, desc, then back to report order, with correct aria-sort');

// ---- 7. blanks sort last in BOTH directions ----
const blanks = await page.evaluate(() => {
  const btn = document.querySelector('.th-sort[data-sort="receipt"]');
  const col = () => [...document.querySelectorAll('#resultBody tr[data-txn] td:nth-child(6)')]
    .map((td) => td.textContent.trim());
  btn.click();
  const asc = col();
  btn.click();
  const desc = col();
  btn.click();
  return { asc, desc };
});
for (const [dir, list] of [['ascending', blanks.asc], ['descending', blanks.desc]]) {
  const firstBlank = list.indexOf('—');
  if (firstBlank !== -1) {
    assert.ok(list.slice(firstBlank).every((v) => v === '—'),
      `blanks are not grouped last when ${dir}`);
  }
}
pass('rows with no receipt value sort last in both directions');

// ---- 8. theme toggle drives the attribute and survives a reload ----
await page.click('.themebtn[data-theme-value="dark"]');
assert.equal(await page.getAttribute('html', 'data-theme'), 'dark');
// The switch cross-fades over --dur. Measuring or screenshotting straight after
// the click catches it mid-transition and reads the OLD theme's colours.
await page.waitForTimeout(400);
const painted = await page.evaluate(() => {
  const on = document.querySelector('.themebtn[aria-pressed="true"]');
  return { value: on?.dataset.themeValue, bg: getComputedStyle(on).backgroundColor };
});
assert.equal(painted.value, 'dark');
assert.notEqual(painted.bg, 'rgba(0, 0, 0, 0)', 'selected theme button must actually paint its surface');
await page.screenshot({ path: `${SHOTS}/04-dark.png`, fullPage: false });
await page.reload({ waitUntil: 'networkidle' });
assert.equal(await page.getAttribute('html', 'data-theme'), 'dark', 'theme must persist across reload');
const pressed = await page.getAttribute('.themebtn[data-theme-value="dark"]', 'aria-pressed');
assert.equal(pressed, 'true', 'active theme button must report aria-pressed=true');
pass('theme toggle sets data-theme, persists across reload, and reports aria-pressed');

await page.click('.themebtn[data-theme-value="system"]');
assert.equal(await page.getAttribute('html', 'data-theme'), null);
pass('system option clears the override');

// ---- 9. no side-stripe borders anywhere (impeccable absolute ban) ----
await page.click('#btnSample');
await page.waitForSelector('#step-results:not([hidden])', { timeout: 180000 });
// An exception row specifically: a clean row has no findings to inspect, and
// the severity styling only exists on findings.
const exceptionTxn = await page.evaluate(() => [...document.querySelectorAll('#resultBody tr[data-txn]')]
  .find((tr) => tr.querySelector('.pill.exception'))?.dataset.txn);
assert.ok(exceptionTxn, 'expected at least one exception row in the sample audit');
await page.click(`#resultBody tr[data-txn="${exceptionTxn}"]`);
await page.waitForSelector('#panel:not([hidden])');
const stripes = await page.evaluate(() => {
  const bad = [];
  for (const el of document.querySelectorAll('*')) {
    const s = getComputedStyle(el);
    for (const side of ['Left', 'Right']) {
      const w = parseFloat(s[`border${side}Width`]);
      const others = ['Top', 'Bottom', side === 'Left' ? 'Right' : 'Left']
        .map((o) => parseFloat(s[`border${o}Width`]));
      // A thick vertical border with thin/absent siblings is the stripe pattern.
      if (w > 1.5 && others.every((o) => o < w - 0.5)) {
        bad.push(`${el.tagName}.${el.className} border-${side.toLowerCase()}: ${w}px`);
      }
    }
  }
  return bad;
});
assert.deepEqual(stripes, [], `side-stripe borders found: ${stripes.join(', ')}`);
pass('no side-stripe accent borders remain');

// ---- 10. every finding states its severity in words, not colour alone ----
const sev = await page.evaluate(() =>
  [...document.querySelectorAll('#panelFindings .finding')]
    .map((f) => f.querySelector('.finding-sev')?.textContent.trim() ?? null));
assert.ok(sev.length > 0 && sev.every((s) => s === 'Exception' || s === 'Needs review'),
  `findings missing a written severity: ${JSON.stringify(sev)}`);
pass(`findings carry a written severity label (${[...new Set(sev)].join(', ')})`);

// ---- 11. progressbar exposes its value ----
const prog = await page.evaluate(() => {
  const el = document.querySelector('[role="progressbar"]');
  return { now: el.getAttribute('aria-valuenow'), max: el.getAttribute('aria-valuemax') };
});
assert.equal(prog.now, '100');
assert.equal(prog.max, '100');
pass('progress bar reports aria-valuenow to assistive tech');

// ---- 12. WCAG AA text contrast, measured on the rendered page ----
// Token arithmetic on paper misses what actually lands on screen: inherited
// colours, tinted parent surfaces, and rules that only apply in one theme.
const CONTRAST_AUDIT = `(() => {
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const rgb = (s) => (s.match(/[\\d.]+/g) || []).slice(0, 3).map(Number);
  const alpha = (s) => { const p = (s.match(/[\\d.]+/g) || []); return p.length > 3 ? Number(p[3]) : 1; };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
  const backdrop = (el) => {
    for (let n = el; n && n !== document.documentElement.parentNode; n = n.parentElement) {
      const bg = getComputedStyle(n).backgroundColor;
      if (alpha(bg) > 0.95) return rgb(bg);
    }
    return rgb(getComputedStyle(document.body).backgroundColor);
  };
  const bad = [];
  for (const el of document.querySelectorAll('body *')) {
    if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') continue;
    const direct = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!direct) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.opacity === '0') continue;
    const size = parseFloat(cs.fontSize);
    const weight = parseInt(cs.fontWeight, 10) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const need = large ? 3 : 4.5;
    const got = ratio(rgb(cs.color), backdrop(el));
    if (got < need) {
      bad.push(el.tagName.toLowerCase() + '.' + (el.className || '?') + ' ' +
        size.toFixed(0) + 'px w' + weight + ' ' + got.toFixed(2) + ':1 (needs ' + need + ')');
    }
  }
  return [...new Set(bad)];
})()`;

for (const theme of ['light', 'dark']) {
  // The drawer covers the theme switch, so close it, switch, then reopen it:
  // the audit is worth more with the finding and compare styles on screen.
  await page.keyboard.press('Escape');
  await page.waitForSelector('#panel[hidden]', { state: 'attached' });
  await page.click(`.themebtn[data-theme-value="${theme}"]`);
  await page.waitForTimeout(400);
  await page.click(`#resultBody tr[data-txn="${exceptionTxn}"]`);
  await page.waitForSelector('#panel:not([hidden])');
  const fails = await page.evaluate(CONTRAST_AUDIT);
  assert.deepEqual(fails, [], `${theme} theme contrast failures:\n    ` + fails.join('\n    '));
  pass(`every rendered text node meets WCAG AA in the ${theme} theme`);
}
await page.keyboard.press('Escape');
await page.waitForSelector('#panel[hidden]', { state: 'attached' });
await page.click('.themebtn[data-theme-value="system"]');

// ---- 13. mobile: no horizontal page scroll ----
await page.keyboard.press('Escape');          // measure the page, not the open drawer
await page.waitForSelector('#panel[hidden]', { state: 'attached' });
await page.setViewportSize({ width: 375, height: 780 });
await page.waitForTimeout(200);
const overflow = await page.evaluate(() =>
  document.documentElement.scrollWidth - document.documentElement.clientWidth);
assert.ok(overflow <= 1, `page scrolls horizontally by ${overflow}px at 375px wide`);
pass('no horizontal page scroll at 375px');
await page.screenshot({ path: `${SHOTS}/05-mobile.png`, fullPage: false });

assert.deepEqual(errors, [], `console errors: ${errors.join(' | ')}`);
pass('no console errors across the whole run');

await browser.close();
console.log('\nAll polish checks passed.\n');
