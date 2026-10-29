const { test, expect } = require('@playwright/test');

// Every look is checked from this one list, so a new look is tested by adding its id here.
const LOOKS = ['original', 'foundation', 'burrow'];
const T0 = new Date('2026-10-29T10:00:00Z').getTime();

async function openPage(browser, baseURL, { look, time = T0, path = '/' } = {}) {
  const context = await browser.newContext({ baseURL });
  if (look) await context.addInitScript(l => localStorage.setItem('break.look', JSON.stringify(l)), look);
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, route => route.abort());
  await page.clock.install({ time: time - 1000 });
  await page.clock.pauseAt(time);
  await page.goto(path);
  return page;
}

// WCAG AA contrast of every visible piece of text against what is really behind it.
function contrastReport() {
  const parse = c => (c.match(/[\d.]+/g) || []).map(Number);
  const lum = ([r, g, b]) => {
    const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const bgOf = el => {
    for (let e = el; e; e = e.parentElement) {
      const c = parse(getComputedStyle(e).backgroundColor);
      if (c.length === 3 || (c.length === 4 && c[3] > 0)) return c.slice(0, 3);
    }
    return [255, 255, 255];
  };
  const sel = 'h1, .sub, .eyebrow, .pack-name, .hint, #status, #clock, .tag, .card h2, .card p, .follow .n, .follow .q, .btn, .done strong, .invite strong, .invite p, .msg, .warning, .warning b, footer';
  const out = [];
  for (const el of document.querySelectorAll(sel)) {
    if (!el.getClientRects().length || !el.textContent.trim()) continue;
    const cs = getComputedStyle(el);
    let fg = parse(cs.color);
    const bg = bgOf(el);
    if (fg.length === 4) fg = fg.slice(0, 3).map((v, i) => v * fg[3] + bg[i] * (1 - fg[3]));
    const [a, b] = [lum(fg), lum(bg)];
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const size = parseFloat(cs.fontSize), bold = parseInt(cs.fontWeight, 10) >= 700;
    const min = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
    if (ratio < min) out.push(`${el.className || el.tagName} "${el.textContent.trim().slice(0, 20)}": ${ratio.toFixed(2)} < ${min}`);
  }
  return out;
}

for (const look of LOOKS) {
  test.describe(`look: ${look}`, () => {
    test('loads, reads well and never scrolls sideways', async ({ browser, baseURL }) => {
      const page = await openPage(browser, baseURL, { look });
      await expect(page.locator('html')).toHaveAttribute('data-look', look);
      await expect(page.locator(`.pack[data-look="${look}"]`)).toHaveAttribute('aria-pressed', 'true');
      expect(await page.evaluate(contrastReport), 'idle').toEqual([]);

      await page.locator('#lightBtn').click();
      await page.locator('#inviteBtn').click();
      const dur = await page.evaluate(() => S.dur);
      await page.clock.fastForward(Math.ceil(dur * 0.4));
      await page.clock.runFor(100);
      expect(await page.evaluate(contrastReport), 'lit with invite').toEqual([]);

      const { scroll, client } = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      expect(scroll).toBeLessThanOrEqual(client);

      await page.clock.fastForward(dur);
      await page.clock.runFor(100);
      await expect(page.locator('#doneBar')).toBeVisible();
      expect(await page.evaluate(contrastReport), 'done').toEqual([]);
      expect(page.errors).toEqual([]);
    });

    test('smoke and QR take their colours from the look', async ({ browser, baseURL }) => {
      const page = await openPage(browser, baseURL, { look });
      await page.locator('#lightBtn').click();
      await page.locator('#inviteBtn').click();
      const { smoke, token, corner, qrBg } = await page.evaluate(() => {
        const css = getComputedStyle(document.documentElement);
        const c = document.getElementById('qr');
        const [r, g, b] = c.getContext('2d').getImageData(1, 1, 1, 1).data;
        return { smoke: smokeRGB, token: css.getPropertyValue('--smoke').trim(), corner: [r, g, b], qrBg: css.getPropertyValue('--qr-bg').trim() };
      });
      expect(smoke).toBe(token);
      const hex = '#' + corner.map(v => v.toString(16).padStart(2, '0')).join('');
      expect(hex.toLowerCase()).toBe(qrBg.toLowerCase());
    });
  });
}

test('the picker switches the look and remembers it', async ({ browser, baseURL }) => {
  const page = await openPage(browser, baseURL);
  await expect(page.locator('html')).toHaveAttribute('data-look', 'original');
  await expect(page.locator('.pack')).toHaveCount(LOOKS.length);

  await page.locator('.pack[data-look="burrow"]').click();
  await expect(page.locator('html')).toHaveAttribute('data-look', 'burrow');
  await expect(page.locator('.pack[data-look="burrow"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.pack[data-look="original"]')).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => document.getElementById('lookFonts').href)).toContain('Frank+Ruhl+Libre');

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-look', 'burrow');
});

