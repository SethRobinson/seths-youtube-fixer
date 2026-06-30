// Account-read-only validation for the recommended playlist/Mix visibility filter.
// It temporarily toggles only this extension's local setting, verifies playlist
// cards are hidden on recommendation surfaces while normal videos and non-recommendation
// playlist links remain visible, then restores the previous settings object.
import { connect, findExtensionId, reloadExtension } from './chrome-lib.mjs';

const SETTINGS_KEY = 'syf.settings';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readSettings(context, extensionId) {
  const p = await context.newPage();
  try {
    await p.goto(`chrome-extension://${extensionId}/options/options.html`);
    return await p.evaluate(async (key) => (await chrome.storage.local.get(key))[key], SETTINGS_KEY);
  } finally {
    await p.close();
  }
}

async function writeSettings(context, extensionId, settings) {
  const p = await context.newPage();
  try {
    await p.goto(`chrome-extension://${extensionId}/options/options.html`);
    await p.evaluate(
      async ({ key, value }) => {
        if (value === undefined) await chrome.storage.local.remove(key);
        else await chrome.storage.local.set({ [key]: value });
      },
      { key: SETTINGS_KEY, value: settings }
    );
  } finally {
    await p.close();
  }
}

async function patchSettings(context, extensionId, patch) {
  const current = (await readSettings(context, extensionId)) || {};
  await writeSettings(context, extensionId, { ...current, ...patch });
}

async function homeProbe(page) {
  return await page.evaluate(() => {
    const visibleByBox = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const playlistCards = [...document.querySelectorAll('ytd-browse[page-subtype="home"] ytd-rich-item-renderer:has(a[href*="list="])')];
    const normalCards = [...document.querySelectorAll('ytd-browse[page-subtype="home"] ytd-rich-item-renderer')]
      .filter((el) => !el.querySelector('a[href*="list="]') && el.querySelector('a[href*="/watch?v="]'));
    return {
      classOn: document.documentElement.classList.contains('syf-hide-recommended-playlists'),
      playlistTotal: playlistCards.length,
      playlistVisible: playlistCards.filter(visibleByBox).length,
      normalTotal: normalCards.length,
      normalVisible: normalCards.filter(visibleByBox).length,
    };
  });
}

async function watchProbe(page) {
  return await page.evaluate(() => {
    const visibleByBox = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const host = document.querySelector('ytd-watch-next-secondary-results-renderer');
    if (!host) {
      return {
        classOn: document.documentElement.classList.contains('syf-hide-recommended-playlists'),
        fixtureHostFound: false,
      };
    }

    document.getElementById('syf-playlist-filter-fixture')?.remove();
    document.getElementById('syf-video-filter-fixture')?.remove();

    const playlistFixture = document.createElement('ytd-compact-playlist-renderer');
    playlistFixture.id = 'syf-playlist-filter-fixture';
    playlistFixture.style.cssText = 'display:block;width:240px;height:48px;';
    const playlistLink = document.createElement('a');
    playlistLink.href = '/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ&start_radio=1';
    playlistLink.textContent = 'Playlist fixture';
    playlistFixture.appendChild(playlistLink);

    const videoFixture = document.createElement('ytd-compact-video-renderer');
    videoFixture.id = 'syf-video-filter-fixture';
    videoFixture.style.cssText = 'display:block;width:240px;height:48px;';
    const videoLink = document.createElement('a');
    videoLink.href = '/watch?v=dQw4w9WgXcQ';
    videoLink.textContent = 'Video fixture';
    videoFixture.appendChild(videoLink);

    host.prepend(videoFixture);
    host.prepend(playlistFixture);

    const actualPlaylistCards = [
      ...document.querySelectorAll(
        'ytd-watch-next-secondary-results-renderer ytd-compact-video-renderer:has(a[href*="list="]), ' +
          'ytd-watch-next-secondary-results-renderer ytd-compact-playlist-renderer, ' +
          'ytd-watch-next-secondary-results-renderer ytd-compact-radio-renderer, ' +
          'ytd-watch-next-secondary-results-renderer yt-lockup-view-model:has(a[href*="list="])'
      ),
    ].filter((el) => el.id !== 'syf-playlist-filter-fixture');

    return {
      classOn: document.documentElement.classList.contains('syf-hide-recommended-playlists'),
      fixtureHostFound: true,
      playlistFixtureVisible: visibleByBox(playlistFixture),
      videoFixtureVisible: visibleByBox(videoFixture),
      actualPlaylistTotal: actualPlaylistCards.length,
      actualPlaylistVisible: actualPlaylistCards.filter(visibleByBox).length,
    };
  });
}

