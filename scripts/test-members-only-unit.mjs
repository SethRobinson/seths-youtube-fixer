// Offline regression tests: no browser, account, or stored settings are touched.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import vm from 'node:vm';

const compiled = await build({
  entryPoints: ['src/common/members-only.ts'], bundle: true, write: false,
  platform: 'node', format: 'esm', logLevel: 'silent',
});
const { memberVideoState, membersOnlyCss } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`
);
const exceptionModule = await build({ entryPoints: ['src/common/channel-exceptions.ts'], bundle: true,
  write: false, platform: 'node', format: 'esm', logLevel: 'silent' });
const { channelInputUrl, channelFromHtml, resolveMemberChannel } = await import(
  `data:text/javascript;base64,${Buffer.from(exceptionModule.outputFiles[0].text).toString('base64')}`
);

const videoId = 'pjjGavVjhcE';
const channelId = 'UCT6AJiTYspOILBK3hMWEq2g';
const otherChannelId = 'UCBBBBBBBBBBBBBBBBBBBBBB';
const state = (id = videoId, owner) => ({ videoId: id, membersOnly: true, ...(owner ? { channelId: owner } : {}) });
const modernCard = (badgeStyle, badgeText = 'Members only') => ({
  lockupViewModel: {
    contentId: videoId, contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
    metadata: { lockupMetadataViewModel: {
      title: { content: 'Things I Wish I Knew Before I Started 3D Printing' },
      metadata: { contentMetadataViewModel: { metadataRows: [
        { metadataParts: [{ text: { content: '4mo ago' } }] },
        { badges: [{ badgeViewModel: { badgeStyle, badgeText, iconName: 'SPONSORSHIP_STAR' } }] },
      ] } },
    } },
  },
});

test('modern membership badge is recognized independently of its translated text', () => {
  for (const label of ['Members only', 'メンバー限定', 'Réservé aux membres']) {
    assert.deepEqual(memberVideoState(modernCard('BADGE_MEMBERS_ONLY', label)), { videoId, membersOnly: true });
  }
});

test('commerce styling, a sponsorship icon, or words in the title do not imply membership', () => {
  const card = modernCard('BADGE_COMMERCE');
  card.lockupViewModel.metadata.lockupMetadataViewModel.title.content = 'Members only: how memberships work';
  assert.deepEqual(memberVideoState(card), { videoId, membersOnly: false });
});

test('legacy Home, Search, sidebar, and playlist video badges are recognized', () => {
  for (const type of ['videoRenderer', 'gridVideoRenderer', 'compactVideoRenderer', 'playlistVideoRenderer']) {
    assert.deepEqual(memberVideoState({ [type]: { videoId, badges: [
      { metadataBadgeRenderer: { style: 'BADGE_STYLE_TYPE_MEMBERS_ONLY', label: 'メンバー限定' } },
    ] } }), { videoId, membersOnly: true });
  }
  assert.deepEqual(memberVideoState({ videoRenderer: {
    videoId, sponsorsOnlyBadge: { sponsorsOnlyBadgeRenderer: { icon: { iconType: 'SPONSORSHIP_STAR' } } },
  } }), { videoId, membersOnly: true });
});

test('an updated public video can remove an earlier members-only state', () => {
  assert.deepEqual(memberVideoState({ videoRenderer: { videoId, badges: [] } }), { videoId, membersOnly: false });
});

test('channel, playlist, and malformed nodes cannot supply CSS selectors', () => {
  assert.equal(memberVideoState(null), undefined);
  assert.equal(memberVideoState({ channelRenderer: { videoId } }), undefined);
  const playlist = modernCard('BADGE_MEMBERS_ONLY');
  playlist.lockupViewModel.contentType = 'LOCKUP_CONTENT_TYPE_PLAYLIST';
  assert.equal(memberVideoState(playlist), undefined);
  assert.equal(memberVideoState({ videoRenderer: { videoId: '"]{}body{}' } }), undefined);
  assert.ok(!membersOnlyCss([state('"]{}body{}')]).includes('"]{}body{}'));
});

test('generated CSS requires opt-in and matches complete watch IDs in any query position', () => {
  const css = membersOnlyCss([state()]);
  assert.ok(css.startsWith('html.syf-hide-members-only '));
  assert.ok(css.includes('ytd-rich-item-renderer'));
  assert.ok(css.includes('ytd-compact-video-renderer'));
  for (const boundary of [`[href$="?v=${videoId}"]`, `[href*="?v=${videoId}&"]`,
    `[href$="&v=${videoId}"]`, `[href*="&v=${videoId}&"]`]) assert.ok(css.includes(boundary));
  assert.ok(membersOnlyCss([]).includes('.badge-style-type-members-only'));
});

test('uploader IDs come from bylines/avatars, never another channel in the menu', () => {
  const endpoint = { browseEndpoint: { browseId: channelId } };
  const classic = { videoRenderer: { videoId, longBylineText: { runs: [
    { text: 'Creator', navigationEndpoint: endpoint },
  ] } } };
  assert.equal(memberVideoState(classic).channelId, channelId);
  const modern = modernCard('BADGE_MEMBERS_ONLY');
  modern.lockupViewModel.metadata.lockupMetadataViewModel.image = {
    decoratedAvatarViewModel: { rendererContext: { commandContext: { onTap: { innertubeCommand: endpoint } } } },
  };
  assert.equal(memberVideoState(modern).channelId, channelId);
  assert.equal(memberVideoState(modern, otherChannelId).channelId, channelId, 'explicit uploader overrides grid context');
  assert.equal(memberVideoState({ videoRenderer: { videoId } }, channelId).channelId, channelId);
  delete modern.lockupViewModel.metadata.lockupMetadataViewModel.image;
  modern.lockupViewModel.menu = { navigationEndpoint: endpoint };
  assert.equal(memberVideoState(modern).channelId, undefined);
});

test('exceptions exclude only their own videos, including the legacy badge fallback', () => {
  const css = membersOnlyCss([state(videoId, channelId), state('other000001', otherChannelId), state('unknown0001')], [channelId]);
  const [hidden, exempt] = css.split(':not(:has(');
  assert.ok(!hidden.includes(videoId));
  assert.ok(hidden.includes('other000001'));
  assert.ok(hidden.includes('unknown0001'));
  assert.ok(exempt.includes(videoId));
  assert.ok(!exempt.includes('other000001'));
  assert.ok(hidden.includes('.badge-style-type-members-only'));
  const withoutException = membersOnlyCss([state(videoId, channelId)]);
  assert.ok(withoutException.includes(videoId));
  assert.ok(!withoutException.includes(':not(:has('));
  assert.ok(!membersOnlyCss([{ ...state(), membersOnly: false }]).includes(videoId));
});

test('channel input accepts handles, channel URLs, legacy links, and stable IDs', () => {
  for (const input of ['@SwitchandClickOfficial', ' https://www.youtube.com/@SwitchandClickOfficial/videos?view=0 ',
    'youtube.com/@SwitchandClickOfficial', 'http://m.youtube.com/@SwitchandClickOfficial/about']) {
    assert.equal(channelInputUrl(input), 'https://www.youtube.com/@SwitchandClickOfficial/about?hl=en');
  }
  assert.equal(channelInputUrl(channelId), `https://www.youtube.com/channel/${channelId}/about?hl=en`);
  assert.equal(channelInputUrl(`https://youtube.com/channel/${channelId}/membership`), `https://www.youtube.com/channel/${channelId}/about?hl=en`);
  assert.equal(channelInputUrl('https://www.youtube.com/user/Example'), 'https://www.youtube.com/user/Example/about?hl=en');
  assert.equal(channelInputUrl('https://youtube.com/c/Example'), 'https://www.youtube.com/c/Example/about?hl=en');
  assert.equal(channelInputUrl('@日本語'), 'https://www.youtube.com/@%E6%97%A5%E6%9C%AC%E8%AA%9E/about?hl=en');
});

