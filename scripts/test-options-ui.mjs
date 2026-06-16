import { connect, findExtensionId, reloadExtension } from './chrome-lib.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const { browser, context } = await connect();
await reloadExtension(context);
await wait(1500);
const id = await findExtensionId(context);
const p = await context.newPage();
await p.goto(`chrome-extension://${id}/options/options.html`);
await wait(2000);
console.log('cards:', await p.locator('.card').count());
console.log('cacheSize:', JSON.stringify(await p.locator('#cacheSize').textContent()));
await p.screenshot({ path: 'test-results/options-ui.png', fullPage: true });
await browser.close();
