import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';

const unique = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/** Signs up using only the keyboard: Tab between fields, Enter to submit. */
async function signUpByKeyboard(page: Page, name: string) {
  await page.goto('/signup');
  await page.getByLabel('Name').focus();
  await page.keyboard.type(name);
  await page.keyboard.press('Tab');
  await page.keyboard.type(`${unique()}@example.com`);
  await page.keyboard.press('Tab');
  await page.keyboard.type('correct horse battery');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'E2E Hack' })).toBeVisible();
}

async function newUser(browser: Browser, name: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signUpByKeyboard(page, name);
  return { context, page };
}

async function expectNoSeriousA11yViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.nodes[0]?.target}`)).toEqual([]);
}

/** Tabs until the focused element matches, proving it can be reached by keyboard alone. */
async function tabTo(page: Page, name: RegExp, max = 40) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return `${el?.getAttribute('aria-label') ?? ''} ${el?.innerText ?? ''}`;
    });
    if (name.test(focused)) return;
  }
  throw new Error(`could not reach ${name} with Tab`);
}

test('e2e.keyboard-only: create, invite, request, accept, with no mouse at all', async ({ browser }) => {
  const leader = await newUser(browser, 'Leader Lee');
  const page = leader.page;

  await tabTo(page, /Create a team/);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.type(`Keyboard Crew ${unique()}`); // the dialog moved focus to its first field
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('seat-count')).toHaveText('1/2 seats');

  await tabTo(page, /New code/);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('invite-code')).toBeVisible();
  const teamUrl = page.url();
  await expectNoSeriousA11yViolations(page);

  const asker = await newUser(browser, 'Asker Ash');
  await asker.page.goto(teamUrl);
  await tabTo(asker.page, /Ask to join/);
  await asker.page.keyboard.press('Enter');
  await expect(asker.page.getByRole('dialog')).toBeVisible();
  await asker.page.keyboard.type('I know Postgres');
  await asker.page.keyboard.press('Enter');
  await expect(asker.page.getByRole('button', { name: 'Request pending' })).toBeVisible();

  // The leader's page learns about the request over SSE, with no reload.
  await expect(page.getByRole('button', { name: 'Accept Asker Ash' })).toBeVisible({ timeout: 5000 });
  await tabTo(page, /Accept Asker Ash/);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('seat-count')).toHaveText('2/2 seats');
  await expect(page.getByText('Ready')).toBeVisible();

  await leader.context.close();
  await asker.context.close();
});

test('e2e.live-update: a seat taken in one browser appears in another without a reload', async ({ browser }) => {
  const leader = await newUser(browser, 'Live Leader');
  await leader.page.getByRole('button', { name: 'Create a team' }).click();
  await leader.page.getByLabel('Team name').fill(`Live ${unique()}`);
  await leader.page.getByRole('button', { name: 'Create team' }).click();
  await expect(leader.page.getByTestId('seat-count')).toHaveText('1/2 seats');
  await leader.page.getByRole('button', { name: 'New code' }).click();
  const code = await leader.page.getByTestId('invite-code').innerText();

  const joiner = await newUser(browser, 'Live Joiner');
  await joiner.page.goto(leader.page.url());
  await joiner.page.getByLabel('Invite code').fill(code);
  await joiner.page.getByRole('button', { name: 'Join with code' }).click();

  await expect(leader.page.getByTestId('seat-count')).toHaveText('2/2 seats', { timeout: 3000 });
  await expect(leader.page.getByRole('listitem').filter({ hasText: 'Live Joiner' }).first()).toBeVisible();
  await leader.context.close();
  await joiner.context.close();
});

test('e2e.optimistic-rollback: losing the last seat shows the placeholder, then the reason', async ({ browser }) => {
  const leader = await newUser(browser, 'Roll Leader');
  await leader.page.getByRole('button', { name: 'Create a team' }).click();
  await leader.page.getByLabel('Team name').fill(`Rollback ${unique()}`);
  await leader.page.getByRole('button', { name: 'Create team' }).click();
  await expect(leader.page.getByTestId('seat-count')).toHaveText('1/2 seats');
  await leader.page.getByRole('button', { name: 'New code' }).click();
  const code = await leader.page.getByTestId('invite-code').innerText();
  const url = leader.page.url();

  const loser = await newUser(browser, 'Late Loser');
  await loser.page.goto(url);
  await expect(loser.page.getByTestId('seat-count')).toHaveText('1/2 seats');

  // The winner takes the seat through the API while the loser's page still shows it free.
  const winner = await newUser(browser, 'Fast Winner');
  await loser.page.context().route('**/api/events*', (route) => route.abort()); // freeze the loser's live view
  await loser.page.reload();
  await expect(loser.page.getByTestId('seat-count')).toHaveText('1/2 seats');
  const won = await winner.page.request.post('/api/invites/redeem', { data: { code }, headers: { 'x-requested-with': 'test' } });
  expect(won.status()).toBe(201);

  await loser.page.getByLabel('Invite code').fill(code);
  await loser.page.getByRole('button', { name: 'Join with code' }).click();
  await expect(loser.page.getByText('Someone was faster')).toBeVisible();
  await expect(loser.page.getByText('Confirming')).toHaveCount(0, { timeout: 3000 });
  await expect(loser.page.getByTestId('seat-count')).toHaveText('2/2 seats', { timeout: 3000 });

  for (const user of [leader, loser, winner]) await user.context.close();
});

test('e2e.command-palette: Ctrl+K reaches everything from the keyboard', async ({ browser }) => {
  const user = await newUser(browser, 'Palette Pat');
  await user.page.keyboard.press('Control+k');
  await expect(user.page.getByRole('dialog')).toBeVisible();
  await user.page.keyboard.type('race arena');
  await user.page.keyboard.press('Enter');
  await expect(user.page.getByRole('heading', { name: 'Race Arena' })).toBeVisible();
  await user.context.close();
});

test('e2e.arena: the button runs a real race, and naive mode visibly breaks', async ({ browser }) => {
  const user = await newUser(browser, 'Arena Ari');
  await user.page.goto('/arena');
  await user.page.getByRole('button', { name: 'Unleash 50 bots' }).click();
  await expect(user.page.getByRole('status').filter({ hasText: 'One winner.' })).toBeVisible({ timeout: 15000 });
  await expectNoSeriousA11yViolations(user.page);

  await user.page.getByRole('radio', { name: /Naive read/ }).check({ force: true });
  await user.page.getByRole('button', { name: 'Run it again' }).click();
  await expect(user.page.getByRole('status').filter({ hasText: 'Broken:' })).toBeVisible({ timeout: 15000 });
  await user.context.close();
});

test('e2e.phone: every page works at 360 px with no sideways scrolling', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await signUpByKeyboard(page, 'Phone Pia');
  await page.getByRole('button', { name: 'Create a team' }).tap();
  await page.getByLabel('Team name').fill(`Phone ${unique()}`);
  await page.getByRole('button', { name: 'Create team' }).tap();
  await expect(page.getByTestId('seat-count')).toBeVisible();
  const teamUrl = page.url();

  for (const path of [teamUrl, '/', '/suggestions', '/arena', '/ops', '/profile']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle').catch(() => {});
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${path} overflows sideways`).toBeLessThanOrEqual(0);
    await expectNoSeriousA11yViolations(page);
  }

  const small = await page.locator('nav[aria-label="Main, mobile"] a').evaluateAll((links) =>
    links.filter((l) => l.getBoundingClientRect().height < 44).length,
  );
  expect(small).toBe(0);
  await context.close();
});