test('invalid/offsite/video URLs and malformed handles are rejected before fetching', () => {
  for (const input of ['', 'Some Display Name', 'https://evil.test/@creator', 'https://youtube.com.evil.test/@creator',
    'https://user:secret@youtube.com/@creator', 'https://youtube.com:8443/@creator', 'file:///tmp/test',
    'https://youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ',
    'https://youtube.com/playlist?list=PL123', '@bad handle', '@bad%2Fhandle', '@bad%ZZ',
    'https://youtube.com/@creator/anything', 'https://youtube.com/channel/not-an-id']) {
    assert.throws(() => channelInputUrl(input), undefined, input);
  }
});

const htmlFor = (id, name) => `<script>var ytInitialData = ${JSON.stringify({ metadata: {
  channelMetadataRenderer: { externalId: id, title: name },
} })};</script>`;

test('channel resolution uses channel metadata, not IDs in descriptions/recommendations', () => {
  assert.deepEqual(channelFromHtml(htmlFor(channelId, '<img src=x onerror=alert(1)>')), {
    channelId, name: '<img src=x onerror=alert(1)>',
  });
  for (const html of ['consent screen', '<script>var ytInitialData = {broken};</script>',
    htmlFor('not-a-channel', 'Example'), htmlFor(channelId, '')]) assert.throws(() => channelFromHtml(html));
});

