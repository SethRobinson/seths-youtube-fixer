// Quick smoke check via CDP: confirm the extension is loaded and injects its bar.
import { connect, findExtensionId, EXT_NAME } from './chrome-lib.mjs';

const { browser, context } = await connect();

const id = await findExtensionId(context);
if (!id) {
  console.error(`✗ ${EXT_NAME} is not loaded. Run \`npm run setup\` and Load unpacked dist/ once.`);
  await browser.close();
  process.exit(1);
}
console.log('✓ Extension loaded. id =', id);

const page = await context.newPage();
page.on('console', (m) => {
  if (m.text().includes('[SYF]')) console.log('PAGE[SYF]:', m.text());
});
await page.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ', { waitUntil: 'domcontentloaded' });

try {
  await page.waitForSelector('#syf-bar', { timeout: 30000 });
  const count = await page.locator('#syf-bar .syf-btn').count();
  console.log(`✓ Button bar injected with ${count} buttons.`);
  await page.screenshot({ path: 'test-results/drive.png' });
  console.log('  Screenshot: test-results/drive.png');
} catch {
  console.error('✗ Button bar did not appear within 30s.');
  await page.screenshot({ path: 'test-results/drive-fail.png' }).catch(() => {});
  await browser.close();
  process.exit(1);
}

await page.close();
await browser.close();
