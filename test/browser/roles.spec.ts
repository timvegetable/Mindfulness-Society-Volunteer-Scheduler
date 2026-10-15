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



test('volunteer data refreshes on Reload view with no periodic browser requests', async ({ page }) => {
  await page.clock.install();
  await page.goto('/__role-check');
  const weekly = page.locator('.weekly-availability-table');
  await expect(weekly).toContainText('5:00 PM');
  const reads = await page.locator('#read-count').innerText();
  const date = page.getByLabel('Date', { exact: true }); await date.focus();
  await page.evaluate(() => window.scrollTo(0, 200)); const before = await page.evaluate(() => window.scrollY);
  await page.getByRole('button', { name: 'Simulate source update' }).evaluate(node => (node as HTMLButtonElement).click());
  await page.clock.fastForward(3_600_000);
  await expect(weekly).toContainText('5:00 PM'); await expect(page.locator('#read-count')).toHaveText(reads);
  await page.getByRole('button', { name: 'Reload view', exact: true }).evaluate(node => (node as HTMLButtonElement).click());
  await expect(weekly).toContainText('6:00 PM'); await expect(date).toBeFocused();
  expect(Math.abs(await page.evaluate(() => window.scrollY) - before)).toBeLessThanOrEqual(2);
  await page.getByRole('button', { name: 'Simulate sync failure' }).evaluate(node => (node as HTMLButtonElement).click());
  await page.getByRole('button', { name: 'Reload view', exact: true }).evaluate(node => (node as HTMLButtonElement).click());
  await expect(page.locator('.sync-freshness')).toContainText('latest check failed'); await expect(weekly).toContainText('6:00 PM');
});

test('an open draft survives source updates and explains a save racing synchronization', async ({ page }) => {
  await page.clock.install(); await page.goto('/__role-check');
  const date = page.getByLabel('Date', { exact: true });
  await date.fill('2099-10-20'); await page.getByLabel('Reason (optional)').fill('Keep this draft');
  await page.getByRole('button', { name: 'Simulate source update' }).evaluate(node => (node as HTMLButtonElement).click());
  await date.focus(); await page.clock.fastForward(60_000);
  await page.getByRole('button', { name: 'My availability', exact: true }).evaluate(node => (node as HTMLButtonElement).click());
  await expect(date).toHaveValue('2099-10-20'); await expect(date).toBeFocused();
  await expect(page.getByLabel('Reason (optional)')).toHaveValue('Keep this draft');
  await page.getByRole('button', { name: 'Save exception', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('changed while you were working');
  await expect(date).toHaveValue('2099-10-20'); await expect(page.getByLabel('Reason (optional)')).toHaveValue('Keep this draft');
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: 'Reload view', exact: true }).click();
  await expect(date).toHaveValue('2099-10-20');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Reload view', exact: true }).click();
  await expect(date).toHaveValue(''); await expect(page.locator('.weekly-availability-table')).toContainText('6:00 PM');
});

test('center advisory coverage reads the current saved availability on Reload view', async ({ page }) => {
  await page.goto('/__role-check?role=contact');
  await expect(page.getByRole('cell', { name: '1 available · 0 unfilled' })).toBeVisible();
  await page.getByRole('button', { name: 'Simulate source update' }).evaluate(node => (node as HTMLButtonElement).click());
  await page.getByRole('button', { name: 'Reload view', exact: true }).click();
  await expect(page.getByRole('cell', { name: '2 available · 0 unfilled' })).toBeVisible();
});

test('proposal editing started during Reload view survives the pending read', async ({ page }) => {
  await page.goto('/__role-check?role=contact&latency=300');
  await expect(page.getByRole('heading', { name: 'New proposal', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reload view', exact: true }).click();
  await expect(page.locator('.content')).toHaveAttribute('aria-busy', 'true');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Edit proposal', exact: true })).toBeVisible();
  await expect(page.locator('.content')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('heading', { name: 'Edit proposal', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('newer edits were kept');
});
