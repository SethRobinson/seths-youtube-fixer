// Account-read-only validation for "Remember Home topic chip".
// Temporarily changes only this extension's local settings, clicks a normal
// YouTube Home chip, verifies it is remembered and replayed after reload, then
// verifies clicking the selected chip again clears the memory and returns to All.
// Restores the original settings.
import { connect, findExtensionId, reloadExtension } from './chrome-lib.mjs';

const SETTINGS_KEY = 'syf.settings';
const HOME_CHIP_SELECTOR =
  'ytd-feed-filter-chip-bar-renderer yt-chip-cloud-chip-renderer[chip-style="STYLE_HOME_FILTER"]';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForHomeChips(page) {
  await page.waitForFunction(
    (selector) => document.querySelectorAll(selector).length > 1,
    HOME_CHIP_SELECTOR,
    { timeout: 20_000 }
  );
}

async function chipSnapshot(page) {
  return await page.evaluate((selector) => {
    const labelOf = (el) => (el.textContent || '').trim().replace(/\s+/g, ' ');
    const chips = [...document.querySelectorAll(selector)].map((el, index) => ({
      index,
      label: labelOf(el),
      selected: el.hasAttribute('selected') || el.classList.contains('iron-selected'),
      isAll: labelOf(el).toLowerCase() === 'all' || (index === 0 && !el.data?.navigationEndpoint),
    }));
    return {
      chips,
      selected: chips.filter((c) => c.selected).map((c) => c.label),
    };
  }, HOME_CHIP_SELECTOR);
}

async function waitForSelected(page, label, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const snap = await chipSnapshot(page);
    if (snap.selected.includes(label)) return snap;
    await wait(500);
  }
  throw new Error(`Timed out waiting for selected chip ${JSON.stringify(label)}; last=${JSON.stringify(await chipSnapshot(page))}`);
}

async function waitForHomeChipMaskClear(page, timeoutMs = 2500) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const applying = await page.evaluate(() => document.documentElement.classList.contains('syf-home-chip-applying'));
    if (!applying) return true;
    await wait(100);
  }
  throw new Error('Timed out waiting for Home chip applying mask to clear');
}

async function waitForRemembered(extPage, label, timeoutMs = 8_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const s = await extPage.evaluate(async (key) => (await chrome.storage.local.get(key))[key], SETTINGS_KEY);
    if ((s?.rememberedHomeChip?.label || null) === label) return s;
    await wait(300);
  }
  throw new Error(`Timed out waiting for rememberedHomeChip=${JSON.stringify(label)}`);
}

async function waitForCleared(extPage, timeoutMs = 8_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const s = await extPage.evaluate(async (key) => (await chrome.storage.local.get(key))[key], SETTINGS_KEY);
    if (!s?.rememberedHomeChip) return s;
    await wait(300);
  }
  throw new Error('Timed out waiting for rememberedHomeChip to clear');
}

async function writeSettings(extPage, value) {
  await extPage.evaluate(
    async ({ key, value }) => {
      if (value === undefined) await chrome.storage.local.remove(key);
      else await chrome.storage.local.set({ [key]: value });
    },
    { key: SETTINGS_KEY, value }
  );
}

const { browser, context } = await connect();
let extensionId = '';
let originalSettings;
try {
  await reloadExtension(context);
  await wait(1200);
  extensionId = await findExtensionId(context);
  if (!extensionId) throw new Error('Could not find extension id');

  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${extensionId}/options/options.html`, { waitUntil: 'domcontentloaded' });
  originalSettings = await ext.evaluate(async (key) => (await chrome.storage.local.get(key))[key], SETTINGS_KEY);
  await writeSettings(ext, { ...(originalSettings || {}), rememberHomeChip: true, rememberedHomeChip: null });

  const home = await context.newPage();
  await home.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded' });
  await waitForHomeChips(home);
  await wait(1500);

  const before = await chipSnapshot(home);
  const target = before.chips.find((c) => c.label === 'Recently uploaded') || before.chips.find((c) => !c.isAll && c.label);
  if (!target) throw new Error(`No non-All Home chip found: ${JSON.stringify(before)}`);

  await home.locator(HOME_CHIP_SELECTOR).nth(target.index).click();
  await home.waitForSelector('#syf-home-chip-toast', { timeout: 5000 });
  const rememberToast = (await home.locator('#syf-home-chip-toast').textContent().catch(() => '')) || '';
  if (!rememberToast.includes('will remember') || !rememberToast.includes(target.label)) {
    throw new Error(`Unexpected remember toast: ${JSON.stringify(rememberToast)} for ${JSON.stringify(target.label)}`);
  }
  const saved = await waitForRemembered(ext, target.label);

  // Cold-start path: the bug-prone case is opening Home with an already stored
  // chip. Validate that independently from the click/save page lifecycle.
  await home.close();
  const coldHome = await context.newPage();
  await coldHome.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded' });
  await waitForHomeChips(coldHome);
  const coldStart = await waitForSelected(coldHome, target.label);
  await waitForHomeChipMaskClear(coldHome);
  await coldHome.close();

  const reloadHome = await context.newPage();
  await reloadHome.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded' });
  await waitForHomeChips(reloadHome);
  await reloadHome.reload({ waitUntil: 'domcontentloaded' });
  await waitForHomeChips(reloadHome);
  await waitForSelected(reloadHome, target.label);
  await waitForHomeChipMaskClear(reloadHome);
  await wait(3000);
  const afterReload = await waitForSelected(reloadHome, target.label);
  await waitForHomeChipMaskClear(reloadHome);

  const beforeToggleOff = await chipSnapshot(reloadHome);
  const selectedTarget = beforeToggleOff.chips.find((c) => c.label === target.label);
  if (!selectedTarget?.selected) {
    throw new Error(`Target chip was not selected before toggle-off click: ${JSON.stringify(beforeToggleOff)}`);
  }
  await reloadHome.locator(HOME_CHIP_SELECTOR).nth(selectedTarget.index).click();
  const cleared = await waitForCleared(ext);
  const afterToggleOff = await waitForSelected(reloadHome, 'All');

  await reloadHome.reload({ waitUntil: 'domcontentloaded' });
  await waitForHomeChips(reloadHome);
  await wait(5000);
  const afterClearReload = await chipSnapshot(reloadHome);
  if (afterClearReload.selected.includes(target.label)) {
    throw new Error(`Remembered chip was selected after clearing: ${JSON.stringify(afterClearReload)}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        remembered: saved.rememberedHomeChip,
        coldStart: coldStart.selected,
        afterReload: afterReload.selected,
        maskClearedAfterSelection: true,
        cleared: !cleared.rememberedHomeChip,
        afterToggleOff: afterToggleOff.selected,
        afterClearReload: afterClearReload.selected,
      },
      null,
      2
    )
  );

  await reloadHome.close();
  await ext.close();
} finally {
  if (extensionId) {
    const ext = await context.newPage().catch(() => null);
    if (ext) {
      try {
        await ext.goto(`chrome-extension://${extensionId}/options/options.html`, { waitUntil: 'domcontentloaded' });
        if (originalSettings === undefined) {
          await writeSettings(ext, undefined);
        } else {
          await writeSettings(ext, originalSettings);
        }
      } finally {
        await ext.close().catch(() => {});
      }
    }
  }
  await browser.close().catch(() => {});
}
