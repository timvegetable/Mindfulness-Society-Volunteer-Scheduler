import { expect, test, type Page } from '@playwright/test';

async function checkLayout(page: Page) {
  await expect(page.locator('.content')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'Check current view', exact: true }).click();
  const report = JSON.parse(await page.locator('#layout-result').innerText());
  expect(report.failures).toEqual([]);
  expect(report.result).toBe('PASS');
  expect(report.viewport).toEqual(page.viewportSize());
}

test('automated browser checks serve built assets without a source or hot-reload endpoint', async ({ request }) => {
  for (const path of ['/__browser-check', '/__role-check']) {
    const response = await request.get(path);
    expect(response.ok()).toBe(true);
    const html = await response.text();
    expect(html).toContain('/assets/');
    expect(html).not.toContain('/@vite/client');
  }
  expect((await request.get('/src/client/app.ts')).status()).toBe(404);
});

test('workspace tables stay contained and schedule preview returns to published state', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  // Layout uses the system fallback in CI; no third-party network is needed.
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
  const viewport = page.viewportSize()!;
  await page.goto(`/__browser-check?width=${viewport.width}&height=${viewport.height}`);
  await expect(page.getByRole('heading', { name: 'Session schedule', exact: true })).toBeVisible();
  const logo = page.locator('.brand-logo');
  await expect(logo).toBeVisible();
  await expect.poll(() => logo.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
  await checkLayout(page);

  await page.getByRole('button', { name: 'Preview schedule', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Schedule preview', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Publish schedule', exact: true })).toBeEnabled();
  await checkLayout(page);
  await page.getByRole('button', { name: 'Back to published schedule', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Session schedule', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Publish schedule', exact: true })).toBeHidden();
  await checkLayout(page);

  const region = page.getByRole('region');
  await region.focus();
  await expect(region).toBeFocused();
  const header = region.locator('th').first();
  const headerTop = await header.evaluate(element => element.getBoundingClientRect().top);
  await region.press('End');
  await expect.poll(() => region.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  expect(Math.abs(await header.evaluate(element => element.getBoundingClientRect().top) - headerTop)).toBeLessThan(2);
  if (viewport.width < 1000) {
    await region.press('ArrowRight');
    await expect.poll(() => region.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  }

  await page.getByRole('button', { name: 'Availability sync', exact: true }).click();
  await expect(page.getByLabel('WhenIsGood results code')).toHaveCount(0);
  await page.getByRole('button', { name: 'Sync now', exact: true }).click();
  await expect(page.locator('.table-scroll')).toHaveCount(1);
  await checkLayout(page);
  await page.getByRole('button', { name: 'Insights', exact: true }).click();
  await expect(page.locator('.table-scroll')).toHaveCount(2);
  await checkLayout(page);
  await page.getByRole('button', { name: 'Center proposals', exact: true }).click();
  await expect(page.locator('.table-scroll')).toHaveCount(1);
  await checkLayout(page);
  expect(errors).toEqual([]);
});


test('admin reload keeps the current reading position', async ({ page }) => {
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
  await page.goto('/__browser-check?latency=50');
  for (const view of ['Schedule', 'Insights', 'Center proposals']) {
    await page.getByRole('button', { name: view, exact: true }).click();
    await expect(page.locator('.content')).toHaveAttribute('aria-busy', 'false');
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const before = await page.evaluate(() => window.scrollY);
    // Programmatic activation avoids scrolling up to the navigation button first.
    await page.getByRole('button', { name: 'Reload view', exact: true }).evaluate(node => (node as HTMLButtonElement).click());
    await expect(page.locator('.content')).toHaveAttribute('aria-busy', 'false');
    expect(Math.abs(await page.evaluate(() => window.scrollY) - before)).toBeLessThanOrEqual(2);
  }
});


