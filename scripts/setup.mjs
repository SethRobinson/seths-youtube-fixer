// One-time setup: open the dedicated dev profile so you can Load unpacked + sign in.
import { connect, findExtensionId, PROFILE, PORT, EXT_NAME } from './chrome-lib.mjs';
import path from 'node:path';

const dist = path.resolve(process.cwd(), 'dist');
const { browser, context } = await connect();
const id = await findExtensionId(context).catch(() => '');

const page = context.pages().find((p) => !p.url().startsWith('devtools://')) ?? (await context.newPage());
await page.goto('chrome://extensions');

console.log('────────────────────────────────────────────────────────────');
console.log(`One-time setup — ${EXT_NAME} test profile`);
console.log('Profile :', PROFILE);
console.log('CDP port:', PORT);
console.log('');
if (id) {
  console.log('✓ Extension is already loaded.  id =', id);
  console.log('  (If you just want to refresh it after a build: npm run reload)');
} else {
  console.log('In the Chrome window that just opened (chrome://extensions):');
  console.log('  1. Toggle ON "Developer mode" (top-right).');
  console.log('  2. Click "Load unpacked".');
  console.log('  3. Choose this folder:');
  console.log('       ' + dist);
  console.log('');
  console.log('Then open https://www.youtube.com in that window and sign in once.');
}
console.log('');
console.log('Leave this Chrome window open while developing.');
console.log('────────────────────────────────────────────────────────────');

// Disconnect CDP but leave Chrome running (it was spawned detached).
await browser.close();
