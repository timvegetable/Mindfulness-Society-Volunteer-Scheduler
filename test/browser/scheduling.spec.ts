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
  await expect(page.locator('.schedule-panel tbody tr').first()).toContainText('Synthetic Center');
  await expect(page.locator('.schedule-panel tbody')).not.toContainText('Synthetic session 1');
  const logo = page.locator('.brand-logo');
  await expect(logo).toBeVisible();
  await expect.poll(() => logo.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
  await checkLayout(page);

  await page.getByRole('button', { name: 'Preview schedule', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Schedule preview', exact: true })).toBeVisible();
  await expect(page.locator('.schedule-panel tbody tr').first()).toContainText('Synthetic Center');
  await expect(page.getByRole('button', { name: 'Publish schedule', exact: true })).toBeEnabled();
  await checkLayout(page);
  await page.getByRole('button', { name: 'Back to published schedule', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Session schedule', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Publish schedule', exact: true })).toBeHidden();
  await checkLayout(page);

  const region = page.getByRole('region');
  await region.focus();
  await expect(region).toBeFocused();
  await expect.poll(() => region.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
  await expect(page.locator('.session-status')).toHaveCount(40);
  await expect(page.locator('.brand-badge .brand-logo')).toBeVisible();
  if (viewport.width < 1000) {
    await region.press('ArrowRight');
    await expect.poll(() => region.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  }

  await page.getByRole('button', { name: 'Availability sync', exact: true }).click();
  await expect(page.getByLabel('WhenIsGood results code')).toHaveCount(0);
  await page.getByRole('button', { name: 'Sync now', exact: true }).click();
  await expect(page.locator('.table-scroll')).toHaveCount(1);
  await checkLayout(page);
  const syncRegion = page.getByRole('region');
  await syncRegion.focus();
  const header = syncRegion.locator('th').first();
  const headerTop = await header.evaluate(element => element.getBoundingClientRect().top);
  await syncRegion.press('End');
  await expect.poll(() => syncRegion.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  expect(Math.abs(await header.evaluate(element => element.getBoundingClientRect().top) - headerTop)).toBeLessThan(2);
  await page.getByRole('button', { name: 'Insights', exact: true }).click();
  await expect(page.locator('.table-scroll')).toHaveCount(2);
  await checkLayout(page);
  await page.getByRole('button', { name: 'Center proposals', exact: true }).click();
  await expect(page.locator('.table-scroll')).toHaveCount(1);
  await checkLayout(page);
  expect(errors).toEqual([]);
});

test('admin published and preview schedules render the current future sessions', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-04T12:00:00.000Z') });
  await page.goto('/__browser-check?future-cutoff=1');
  const panel = page.locator('.schedule-panel');
  const rows = panel.locator('tbody tr');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('8:01 AM');
  await expect(rows.nth(1)).toContainText('9:00 AM');
  await expect(rows.nth(2)).toContainText('11:00 AM');
  await expect(panel.locator('tbody')).not.toContainText('7:59 AM');
  await expect(panel.locator('tbody')).not.toContainText('8:00 AM');

  await page.getByRole('button', { name: 'Preview schedule', exact: true }).click();
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('8:01 AM');
  await expect(rows.nth(1)).toContainText('9:00 AM');
  await expect(panel.locator('tbody')).not.toContainText('11:00 AM');
  await expect(panel.locator('tbody')).not.toContainText('7:59 AM');
  await expect(panel.locator('tbody')).not.toContainText('8:00 AM');
});

test('admin empty schedule states describe the lack of upcoming sessions', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-04T12:00:00.000Z') });
  await page.goto('/__browser-check?future-empty=1');
  const panel = page.locator('.schedule-panel');
  await expect(panel.getByText('No upcoming sessions.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Preview schedule', exact: true }).click();
  await expect(panel.getByText('No upcoming sessions to preview.', { exact: true })).toBeVisible();
});

test('weekly preview groups contain only dates after the start cutoff', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-09T13:00:00.000Z') });
  await page.goto('/__browser-check?future-weekly=1');
  const panel = page.locator('.schedule-panel');
  const inspectDates = async () => {
    await expect(panel.locator('tbody tr')).toHaveCount(38);
    const firstGroup = panel.locator('tbody tr').first().locator('.schedule-session');
    await expect(firstGroup.locator('.session-name')).toHaveText('Synthetic Center');
    await expect(firstGroup.locator('.session-time')).toHaveText('Friday · 9:00 AM–10:00 AM');
    const details = firstGroup.locator('details.schedule-dates');
    await expect(details.locator('summary')).toHaveText('View 3 dates · Oct 16, 2026 to Oct 30, 2026');
    await expect(details.locator('li')).toHaveText([
      'Friday, October 16, 2026', 'Friday, October 23, 2026', 'Friday, October 30, 2026',
    ]);
  };
  await inspectDates();
  await page.getByRole('button', { name: 'Preview schedule', exact: true }).click();
  await inspectDates();
});