test('e2e.deep-link: refreshing a team page loads the SPA, not raw JSON', async ({ browser }) => {
  const user = await newUser(browser, 'Deep Dee');
  await user.page.getByRole('button', { name: 'Create a team' }).click();
  await user.page.getByLabel('Team name').fill(`Deep ${unique()}`);
  await user.page.getByRole('button', { name: 'Create team' }).click();
  await expect(user.page.getByTestId('seat-count')).toBeVisible();
  await user.page.reload();
  await expect(user.page.getByTestId('seat-count')).toBeVisible();
  await user.context.close();
});

// Both start at `/`: the route guard caches "signed out" before it redirects to the form.
test('e2e.sign-in-from-root: signing in after the redirect from / reaches the board', async ({ browser }) => {
  const email = `${unique()}@example.com`;
  const password = 'correct horse battery';
  const existing = await browser.newContext();
  const signup = await existing.newPage();
  await signup.goto('/signup');
  await signup.getByLabel('Name').fill('Returning Rae');
  await signup.getByLabel('Email').fill(email);
  await signup.getByLabel('Password').fill(password);
  await signup.getByLabel('Password').press('Enter');
  await expect(signup.getByRole('heading', { name: 'E2E Hack' })).toBeVisible();
  await existing.close();

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByLabel('Password').press('Enter');
  await expect(page.getByRole('heading', { name: 'E2E Hack' })).toBeVisible();
  await context.close();
});

test('e2e.sign-up-from-root: signing up after the redirect from / reaches the board', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/');
  await page.getByRole('link', { name: 'Create an account' }).click();
  await page.getByLabel('Name').fill('Newcomer Noor');
  await page.getByLabel('Email').fill(`${unique()}@example.com`);
  await page.getByLabel('Password').fill('correct horse battery');
  await page.getByLabel('Password').press('Enter');
  await expect(page.getByRole('heading', { name: 'E2E Hack' })).toBeVisible();
  await context.close();
});
