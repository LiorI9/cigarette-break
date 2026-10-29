const { test, expect } = require('@playwright/test');

let errors;

test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', e => errors.push(e.message));
  // Fonts are cosmetic; keep the tests independent of the network.
  await page.route(/fonts\.(googleapis|gstatic)\.com/, route => route.abort());
  await page.clock.install();
  await page.goto('/');
});

test.afterEach(() => {
  expect(errors, 'page threw errors').toEqual([]);
});

// Move the fake clock forward by a fraction of the current cigarette and render a frame.
async function advance(page, fraction) {
  const dur = await page.evaluate(() => S.dur);
  await page.clock.fastForward(Math.ceil(dur * fraction));
  await page.clock.runFor(100);
}

const paperWidth = page => page.evaluate(() => parseFloat(document.getElementById('paper').style.width));

test('topics are well formed', async ({ page }) => {
  const topics = await page.evaluate(() => TOPICS);
  expect(topics.length).toBeGreaterThanOrEqual(90);
  for (const { t, q } of topics) {
    expect(t.length, 'empty topic').toBeGreaterThan(5);
    expect(q, `follow-ups for "${t}"`).toHaveLength(3);
    for (const x of q) expect(x.length, `empty follow-up in "${t}"`).toBeGreaterThan(1);
  }
  expect(new Set(topics.map(x => x.t)).size, 'duplicate topics').toBe(topics.length);
  await expect(page.locator('#count')).toContainText(String(topics.length));
});

test('opens unlit, in Hebrew and right-to-left', async ({ page }) => {
  await expect(page).toHaveTitle('הפסקת סיגריה');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('#idleView')).toBeVisible();
  await expect(page.locator('#litView')).toBeHidden();
  await expect(page.locator('#hint')).toBeVisible();
  await expect(page.locator('#clock')).toHaveText('-:--');
  await expect(page.locator('#cig')).not.toHaveClass(/lit/);
});

test('the button lights a cigarette of 3 to 5 minutes with a topic', async ({ page }) => {
  await page.locator('#lightBtn').click();
  await page.clock.runFor(100);
  await expect(page.locator('#cig')).toHaveClass(/lit/);
  await expect(page.locator('#idleView')).toBeHidden();
  await expect(page.locator('#topic')).not.toBeEmpty();
  await expect(page.locator('#follow li.locked')).toHaveCount(3);
  await expect(page.locator('#doneBar')).toBeHidden();
  const dur = await page.evaluate(() => S.dur);
  expect(dur).toBeGreaterThanOrEqual(180000);
  expect(dur).toBeLessThanOrEqual(300000);
});

test('tapping the cigarette lights it', async ({ page }) => {
  await page.locator('#cig').click();
  await expect(page.locator('#cig')).toHaveClass(/lit/);
});

test('dragging the match to the tip lights it', async ({ page }) => {
  const head = await page.locator('#match .head').boundingBox();
  const tip = await page.locator('#paper').boundingBox();
  await page.mouse.move(head.x + 4, head.y + head.height / 2);
  await page.mouse.down();
  await page.mouse.move(tip.x + 4, tip.y + tip.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect(page.locator('#cig')).toHaveClass(/lit/);
  await expect(page.locator('#match')).toHaveClass(/spent/);
});

test('dropping the match short of the tip does not light it', async ({ page }) => {
  const head = await page.locator('#match .head').boundingBox();
  await page.mouse.move(head.x + 4, head.y + head.height / 2);
  await page.mouse.down();
  await page.mouse.move(head.x - 10, head.y + 10, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator('#cig')).not.toHaveClass(/lit/);
  await expect(page.locator('#hint')).toContainText('כמעט');
});

test('the cigarette burns down and follow-ups appear one by one', async ({ page }) => {
  await page.locator('#lightBtn').click();
  await page.clock.runFor(100);
  const full = await paperWidth(page);
  const firstClock = await page.locator('#clock').textContent();

  await advance(page, 0.3);
  await expect(page.locator('#follow li.on')).toHaveCount(1);
  await expect(page.locator('#follow li.locked').first()).toContainText('שאלת המשך תעלה בעוד');
  const mid = await paperWidth(page);
  expect(mid).toBeLessThan(full);
  await expect(page.locator('#clock')).not.toHaveText(firstClock);

  await advance(page, 0.25);
  await expect(page.locator('#follow li.on')).toHaveCount(2);

  await advance(page, 0.25);
  await expect(page.locator('#follow li.on')).toHaveCount(3);
  expect(await paperWidth(page)).toBeLessThan(mid);

  const q = await page.evaluate(() => TOPICS[S.topic].q);
  await expect(page.locator('#follow .q')).toHaveText(q);
});

test('the cigarette ends and a new one can be lit', async ({ page }) => {
  await page.locator('#lightBtn').click();
  const first = await page.evaluate(() => S.topic);
  await advance(page, 1.01);
  await expect(page.locator('#doneBar')).toBeVisible();
  await expect(page.locator('#clock')).toHaveText('0:00');
  await expect(page.locator('#cig')).not.toHaveClass(/lit/);
  expect(await paperWidth(page)).toBeGreaterThan(0);

  await page.locator('#againBtn').click();
  await expect(page.locator('#idleView')).toBeVisible();
  await expect(page.locator('#clock')).toHaveText('-:--');

  await page.locator('#lightBtn').click();
  expect(await page.evaluate(() => S.topic)).not.toBe(first);
});

test('topics do not repeat until all were used', async ({ page }) => {
  const picks = await page.evaluate(() => TOPICS.map(() => pickTopic()));
  expect(new Set(picks).size).toBe(picks.length);
});

test('the WhatsApp link carries the topic and follow-ups', async ({ page }) => {
  await page.locator('#lightBtn').click();
  const { t, q } = await page.evaluate(() => TOPICS[S.topic]);
  const href = await page.locator('#waBtn').getAttribute('href');
  expect(href.startsWith('https://wa.me/?text=')).toBe(true);
  const text = decodeURIComponent(href.slice('https://wa.me/?text='.length));
  expect(text).toContain(t);
  for (const x of q) expect(text).toContain(x);
});

test('copying puts the topic on the clipboard', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'clipboard permissions are Chromium-only');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.locator('#lightBtn').click();
  await page.locator('#copyBtn').click();
  await expect(page.locator('#copyMsg')).toContainText('הועתק');
  const t = await page.evaluate(() => TOPICS[S.topic].t);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(t);
});

test('the page never scrolls sideways', async ({ page }) => {
  await page.locator('#lightBtn').click();
  await advance(page, 0.8);
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(scroll).toBeLessThanOrEqual(client);
});