async function scrollHome(page) {
  await page.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded' });
  await wait(8000);
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, 2500);
    await wait(900);
  }
}

const { browser, context } = await connect();
let extensionId = '';
let originalSettings;
try {
  await reloadExtension(context);
  await wait(1200);
  extensionId = await findExtensionId(context);
  if (!extensionId) throw new Error('Could not find extension id');
  originalSettings = await readSettings(context, extensionId);

  await patchSettings(context, extensionId, { hideRecommendedPlaylists: false });
  const home = await context.newPage();
  await scrollHome(home);
  const before = await homeProbe(home);
  if (before.playlistTotal < 1) {
    console.log(JSON.stringify({ skippedHome: true, reason: 'No playlist/Mix cards appeared on Home', before }, null, 2));
    await home.close();
  } else {
    if (before.playlistVisible < 1) throw new Error(`Expected visible Home playlist cards before enabling filter: ${JSON.stringify(before)}`);

    await patchSettings(context, extensionId, { hideRecommendedPlaylists: true });
    await wait(1200);
    const after = await homeProbe(home);
    if (!after.classOn) throw new Error(`Filter class did not apply on Home: ${JSON.stringify(after)}`);
    if (after.playlistVisible !== 0) throw new Error(`Home playlist cards stayed visible: ${JSON.stringify({ before, after })}`);
    if (after.normalVisible < 1) throw new Error(`Normal Home videos were not visible after enabling filter: ${JSON.stringify({ before, after })}`);
    await home.close();

    const watch = await context.newPage();
    await watch.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ', { waitUntil: 'domcontentloaded' });
    await wait(8000);
    const watchResult = await watchProbe(watch);
    if (!watchResult.fixtureHostFound) throw new Error(`Watch sidebar recommendation host was not found: ${JSON.stringify(watchResult)}`);
    if (!watchResult.classOn) throw new Error(`Filter class did not apply on Watch: ${JSON.stringify(watchResult)}`);
    if (watchResult.playlistFixtureVisible) throw new Error(`Watch sidebar playlist fixture stayed visible: ${JSON.stringify(watchResult)}`);
    if (!watchResult.videoFixtureVisible) throw new Error(`Watch sidebar normal-video fixture was hidden: ${JSON.stringify(watchResult)}`);
    if (watchResult.actualPlaylistTotal > 0 && watchResult.actualPlaylistVisible > 0) {
      throw new Error(`Actual Watch sidebar playlist cards stayed visible: ${JSON.stringify(watchResult)}`);
    }
    await watch.close();

    const search = await context.newPage();
    await search.goto('https://www.youtube.com/results?search_query=music&sp=EgIQAw%253D%253D', { waitUntil: 'domcontentloaded' });
    await wait(6000);
    const searchResult = await search.evaluate(() => {
      const visibleByBox = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
      };
      const links = [...document.querySelectorAll('a[href*="list="]')];
      const visibleLinks = links.filter(visibleByBox);
      return {
        classOn: document.documentElement.classList.contains('syf-hide-recommended-playlists'),
        playlistLinkTotal: links.length,
        playlistLinkVisible: visibleLinks.length,
        sampleHref: visibleLinks[0]?.getAttribute('href') || null,
      };
    });
    if (searchResult.playlistLinkTotal < 1) throw new Error(`No non-recommendation playlist links appeared to validate: ${JSON.stringify(searchResult)}`);
    if (searchResult.playlistLinkVisible < 1) throw new Error(`Non-recommendation playlist links were hidden: ${JSON.stringify(searchResult)}`);
    await search.close();

    const settingsAfter = (await readSettings(context, extensionId)) || {};
    console.log(
      JSON.stringify(
        {
          ok: true,
          before,
          after,
          watchResult,
          searchResult,
          hideShortsUnchanged: settingsAfter.hideShorts === originalSettings?.hideShorts,
        },
        null,
        2
      )
    );
  }
} finally {
  if (extensionId) await writeSettings(context, extensionId, originalSettings).catch(() => {});
  await browser.close();
}
