import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
});

test.afterEach(async ({ page }) => {
  const layout = await page.evaluate(() => ({ width: window.innerWidth, pageWidth: document.documentElement.scrollWidth }));
  expect(layout.pageWidth).toBeLessThanOrEqual(layout.width);
  for (const region of await page.getByRole('region').all()) {
    await expect(region).toHaveAttribute('tabindex', '0');
  }
});

test('volunteer UI shows saved weekly availability and saves date exceptions', async ({ page }) => {
  const apiRequests: string[] = [];
  page.on('request', request => { if (/\/(api|client-config)$/.test(request.url())) apiRequests.push(request.url()); });
  await page.goto('/__role-check');
  await expect(page.getByRole('heading', { name: 'Your assignments', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Schedule', exact: true })).toHaveCount(0);
  const weekly = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Weekly availability', exact: true }) });
  await expect(weekly.getByRole('table')).toContainText('Monday');
  await expect(weekly.getByRole('table')).toContainText('9:00 AM–5:00 PM');
  await expect(weekly.getByText('Update in WhenIsGood.', { exact: false })).toBeVisible();
  await expect(weekly.locator('input, select, button')).toHaveCount(0);
  const exceptions = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Date exceptions', exact: true }) });
  await exceptions.getByLabel('Date', { exact: true }).fill('2099-10-20');
  await exceptions.getByLabel('Reason (optional)', { exact: true }).fill('UI test');
  const save = exceptions.getByRole('button', { name: 'Save exception', exact: true });
  await save.scrollIntoViewIfNeeded();
  const wasScrolled = await page.evaluate(() => window.scrollY > 0);
  const saveTopBefore = await save.evaluate(node => node.getBoundingClientRect().top);
  await save.click();
  await expect(page.getByRole('alert')).toHaveText('Exception saved.');
  const saveTopAfter = await save.evaluate(node => node.getBoundingClientRect().top);
  if (wasScrolled) expect(Math.abs(saveTopAfter - saveTopBefore)).toBeLessThanOrEqual(2);
  await expect(save).toBeInViewport();
  await expect(save).toBeFocused();
  await expect(exceptions.getByRole('table')).toContainText('2099-10-20');
  await expect(exceptions.getByRole('table')).toContainText('UI test');
  await page.getByRole('button', { name: 'Reload view', exact: true }).click();
  await expect(exceptions.getByRole('table')).toContainText('UI test');
  await expect(weekly.getByRole('table')).toContainText('9:00 AM–5:00 PM');
  await page.getByRole('button', { name: 'Reset test data', exact: true }).click();
  await expect(exceptions.getByText('No exceptions.', { exact: true })).toBeVisible();
  expect(apiRequests).toEqual([]);
});

test('volunteer UI confirms cancellation and removes the assignment in memory', async ({ page }) => {
  await page.goto('/__role-check');
  await expect(page.getByRole('button', { name: 'Cancel assignment', exact: true })).toBeVisible();
  page.on('dialog', dialog => dialog.type() === 'prompt' ? dialog.accept('UI test cancellation') : dialog.accept());
  await page.getByRole('button', { name: 'Cancel assignment', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cancel assignment', exact: true })).toHaveCount(0);
  await expect(page.getByText('No assignments.', { exact: false })).toBeVisible();
  await expect(page.locator('section').filter({ has: page.getByRole('heading', { name: 'Date exceptions', exact: true }) }).getByRole('table')).toContainText('UI test cancellation');
});

test('contact proposal creation, editing and withdrawal retains reading position', async ({ page }) => {
  await page.goto('/__role-check?role=contact&latency=50');
  await expect(page.getByRole('heading', { name: 'New proposal', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'My availability', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Center', exact: true }).locator('option')).toHaveCount(1);
  await page.getByRole('combobox', { name: 'Weekday', exact: true }).selectOption('2');
  const proposalSave = page.getByRole('button', { name: 'Save proposal', exact: true });
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await proposalSave.scrollIntoViewIfNeeded();
  const contactScrolled = await page.evaluate(() => window.scrollY > 0);
  const proposalTop = await proposalSave.evaluate(node => node.getBoundingClientRect().top);
  await proposalSave.click();
  await expect(page.getByRole('alert')).toHaveText('Proposal saved.');
  if (contactScrolled) expect(Math.abs(await proposalSave.evaluate(node => node.getBoundingClientRect().top) - proposalTop)).toBeLessThanOrEqual(2);
  await expect(page.getByRole('table')).toContainText('Tuesday');
  const row = page.getByRole('row').filter({ hasText: 'Tuesday' });
  await row.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('From', { exact: true }).fill('08:30');
  await page.getByRole('button', { name: 'Cancel editing', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'New proposal', exact: true })).toBeVisible();
  await expect(page.getByLabel('From', { exact: true })).toHaveValue('09:00');
  await row.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('From', { exact: true }).fill('08:30');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(row).toContainText('8:30 AM');
  page.once('dialog', dialog => dialog.accept());
  await row.getByRole('button', { name: 'Withdraw', exact: true }).click();
  await expect(row).toContainText('cancelled');
  await expect(row.getByRole('button')).toHaveCount(0);
});
