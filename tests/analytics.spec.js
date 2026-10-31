const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const T0 = new Date('2026-10-29T10:00:00Z').getTime();

async function openPage(browser, baseURL, { time = T0, path: p = '/', look } = {}) {
  const context = await browser.newContext({ baseURL });
  if (look) await context.addInitScript(l => localStorage.setItem('break.look', JSON.stringify(l)), look);
  const page = await context.newPage();
  page.errors = [];
  page.google = [];
  page.on('pageerror', e => page.errors.push(e.message));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, route => route.abort());
  // Nothing may ever reach Google from a test; record any attempt instead.
  await page.route(/google(tagmanager|-analytics)\.com/, route => { page.google.push(route.request().url()); route.abort(); });
  await page.clock.install({ time: time - 1000 });
  await page.clock.pauseAt(time);
  await page.goto(p);
  return page;
}

// gtag pushes its `arguments` objects onto dataLayer; turn them into plain arrays.
const calls = page => page.evaluate(() => window.dataLayer.map(a => Array.from(a)));
const events = async (page, name) => (await calls(page)).filter(c => c[0] === 'event' && c[1] === name).map(c => c[2]);

test('configured without cookies, signals or ad personalisation', async ({ browser, baseURL }) => {
  const page = await openPage(browser, baseURL);
  const config = (await calls(page)).find(c => c[0] === 'config');
  expect(config[1]).toBe('G-V8062TEJE6');
  expect(config[2]).toMatchObject({
    client_storage: 'none',
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
  });
  expect(await page.evaluate(() => document.cookie)).toBe('');
});

test('nothing is loaded from Google outside the live site', async ({ browser, baseURL }) => {
  const page = await openPage(browser, baseURL);
  await page.locator('#lightBtn').click();
  expect(await page.locator('script[src*="googletagmanager"]').count()).toBe(0);
  expect(page.google).toEqual([]);
});

test('on the live site Google\'s script loads with our ID', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const requested = [];
  await page.route(/fonts\.(googleapis|gstatic)\.com/, route => route.abort());
  await page.route('https://liori9.github.io/cigarette-break/**', route => {
    const rel = new URL(route.request().url()).pathname.replace('/cigarette-break/', '') || 'index.html';
    route.fulfill({ path: path.join(ROOT, rel), contentType: rel.endsWith('.js') ? 'text/javascript' : 'text/html' });
  });
  await page.route(/googletagmanager\.com/, route => { requested.push(route.request().url()); route.fulfill({ body: '', contentType: 'text/javascript' }); });
  await page.goto('https://liori9.github.io/cigarette-break/');
  await expect.poll(() => requested.length).toBe(1);
  expect(requested[0]).toBe('https://www.googletagmanager.com/gtag/js?id=G-V8062TEJE6');
});

for (const [method, act] of [
  ['button', page => page.locator('#lightBtn').click()],
  ['tap', page => page.locator('#cig').click()],
  ['match', async page => {
    const head = await page.locator('#match .head').boundingBox();
    const tip = await page.locator('#paper').boundingBox();
    await page.mouse.move(head.x + 4, head.y + head.height / 2);
    await page.mouse.down();
    await page.mouse.move(tip.x + 4, tip.y + tip.height / 2, { steps: 12 });
    await page.mouse.up();
  }],
]) {
  test(`lighting by ${method} is counted once, with the look`, async ({ browser, baseURL }) => {
    const page = await openPage(browser, baseURL, { look: 'burrow' });
    await act(page);
    await expect(page.locator('#cig')).toHaveClass(/lit/);
    expect(await events(page, 'break_lit')).toEqual([{ method, look: 'burrow' }]);
    expect(await events(page, 'break_done')).toEqual([]);
    expect(page.errors).toEqual([]);
  });
}

test('a finished break is counted once; a new cigarette counts again', async ({ browser, baseURL }) => {
  const page = await openPage(browser, baseURL);
  await page.locator('#lightBtn').click();
  const dur = await page.evaluate(() => S.dur);
  await page.clock.fastForward(dur / 2);
  await page.clock.runFor(100);
  expect(await events(page, 'break_done')).toEqual([]);

  await page.clock.fastForward(dur);
  await page.clock.runFor(500);
  expect(await events(page, 'break_done')).toEqual([{ look: 'original' }]);

  await page.locator('#againBtn').click();
  await page.locator('#lightBtn').click();
  expect(await events(page, 'break_lit')).toHaveLength(2);
});

test('joining is counted with the inviter\'s look, and the join link never reaches the page address', async ({ browser, baseURL }) => {
  const host = await openPage(browser, baseURL, { look: 'foundation' });
  await host.locator('#lightBtn').click();
  await host.locator('#inviteBtn').click();
  const url = await host.locator('#qr').getAttribute('data-url');

  const guest = await openPage(browser, baseURL, { time: T0 + 20000, path: url });
  await expect(guest.locator('#litTag')).toHaveText('הצטרפת להפסקה');
  expect(await events(guest, 'break_lit')).toEqual([{ method: 'join', look: 'foundation' }]);

  const config = (await calls(guest)).find(c => c[0] === 'config');
  expect(config[2].page_location).toBe(new URL(url).origin + '/');
  expect(JSON.stringify(await calls(guest))).not.toContain('join=');
});

test('the app keeps working when an ad blocker blocks Google\'s script', async ({ browser }) => {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, route => route.abort());
  await page.route('https://liori9.github.io/cigarette-break/**', route => {
    const rel = new URL(route.request().url()).pathname.replace('/cigarette-break/', '') || 'index.html';
    route.fulfill({ path: path.join(ROOT, rel), contentType: rel.endsWith('.js') ? 'text/javascript' : 'text/html' });
  });
  await page.route(/googletagmanager\.com/, route => route.abort('blockedbyclient'));
  await page.goto('https://liori9.github.io/cigarette-break/');
  await page.locator('#lightBtn').click();
  await expect(page.locator('#cig')).toHaveClass(/lit/);
  await expect(page.locator('#topic')).not.toBeEmpty();
  expect(errors).toEqual([]);
});
