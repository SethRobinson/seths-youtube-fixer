// Reload the extension in the running dev Chrome after a rebuild.
import { connect, reloadExtension, EXT_NAME } from './chrome-lib.mjs';

const { browser, context } = await connect();
const ok = await reloadExtension(context);

// Reloading the extension orphans content scripts in already-open tabs — refresh
// any open YouTube tabs so their bar reconnects to the new build.
if (ok) {
  await new Promise((r) => setTimeout(r, 1000));
  let refreshed = 0;
  for (const p of context.pages()) {
    if (/^https:\/\/(www\.)?youtube\.com\//.test(p.url())) {
      try {
        await p.reload({ waitUntil: 'domcontentloaded' });
        refreshed++;
      } catch {
        /* tab may have closed */
      }
    }
  }
  console.log(`✓ Reloaded ${EXT_NAME}; refreshed ${refreshed} open YouTube tab(s).`);
} else {
  console.log(`✗ Could not find ${EXT_NAME} to reload (run \`npm run setup\`).`);
}
await browser.close();
process.exit(ok ? 0 : 1);
