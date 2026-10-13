import { expect, test, type Page } from '@playwright/test';

async function checkLayout(page: Page) {
  await expect(page.locator('.content')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'Check current view', exact: true }).click();
  const report = JSON.parse(await page.locator('#layout-result').innerText());
  expect(report.failures).toEqual([]);
  expect(report.result).toBe('PASS');
  expect(report.viewport).toEqual(page.viewportSize());
}

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

  await page.getByRole('button', { name: 'Import availability', exact: true }).click();
  await expect(page.getByLabel('WhenIsGood results code')).toHaveCount(0);
  await page.getByRole('button', { name: 'Preview latest availability', exact: true }).click();
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
