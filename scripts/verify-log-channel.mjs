// Verify the action-log rows now show the channel name and that title/channel are
// clickable links to the video/channel. Read-only: does NOT mutate the stored log.
import { connect, findExtensionId, reloadExtension } from './chrome-lib.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const { browser, context } = await connect();
await reloadExtension(context);
await wait(1500);

const id = await findExtensionId(context);
const ext = await context.newPage();
await ext.goto(`chrome-extension://${id}/options/options.html`);

// Wait for the log to render (or the empty-state).
await ext.waitForSelector('#log .logrow, #log .empty', { timeout: 10000 });

const rows = await ext.evaluate(() =>
  [...document.querySelectorAll('#log .logrow')].slice(0, 8).map((r) => {
    const t = r.querySelector('.logtitle');
    const c = r.querySelector('.logchannel');
    const ta = t?.querySelector('a.loglink');
    const ca = c?.querySelector('a.loglink');
    return {
      title: t?.textContent?.trim() || null,
      titleHref: ta?.getAttribute('href') || null,
      titleTarget: ta?.getAttribute('target') || null,
      channel: c?.textContent?.trim() || null,
      channelHref: ca?.getAttribute('href') || null,
      channelTarget: ca?.getAttribute('target') || null,
      undone: r.classList.contains('undone'),
    };
  })
);

console.log(`rows shown: ${rows.length}`);
for (const r of rows) console.log(JSON.stringify(r));

const withChannel = rows.filter((r) => r.channel);
const goodVideoLinks = rows.filter((r) => r.titleHref?.startsWith('https://www.youtube.com/watch?v='));
const goodChannelLinks = rows.filter((r) => r.channelHref?.startsWith('https://www.youtube.com/channel/UC'));
console.log(
  `\nsummary: ${withChannel.length}/${rows.length} rows show a channel; ` +
    `${goodVideoLinks.length} video links; ${goodChannelLinks.length} channel links; ` +
    `all open new tab: ${rows.every((r) => !r.titleHref || r.titleTarget === '_blank')}`
);

await ext.screenshot({ path: 'test-results/action-log-channels.png', fullPage: true });
console.log('screenshot → test-results/action-log-channels.png');

await browser.close();