for (const bogus of ['disco', 'constructor']) test(`an unknown saved look falls back to the original: ${bogus}`, async ({ browser, baseURL }) => {
  const page = await openPage(browser, baseURL, { look: bogus });
  await expect(page.locator('html')).toHaveAttribute('data-look', 'original');
  expect(page.errors).toEqual([]);
});

test('a guest sees the inviter\'s look during the break, then gets their own back', async ({ browser, baseURL }) => {
  const host = await openPage(browser, baseURL, { look: 'foundation' });
  await host.locator('#lightBtn').click();
  await host.locator('#inviteBtn').click();
  const url = await host.locator('#qr').getAttribute('data-url');
  expect(url).toMatch(/\.foundation$/);

  const guest = await openPage(browser, baseURL, { look: 'burrow', time: T0 + 20000, path: url });
  await expect(guest.locator('#litTag')).toHaveText('הצטרפת להפסקה');
  await expect(guest.locator('html')).toHaveAttribute('data-look', 'foundation');
  expect(await guest.evaluate(() => JSON.parse(localStorage.getItem('break.look')))).toBe('burrow');

  // Passing the invite on keeps the inviter's look.
  await guest.locator('#inviteBtn').click();
  expect(await guest.locator('#qr').getAttribute('data-url')).toBe(url);

  const left = await guest.evaluate(() => S.start + S.dur - Date.now());
  await guest.clock.fastForward(left + 1000);
  await guest.clock.runFor(100);
  await guest.locator('#againBtn').click();
  await expect(guest.locator('html')).toHaveAttribute('data-look', 'burrow');
  expect(guest.errors).toEqual([]);
});

test('an old join link (format 1) keeps the guest\'s own look', async ({ browser, baseURL }) => {
  const host = await openPage(browser, baseURL, { look: 'foundation' });
  await host.locator('#lightBtn').click();
  await host.locator('#inviteBtn').click();
  const v2 = await host.locator('#qr').getAttribute('data-url');
  const v1 = v2.replace('#join=2.', '#join=1.').replace(/\.foundation$/, '');

  const guest = await openPage(browser, baseURL, { look: 'burrow', time: T0 + 20000, path: v1 });
  await expect(guest.locator('#litTag')).toHaveText('הצטרפת להפסקה');
  await expect(guest.locator('html')).toHaveAttribute('data-look', 'burrow');
  expect(await guest.evaluate(() => S.topic)).toBe(await host.evaluate(() => S.topic));
});

test('a join link with an unknown look shows the original', async ({ browser, baseURL }) => {
  const host = await openPage(browser, baseURL);
  await host.locator('#lightBtn').click();
  await host.locator('#inviteBtn').click();
  const url = (await host.locator('#qr').getAttribute('data-url')).replace(/\.original$/, '.disco');

  const guest = await openPage(browser, baseURL, { look: 'burrow', time: T0 + 20000, path: url });
  await expect(guest.locator('#litTag')).toHaveText('הצטרפת להפסקה');
  await expect(guest.locator('html')).toHaveAttribute('data-look', 'original');
});

for (const [name, hash] of [
  ['format 1 with a look', '#join=1.0.mh3k9x2.200.aa.burrow'],
  ['format 2 without a look', '#join=2.0.mh3k9x2.200.aa'],
]) {
  test(`a malformed join link is rejected: ${name}`, async ({ browser, baseURL }) => {
    const page = await openPage(browser, baseURL, { look: 'burrow', path: '/' + hash });
    await expect(page.locator('#joinMsg')).toContainText('לא תקין');
    await expect(page.locator('html')).toHaveAttribute('data-look', 'burrow');
  });
}