test('resolver handles not-found, network errors, and successful public lookups without cookies', async () => {
  const originalFetch = globalThis.fetch;
  try {
    let called = false;
    globalThis.fetch = async (url, options) => {
      called = true;
      assert.equal(url, 'https://www.youtube.com/@Example/about?hl=en');
      assert.equal(options.credentials, 'omit');
      return new Response(htmlFor(channelId, 'Example'));
    };
    assert.deepEqual(await resolveMemberChannel('@Example'), { channelId, name: 'Example' });
    assert.equal(called, true);
    called = false;
    await assert.rejects(resolveMemberChannel('https://evil.test/@Example'));
    assert.equal(called, false);
    globalThis.fetch = async () => new Response('', { status: 404 });
    await assert.rejects(resolveMemberChannel('@Example'), /Couldn’t find/);
    globalThis.fetch = async () => { throw new Error('Network failure'); };
    await assert.rejects(resolveMemberChannel('@Example'), /Couldn’t reach/);
  } finally { globalThis.fetch = originalFetch; }
});

test('bridge reports changed badges, replays startup state, and clears a now-public video', async () => {
  const bridge = await build({ entryPoints: ['src/content/page-bridge.ts'], bundle: true, write: false,
    format: 'iife', define: { __SYF_DEV__: 'false' }, logLevel: 'silent' });
  const messages = [];
  const listeners = new Map();
  const window = {
    ytInitialData: modernCard('BADGE_MEMBERS_ONLY'),
    fetch: async () => { throw new Error('Offline test must not fetch'); },
    postMessage: (message) => messages.push(message),
    addEventListener: (event, listener) => listeners.set(event, listener),
  };
  vm.runInNewContext(bridge.outputFiles[0].text, {
    window, document: { querySelector: () => null, getElementById: () => null },
    location: { pathname: '/', origin: 'https://www.youtube.com' },
    setInterval: () => 1, clearInterval: () => {},
  });
  const membership = () => JSON.parse(JSON.stringify(messages.filter((message) => message.type === 'MEMBER_VIDEOS')));
  assert.deepEqual(membership()[0].items, [{ videoId, membersOnly: true }]);
  messages.length = 0;
  listeners.get('yt-navigate-finish')();
  assert.equal(membership().length, 0, 'unchanged hydration must not resend membership state');
  listeners.get('message')({ source: window, data: { __syf: true, dir: 'to-page', type: 'REQUEST_CONFIG' } });
  assert.deepEqual(membership()[0].items, [{ videoId, membersOnly: true }], 'a late content listener receives the snapshot');
  messages.length = 0;
  window.ytInitialData.lockupViewModel.metadata.lockupMetadataViewModel.image = {
    decoratedAvatarViewModel: { rendererContext: { commandContext: { onTap: {
      innertubeCommand: { browseEndpoint: { browseId: channelId } },
    } } } },
  };
  listeners.get('yt-navigate-finish')();
  assert.deepEqual(membership()[0].items, [state(videoId, channelId)], 'late owner hydration updates the exception match');
  messages.length = 0;
  window.ytInitialData = modernCard('BADGE_MEMBERS_ONLY');
  listeners.get('yt-navigate-finish')();
  assert.equal(membership().length, 0, 'sparse data must not erase the known uploader');
  listeners.get('message')({ source: window, data: { __syf: true, dir: 'to-page', type: 'REQUEST_CONFIG' } });
  assert.deepEqual(membership()[0].items, [state(videoId, channelId)]);
  messages.length = 0;
  window.ytInitialData = { videoRenderer: { videoId, badges: [], menu: { items: [
    { menuServiceItemRenderer: { icon: { iconType: 'HIDE' },
      serviceEndpoint: { feedbackEndpoint: { feedbackToken: 'offline-test-token' } } } },
  ] } } };
  listeners.get('yt-navigate-finish')();
  assert.deepEqual(membership()[0].items, [{ videoId, membersOnly: false }]);
  assert.equal(messages.find((message) => message.type === 'CAPTURE')?.items[0]?.notInterestedToken,
    'offline-test-token', 'the existing feedback capture must still work');
});

