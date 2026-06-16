// Reload the extension in the running dev Chrome after a rebuild.
import { connect, reloadExtension, EXT_NAME } from './chrome-lib.mjs';

const { browser, context } = await connect();
const ok = await reloadExtension(context);
console.log(ok ? `✓ Reloaded ${EXT_NAME}.` : `✗ Could not find ${EXT_NAME} to reload (run \`npm run setup\`).`);
await browser.close();
process.exit(ok ? 0 : 1);