test('weekly schedule groups disclose their finite dates in published and preview views', async ({ page }) => {
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
  const viewport = page.viewportSize()!;
  await page.goto(`/__browser-check?weekly-schedule=1&width=${viewport.width}&height=${viewport.height}`);
  const panel = page.locator('.schedule-panel');
  const firstGroup = () => panel.locator('tbody tr').first().locator('.schedule-session');
  const tableRegion = () => panel.locator('.table-scroll');
  const inspectDates = async () => {
    await expect(panel.locator('tbody tr')).toHaveCount(38);
    await expect(firstGroup().locator('.session-name')).toHaveText('Synthetic Center');
    await expect(firstGroup().locator('.session-time')).toHaveText('Friday · 9:00 AM–10:00 AM');
    const details = firstGroup().locator('details.schedule-dates');
    const summary = details.locator('summary');
    await expect(summary).toHaveText('View 3 dates · Oct 2, 2026 to Oct 16, 2026');
    await expect(details.locator('li')).toHaveCount(3);
    await expect(details.locator('li').first()).toBeHidden();
    await tableRegion().focus();
    await page.keyboard.press('Tab');
    await expect(summary).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(details).toHaveAttribute('open', '');
    await expect(details.getByText('Friday, October 2, 2026', { exact: true })).toBeVisible();
    await expect(details.getByText('Friday, October 9, 2026', { exact: true })).toBeVisible();
    await expect(details.getByText('Friday, October 16, 2026', { exact: true })).toBeVisible();
  };

  await inspectDates();
  await checkLayout(page);
  await page.getByRole('button', { name: 'Preview schedule', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Schedule preview', exact: true })).toBeVisible();
  await inspectDates();
  await checkLayout(page);
  await page.getByRole('button', { name: 'Back to published schedule', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Session schedule', exact: true })).toBeVisible();
  await inspectDates();
  await checkLayout(page);
});

test('weekly schedule keeps dates with different staffing visible in published and preview views', async ({ page }) => {
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
  const viewport = page.viewportSize()!;
  await page.goto(`/__browser-check?weekly-schedule=1&rotating-weekly=1&width=${viewport.width}&height=${viewport.height}`);
  const panel = page.locator('.schedule-panel');
  const inspectStaffing = async (published: boolean) => {
    const rows = panel.locator('tbody tr');
    await expect(rows).toHaveCount(40);
    const expected = [
      ['2026-10-02', 'Synthetic Volunteer 01, Synthetic Volunteer 02'],
      ['2026-10-09', 'Synthetic Volunteer 01, Synthetic Volunteer 03'],
      ['2026-10-16', 'Synthetic Volunteer 02, Synthetic Volunteer 03'],
    ];
    for (const [index, [date, assigned]] of expected.entries()) {
      const row = rows.nth(index);
      await expect(row.locator('.session-time')).toHaveText(`${date} · 9:00 AM–10:00 AM`);
      await expect(row.locator('details.schedule-dates')).toHaveCount(0);
      await expect(row.locator('td').nth(published ? 2 : 1)).toHaveText(assigned!);
    }
  };

  await inspectStaffing(true);
  await checkLayout(page);
  await page.getByRole('button', { name: 'Preview schedule', exact: true }).click();
  await inspectStaffing(false);
  await checkLayout(page);
  await page.getByRole('button', { name: 'Back to published schedule', exact: true }).click();
  await inspectStaffing(true);
  await checkLayout(page);
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

test('roster link pickers sort names and preserve selected IDs through a sync refresh', async ({ page }) => {
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
  await page.goto('/__browser-check?shuffled-roster=1');
  await page.getByRole('button', { name: 'Availability sync', exact: true }).click();

  const first = page.getByRole('combobox', { name: 'Roster link for Synthetic Volunteer 01 (WhenIsGood ID: p-synthetic-v0)', exact: true });
  const second = page.getByRole('combobox', { name: 'Roster link for Synthetic Volunteer 02 (WhenIsGood ID: p-synthetic-v1)', exact: true });
  const values = await first.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value));
  expect(values).toEqual(['', 'synthetic-v0', 'synthetic-v1', 'synthetic-v3', 'synthetic-v4', 'synthetic-v2']);
  const labels = await first.locator('option').evaluateAll(options => options.map(option => option.textContent));
  expect(labels).toEqual([
    'Choose a volunteer', 'Alex Example (a@example.test)', 'alex Example (m@example.test)',
    'ALex Example (z@example.test)', 'Beth Example (beth@example.test)', 'Zoe Example (zoe@example.test)',
  ]);

  await first.selectOption('synthetic-v2'); await second.selectOption('synthetic-v1');
  await page.getByRole('button', { name: 'Sync now', exact: true }).click();
  await expect(first).toHaveValue('synthetic-v2'); await expect(second).toHaveValue('synthetic-v1');
  await expect(page.getByRole('button', { name: 'Sync now', exact: true })).toBeFocused();

  await first.selectOption('synthetic-v3');
  await expect(first).toHaveValue('synthetic-v3');
  await first.locator('xpath=ancestor::tr').getByRole('button', { name: 'Link participant', exact: true }).click();
  await expect(page.locator('.pending-participants tbody tr')).toHaveCount(39);
  await expect(page.getByRole('combobox', { name: 'Roster link for Synthetic Volunteer 02 (WhenIsGood ID: p-synthetic-v1)', exact: true })).toHaveValue('synthetic-v1');
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

test('read sessions renew only on explicit reads and navigation while the schedule stays visible', async ({ page }) => {
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
  await page.clock.install();
  await page.goto('/__browser-check?read-session');
  await expect(page.getByRole('heading', { name: 'Session schedule', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-session-exchanges', '1');
  await expect(page.locator('html')).toHaveAttribute('data-schedule-reads', '1');
  await page.getByRole('button', { name: 'Reload view', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-schedule-reads', '2');
  await page.clock.fastForward(16 * 60 * 1000);
  await expect(page.locator('html')).toHaveAttribute('data-session-exchanges', '1');
  await expect(page.locator('html')).toHaveAttribute('data-schedule-reads', '2');
  await page.getByRole('button', { name: 'Reload view', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-session-exchanges', '2');
  await expect(page.locator('html')).toHaveAttribute('data-schedule-reads', '3');
  await expect(page.getByRole('heading', { name: 'Session schedule', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Availability sync', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Availability sync', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-session-exchanges', '2');
  await page.clock.fastForward(16 * 60 * 1000);
  await expect(page.locator('html')).toHaveAttribute('data-session-exchanges', '2');
  await page.getByRole('button', { name: 'Reload view', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-session-exchanges', '3');
  await page.getByRole('button', { name: 'Schedule', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-schedule-reads', '4');
  await expect(page.locator('html')).toHaveAttribute('data-session-exchanges', '3');
});


test('compact synchronization data preserves displayed history counts and roster choices', async ({ page }) => {
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
  await page.goto('/__browser-check?history=1&read-session');
  await page.getByRole('button', { name: 'Availability sync', exact: true }).click();
  const history = page.locator('details').filter({ hasText: 'Import history (1)' });
  await history.locator('summary').click();
  await expect(history.getByRole('row')).toHaveCount(2);
  const cells = history.locator('tbody td');
  await expect(cells.nth(1)).toHaveText('completed');
  await expect(cells.nth(2)).toHaveText('40');
  await expect(cells.nth(3)).toHaveText('0');
  await expect(page.getByRole('combobox').first().getByRole('option')).toHaveCount(41);
});


test('published status and cancelled sessions survive a preview round trip without clipped rows', async ({ page }) => {
  const viewport = page.viewportSize()!;
  await page.goto(`/__browser-check?reference&width=${viewport.width}&height=${viewport.height}`);
  await expect(page.locator('.publication-pill')).toHaveText('Published');
  await expect(page.locator('.publication-state')).toContainText('Version 1');
  await expect(page.locator('.session-status-cancelled')).toHaveText('cancelled');
  await expect(page.locator('tbody tr').nth(2).locator('.shortfall')).toHaveText('0');
  await checkLayout(page);
  await page.getByRole('button', { name: 'Preview schedule', exact: true }).click();
  await expect(page.locator('.publication-pill')).toHaveCount(0);
  await expect(page.locator('.publication-state')).toHaveText('Preview · Unpublished changes');
  await checkLayout(page);
  await page.getByRole('button', { name: 'Back to published schedule', exact: true }).click();
  await expect(page.locator('.publication-pill')).toHaveText('Published');
  await expect(page.locator('.session-status-cancelled')).toHaveText('cancelled');
  await checkLayout(page);
});