test('channel upload scope and matching continuations supply missing owners without affecting unrelated cards', async () => {
  const bridge = await build({ entryPoints: ['src/content/page-bridge.ts'], bundle: true, write: false,
    format: 'iife', define: { __SYF_DEV__: 'false' }, logLevel: 'silent' });
  const channelRoot = (tab, card) => ({ metadata: { channelMetadataRenderer: { externalId: channelId } },
    contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { selected: true,
      endpoint: { commandMetadata: { webCommandMetadata: { url: `/@Creator/${tab}` } } },
      content: { richGridRenderer: { targetId: 'channel-grid-test', contents: [card] } },
    } }] } } });
  const messages = [];
  const listeners = new Map();
  let payload;
  const window = {
    ytInitialData: channelRoot('videos', modernCard('BADGE_MEMBERS_ONLY')),
    fetch: async () => ({ clone: () => ({ json: async () => payload }) }),
    postMessage: (message) => messages.push(message),
    addEventListener: (event, listener) => listeners.set(event, listener),
  };
  vm.runInNewContext(bridge.outputFiles[0].text, {
    window, document: { querySelector: () => null, getElementById: () => null },
    location: { pathname: '/@Creator/videos', origin: 'https://www.youtube.com' },
    setInterval: () => 1, clearInterval: () => {},
  });
  const captured = () => JSON.parse(JSON.stringify(messages.filter((message) => message.type === 'MEMBER_VIDEOS').flatMap((message) => message.items)));
  assert.deepEqual(captured(), [state(videoId, channelId)]);
  const continuation = async (targetId, id) => {
    messages.length = 0;
    const card = modernCard('BADGE_MEMBERS_ONLY');
    card.lockupViewModel.contentId = id;
    payload = { onResponseReceivedActions: [{ appendContinuationItemsAction: { targetId, continuationItems: [card] } }] };
    await window.fetch('/youtubei/v1/browse');
    await new Promise(setImmediate);
    return captured();
  };
  assert.deepEqual(await continuation('channel-grid-test', 'later000001'), [state('later000001', channelId)]);
  assert.deepEqual(await continuation('unrelated-target', 'third000001'), [state('third000001')]);
  messages.length = 0;
  const featured = modernCard('BADGE_MEMBERS_ONLY');
  featured.lockupViewModel.contentId = 'fresh000001';
  window.ytInitialData = channelRoot('featured', featured);
  listeners.get('yt-navigate-finish')();
  assert.deepEqual(captured(), [state('fresh000001')], 'a channel featured page can recommend other creators');
});