test('administrator sees automatic synchronization status and pending submissions without a preview step', async ({ page }) => {
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
  await page.goto('/__browser-check');
  await page.getByRole('button', { name: 'Availability sync', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Availability sync', exact: true })).toBeVisible();
  await expect(page.getByText(/Last successful sync:/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Participants needing attention', exact: true })).toBeVisible();
  await expect(page.locator('.pending-participants tbody tr')).toHaveCount(40);
  await expect(page.getByRole('button', { name: 'Promote matched availability' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Sync now', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Availability check queued');
  await expect(page.getByText('An availability check is queued. Use Reload view to see its result.', { exact: true })).toBeVisible();
  const reads = await page.locator('#sync-read-count').innerText();
  await page.waitForTimeout(1500);
  await expect(page.locator('#sync-read-count')).toHaveText(reads);
  await page.getByRole('button', { name: 'Reload view', exact: true }).click();
  await expect(page.getByText('An availability check is queued. Use Reload view to see its result.', { exact: true })).toBeVisible();
  await expect(page.locator('#sync-read-count')).toHaveText(String(Number(reads) + 1));
});


test('an administrator links a pending submission and immediately sees the resolved queue', async ({ page }) => {
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
  await page.goto('/__browser-check');
  await page.getByRole('button', { name: 'Availability sync', exact: true }).click();
  const row = page.locator('.pending-participants tbody tr').first();
  await row.getByRole('combobox').selectOption('synthetic-v0');
  await row.getByRole('button', { name: 'Link participant', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Participant linked');
  await expect(page.locator('.pending-participants tbody tr')).toHaveCount(39);
});


test('Sync now and linking preserve other unsaved roster links', async ({ page }) => {
  await page.goto('/__browser-check');
  await page.getByRole('button', { name: 'Availability sync', exact: true }).click();
  const first = page.getByRole('combobox', { name: 'Roster link for Synthetic Volunteer 01 (WhenIsGood ID: p-synthetic-v0)', exact: true });
  const second = page.getByRole('combobox', { name: 'Roster link for Synthetic Volunteer 02 (WhenIsGood ID: p-synthetic-v1)', exact: true });
  await first.selectOption('synthetic-v0'); await second.selectOption('synthetic-v1');
  await page.getByRole('button', { name: 'Sync now', exact: true }).click();
  await expect(first).toHaveValue('synthetic-v0'); await expect(second).toHaveValue('synthetic-v1');
  await page.locator('.pending-participants tbody tr').first().getByRole('button', { name: 'Link participant', exact: true }).click();
  await expect(page.locator('.pending-participants tbody tr')).toHaveCount(39);
  await expect(second).toHaveValue('synthetic-v1');
  await expect(page.getByRole('alert')).toContainText('unsaved roster link');
});


test('conflicting source identities expose every submission and block ambiguous links', async ({ page }) => {
  await page.goto('/__browser-check?collision=1');
  await page.getByRole('button', { name: 'Availability sync', exact: true }).click();
  const collision = page.locator('.pending-participants tbody tr').first();
  await expect(collision).toContainText('Conflicting source entries');
  await collision.getByText('Show all 2 submissions', { exact: true }).click();
  await expect(collision).toContainText('Synthetic Volunteer 01');
  await expect(collision).toContainText('Monday 9:00 AM–10:00 AM');
  await expect(collision).toContainText('Synthetic Volunteer 02');
  await expect(collision).toContainText('Wednesday 1:00 PM–2:00 PM');
  await expect(collision.getByRole('combobox')).toHaveCount(0);
  await expect(collision).toContainText('Correct the source identity');
});

test('a roster link changed during a refresh stays available for review', async ({ page }) => {
  await page.goto('/__browser-check?latency=300');
  await page.getByRole('button', { name: 'Availability sync', exact: true }).click();
  await expect(page.locator('.content')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'Sync now', exact: true }).click();
  await expect(page.locator('.content')).toHaveAttribute('aria-busy', 'true');
  const picker = page.getByRole('combobox', { name: 'Roster link for Synthetic Volunteer 01 (WhenIsGood ID: p-synthetic-v0)', exact: true });
  await picker.selectOption('synthetic-v0');
  await expect(page.locator('.content')).toHaveAttribute('aria-busy', 'false');
  await expect(picker).toHaveValue('synthetic-v0');
  await expect(page.getByRole('alert')).toContainText('newer edits were kept');
});
