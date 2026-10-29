const { test, expect } = require('@playwright/test');

// A shared break is fully described by the join link, so two independent
// browsers with the same wall clock must show the same cigarette.
const T0 = new Date('2026-10-29T10:00:00Z').getTime();

async function openPage(browser, baseURL, time, path = '/') {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, route => route.abort());
  // Frozen clock: time moves only when a test moves it, so both phones stay comparable.
  await page.clock.install({ time: time - 1000 });
  await page.clock.pauseAt(time);
  await page.goto(path);
  return page;
}

async function lightAndInvite(page) {
  await page.locator('#lightBtn').click();
  await page.locator('#inviteBtn').click();
  await expect(page.locator('#invite')).toBeVisible();
  return page.locator('#qr').getAttribute('data-url');
}

const state = page => page.evaluate(() => ({
  topic: S.topic,
  clock: document.getElementById('clock').textContent,
  revealed: document.querySelectorAll('#follow li.on').length,
  paper: document.getElementById('paper').style.width,
}));

test('a guest who scans the invite joins the same moment of the same break', async ({ browser, baseURL }) => {
  const host = await openPage(browser, baseURL, T0);
  const url = await lightAndInvite(host);
  expect(url).toMatch(/#join=2\.\d+\.[0-9a-z]+\.\d+\.[0-9a-z]{2}\.original$/);

  // Koral scans 90 seconds later.
  await host.clock.fastForward(90000);
  await host.clock.runFor(100);
  const guest = await openPage(browser, baseURL, T0 + 90000 + 100, url);
  await guest.clock.runFor(100);
  await host.clock.runFor(100);

  await expect(guest.locator('#litTag')).toHaveText('הצטרפת להפסקה');
  await expect(guest.locator('#cig')).toHaveClass(/lit/);
  const [h, g] = [await state(host), await state(guest)];
  expect(g.topic).toBe(h.topic);
  expect(g.clock).toBe(h.clock);
  expect(g.revealed).toBe(h.revealed);
  expect(parseFloat(g.paper)).toBeCloseTo(parseFloat(h.paper), 0);
  await expect(guest.locator('#topic')).toHaveText(await host.locator('#topic').textContent());

  // The link is consumed so a reload does not rejoin an old break.
  expect(new URL(guest.url()).hash).toBe('');

  // Both finish together.
  const left = await host.evaluate(() => S.start + S.dur - Date.now());
  for (const p of [host, guest]) {
    await p.clock.fastForward(left + 1000);
    await p.clock.runFor(100);
    await expect(p.locator('#doneBar')).toBeVisible();
    await expect(p.locator('#inviteBtn')).toBeHidden();
  }
  expect(host.errors).toEqual([]);
  expect(guest.errors).toEqual([]);
});

test('a guest can invite the next person with the same break', async ({ browser, baseURL }) => {
  const host = await openPage(browser, baseURL, T0);
  const url = await lightAndInvite(host);
  const guest = await openPage(browser, baseURL, T0 + 30000, url);
  await guest.locator('#inviteBtn').click();
  expect(await guest.locator('#qr').getAttribute('data-url')).toBe(url);
});

test('the invite shows a scannable QR code and can be closed', async ({ browser, baseURL }) => {
  const host = await openPage(browser, baseURL, T0);
  await lightAndInvite(host);
  const dark = await host.evaluate(() => {
    const c = document.getElementById('qr');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 100) n++;
    return n / (c.width * c.height);
  });
  expect(dark).toBeGreaterThan(0.2);
  expect(dark).toBeLessThan(0.6);
  await expect(host.locator('#inviteBtn')).toHaveAttribute('aria-expanded', 'true');
  await host.locator('#closeInvite').click();
  await expect(host.locator('#invite')).toBeHidden();
});

test('scanning after the break ended offers a new cigarette', async ({ browser, baseURL }) => {
  const host = await openPage(browser, baseURL, T0);
  const url = await lightAndInvite(host);
  const guest = await openPage(browser, baseURL, T0 + 301000, url);
  await expect(guest.locator('#joinMsg')).toContainText('כבר נגמרה');
  await expect(guest.locator('#idleView')).toBeVisible();
  await guest.locator('#lightBtn').click();
  await expect(guest.locator('#joinMsg')).toBeHidden();
  await expect(guest.locator('#litTag')).toHaveText('נושא לשיחה');
});

for (const [name, hash] of [
  ['garbage', '#join=hello'],
  ['unknown format', '#join=9.1.mh3k9x2.200.aa'],
  ['wrong checksum', '#join=1.0.mh3k9x2.200.zz'],
  ['impossible duration', '#join=1.0.mh3k9x2.9999.aa'],
]) {
  test(`a broken join link is rejected: ${name}`, async ({ browser, baseURL }) => {
    const page = await openPage(browser, baseURL, T0, '/' + hash);
    await expect(page.locator('#joinMsg')).toContainText('לא תקין');
    await expect(page.locator('#cig')).not.toHaveClass(/lit/);
    expect(page.errors).toEqual([]);
  });
}

test('a link from a phone whose clock is far ahead is rejected', async ({ browser, baseURL }) => {
  const host = await openPage(browser, baseURL, T0 + 10 * 60000);
  const url = await lightAndInvite(host);
  const guest = await openPage(browser, baseURL, T0, url);
  await expect(guest.locator('#joinMsg')).toContainText('לא תקין');
});
