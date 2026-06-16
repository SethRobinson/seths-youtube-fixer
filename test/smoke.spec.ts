import { test, expect } from './fixtures';

test('extension loads and registers a service worker', async ({ extensionId }) => {
  // Chrome extension IDs are 32 chars in the range a-p.
  expect(extensionId).toMatch(/^[a-p]{32}$/);
});

test('options page saves and reloads the API key', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  // The dev profile is shared with real use — snapshot the user's key and restore it
  // afterward so the suite never clobbers a real API key with the test value.
  const original = await page.locator('#apiKey').inputValue();
  try {
    await page.fill('#apiKey', 'AIzaTEST_dummy_key_123');
    await page.click('#save');
    await expect(page.locator('#savedMsg')).toHaveText('Saved');

    // Reload and confirm persistence.
    await page.reload();
    await expect(page.locator('#apiKey')).toHaveValue('AIzaTEST_dummy_key_123');
  } finally {
    await page.fill('#apiKey', original);
    await page.click('#save');
    await page.close();
  }
});

test('injects the SYF button bar on a watch page', async ({ context }) => {
  const page = await context.newPage();
  const logs: string[] = [];
  page.on('console', (m) => logs.push(m.text()));

  await page.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ', {
    waitUntil: 'domcontentloaded',
  });

  const bar = page.locator('#syf-bar');
  await expect(bar).toBeVisible({ timeout: 45_000 });
  await expect(bar.locator('.syf-btn')).toHaveCount(6);

  await page.screenshot({ path: 'test-results/watch-bar.png' });
  console.log('SYF logs seen:', logs.filter((l) => l.includes('[SYF]')));
});
