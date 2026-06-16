// Verify Wipe + Info open standalone pages in new tabs.
import { connect, findExtensionId, reloadExtension } from './chrome-lib.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const { browser, context } = await connect();
await reloadExtension(context);
await wait(1500);
await findExtensionId(context);

const w = await context.newPage();
await w.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ', { waitUntil: 'domcontentloaded' });
await w.waitForSelector('#syf-bar [data-action="info"]', { timeout: 30000 });

await w.locator('#syf-bar [data-action="info"]').click();
await wait(1500);
const logTab = context.pages().find((p) => p.url().includes('/log/log.html'));
console.log('Info -> log tab:', !!logTab);
if (logTab) {
  await wait(600);
  const h1 = await logTab.locator('h1').textContent().catch(() => '');
  const root = await logTab.locator('#root').count();
  console.log('  log page h1:', JSON.stringify(h1), 'root present:', root === 1);
}

await w.locator('#syf-bar [data-action="wipe"]').click();
await wait(1500);
const wipeTab = context.pages().find((p) => p.url().includes('/wipe/wipe.html'));
console.log('Wipe -> wipe tab:', !!wipeTab);
if (wipeTab) {
  await wait(600);
  const presets = await wipeTab.locator('.preset').count();
  const h1 = await wipeTab.locator('h1').textContent().catch(() => '');
  console.log('  wipe page h1:', JSON.stringify(h1), 'presets:', presets);
}

await browser.close();
