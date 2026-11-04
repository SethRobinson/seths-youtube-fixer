// Public-data repro: node scripts/test-members-only.mjs --data-only
// Live browser validation (requires permission to control the browser):
//   node scripts/test-members-only.mjs
// Only the local visibility setting is toggled, then restored. No watch pages are
// opened and no account feedback, subscription, or membership changes are sent.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { connect, findExtensionId, reloadExtension } from './chrome-lib.mjs';

const CHANNEL = 'https://www.youtube.com/@SwitchandClickOfficial/videos?hl=en';
const SETTINGS_KEY = 'syf.settings';

async function publicCards() {
  const compiled = await build({ entryPoints: ['src/common/members-only.ts'], bundle: true,
    write: false, platform: 'node', format: 'esm', logLevel: 'silent' });
  const { memberVideoState } = await import(
    `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`
  );
  const response = await fetch(CHANNEL);
  assert.equal(response.status, 200);
  const html = await response.text();
  const initial = html.match(/var ytInitialData = (.+?);<\/script>/s);
  assert.ok(initial, 'YouTube did not return embedded page data');
  const cards = new Map();
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    const member = memberVideoState(node);
    if (member) cards.set(member.videoId, member.membersOnly);
    for (const child of Object.values(node)) walk(child);
  }
  walk(JSON.parse(initial[1]));
  const members = [...cards].filter(([, value]) => value).map(([id]) => id);
  assert.ok(members.length, 'No real members-only cards were available for reproduction');
  return { totalVideos: cards.size, membersOnly: members.length, sampleIds: members.slice(0,3) };
}

if (process.argv.includes('--data-only')) {
  console.log(JSON.stringify({ publicData: await publicCards() }, null, 2));
} else {
  const { browser, context } = await connect();
  let options;
  let page;
  let extraPage;
  let originalSettings;
  let settingsRead = false;
  try {
    await reloadExtension(context);
    const extensionId = await findExtensionId(context);
    assert.ok(extensionId, 'The extension must be loaded in the test profile');
    options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options/options.html`);
    const checkbox = options.locator('#hideMembersOnly');
    await checkbox.waitFor();
    originalSettings = await options.evaluate(async (key) => (await chrome.storage.local.get(key))[key], SETTINGS_KEY);
    settingsRead = true;
    await assertChecked(options, !!originalSettings?.hideMembersOnly);
    await options.evaluate(() => chrome.runtime.sendMessage({ type: 'SYF_PATCH_SETTINGS', patch: { membersOnlyChannelExceptions: [] } }));
    await checkbox.setChecked(false);

    page = await context.newPage();
    // This channel's Videos tab reliably exposes members-only cards, unlike a
    // personalized Home feed where their presence depends on recommendations.
    await page.goto(CHANNEL, { waitUntil: 'domcontentloaded' });
    const liveCards = await page.waitForFunction(() => {
      const selectors = 'yt-lockup-view-model, ytd-video-renderer, ytd-grid-video-renderer';
      const visible = (el) => el.getBoundingClientRect().height > 0 && getComputedStyle(el).display !== 'none';
      const cards = [...document.querySelectorAll(selectors)].filter(visible);
      const members = cards.filter((card) => [...card.querySelectorAll('yt-badge-view-model, ytd-badge-supported-renderer, ytd-sponsors-only-badge-renderer')]
        .some((badge) => badge.textContent.trim() === 'Members only'));
      const ids = (list) => list.map((el) => {
        const link = el.querySelector('a[href*="/watch?"]');
        return link && new URL(link.href).searchParams.get('v');
      }).filter(Boolean);
      const publicCards = cards.filter((card) => !members.includes(card) && card.querySelector('a[href*="/watch?"]'));
      return members.length && publicCards.length ? { memberIds: ids(members), publicIds: ids(publicCards) } : false;
    }, null, { timeout: 45000 });
    const { memberIds, publicIds } = await liveCards.jsonValue();
    const signedIn = await page.evaluate(() => !!window.ytcfg?.get('LOGGED_IN'));
    assert.ok(memberIds.length, 'Real membership badges must be visible before enabling');

    await checkbox.setChecked(true);
    await page.waitForFunction((ids) => ids.every((id) => {
      const link = [...document.querySelectorAll('a[href*="/watch?"]')].find((el) => new URL(el.href).searchParams.get('v') === id);
      return link && link.getBoundingClientRect().height === 0;
    }), memberIds);
    await options.reload();
    await assertChecked(options, true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction((ids) => ids.every((id) => {
      const link = [...document.querySelectorAll('a[href*="/watch?"]')].find((el) => new URL(el.href).searchParams.get('v') === id);
      return link && link.getBoundingClientRect().height === 0;
    }), memberIds);
    const publicVisible = await page.evaluate((ids) => ids.every((id) => {
      const link = [...document.querySelectorAll('a[href*="/watch?"]')].find((el) => new URL(el.href).searchParams.get('v') === id);
      return link && link.getBoundingClientRect().height > 0;
    }), publicIds);
    assert.ok(publicVisible, 'real public videos must remain visible');

    // Deterministic cards cover Home + sidebar + Search layouts, future insertion,
    // ID boundaries, a public commerce badge, and recycled card URLs. They use
    // already-confirmed real video IDs; no forged bridge messages are needed.
    const memberId = memberIds[0];
    await page.evaluate(async (id) => {
      const fixture = document.createElement('div');
      fixture.id = 'syf-members-fixture';
      for (const [name, tag, href] of [
        ['home', 'ytd-rich-item-renderer', `/watch?v=${id}`],
        ['sidebar', 'ytd-compact-video-renderer', `/watch?feature=related&v=${id}&test=1`],
        ['search', 'ytd-video-renderer', `https://www.youtube.com/watch?v=${id}&test=1`],
        ['public', 'yt-lockup-view-model', '/watch?v=dQw4w9WgXcQ'],
        ['prefix', 'yt-lockup-view-model', `/watch?v=${id}x`],
        ['legacy', 'ytd-grid-video-renderer', '/watch?v=legacy00001'],
        ['legacyallowed', 'ytd-grid-video-renderer', `/watch?v=${id}`],
      ]) {
        const card = document.createElement(tag);
        card.id = `syf-test-${name}`;
        card.style.cssText = 'display:block;height:48px;width:240px';
        // Let YouTube stamp its custom-element template before adding children;
        // otherwise initial hydration replaces the fixture's video link.
        fixture.append(card);
        document.body.append(fixture);
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const link = document.createElement('a');
        link.href = href;
        link.textContent = name === 'public' ? 'Members only mentioned in a public title' : name;
        card.append(link);
        if (name === 'legacy' || name === 'legacyallowed') {
          const badge = document.createElement('ytd-badge-supported-renderer');
          badge.className = 'badge-style-type-members-only';
          card.append(badge);
        }
        if (name === 'public') {
          const badge = document.createElement('yt-badge-view-model');
          badge.className = 'ytBadgeShapeCommerce';
          badge.textContent = 'Buy';
          card.append(badge);
        }
      }
    }, memberId);
    const probe = () => page.evaluate(() => Object.fromEntries(
      [...document.querySelectorAll('#syf-members-fixture > *')].map((el) => [el.id, el.getBoundingClientRect().height > 0])
    ));
    const filtered = await probe();
    const diagnostics = await page.evaluate((id) => ({
      memberId: id,
      cssHasId: document.getElementById('syf-members-only-rules')?.textContent.includes(id),
      home: document.getElementById('syf-test-home')?.outerHTML,
    }), memberId);
    for (const name of ['home', 'sidebar', 'search', 'legacy', 'legacyallowed']) {
      assert.equal(filtered[`syf-test-${name}`], false, `${name}: ${JSON.stringify(diagnostics)}`);
    }
    for (const name of ['public', 'prefix']) assert.equal(filtered[`syf-test-${name}`], true, name);
    await page.locator('#syf-test-home a').evaluate((link) => link.setAttribute('href', '/watch?v=dQw4w9WgXcQ'));
    assert.equal((await probe())['syf-test-home'], true, 'a recycled public card must reappear');

    // Test a second uploader arriving through a browse continuation. The route
    // supplies sanitized data, so this sends no request or feedback to YouTube.
    await page.route('**/youtubei/v1/browse?syf-test=members-only', (route) => route.fulfill({
      contentType: 'application/json', body: JSON.stringify({ items: [{ videoRenderer: {
        videoId: 'other000001', longBylineText: { runs: [{ navigationEndpoint: {
          browseEndpoint: { browseId: 'UCBBBBBBBBBBBBBBBBBBBBBB' },
        } }] }, badges: [{ metadataBadgeRenderer: { style: 'BADGE_STYLE_TYPE_MEMBERS_ONLY' } }],
      } }] }),
    }));
    await page.evaluate(async () => { await fetch('/youtubei/v1/browse?syf-test=members-only').then((response) => response.json()); });
    await page.unroute('**/youtubei/v1/browse?syf-test=members-only');
    await page.evaluate(() => {
      const card = document.createElement('yt-lockup-view-model');
      card.id = 'syf-test-other';
      card.style.cssText = 'display:block;height:48px;width:240px';
      const link = document.createElement('a');
      link.href = '/watch?v=other000001';
      link.textContent = 'Other uploader';
      card.append(link);
      document.getElementById('syf-members-fixture').append(card);
    });
    await page.waitForFunction(() => document.getElementById('syf-test-other').getBoundingClientRect().height === 0);

    const addInput = () => options.locator('#memberExceptionInput');
    const list = () => options.locator('#memberExceptionsList li');
    const status = () => options.locator('#memberExceptionStatus');
    const addChannel = async (input) => {
      await addInput().fill(input);
      await addInput().press('Enter');
      await options.waitForFunction(() => !document.querySelector('#addMemberException').disabled);
    };
    for (const input of ['https://example.com/@Example', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', '']) {
      await addChannel(input);
      assert.equal(await status().getAttribute('data-error'), 'true');
      assert.equal(await list().count(), 0);
    }
    await addChannel('@SwitchandClickOfficial');
    assert.equal(await status().getAttribute('data-error'), 'false', await status().textContent());
    assert.equal(await list().count(), 1);
    const allowedChannelId = await list().first().getAttribute('data-channel-id');
    assert.equal(allowedChannelId, 'UCT6AJiTYspOILBK3hMWEq2g');
    await page.waitForFunction((ids) => ids.every((id) => {
      const link = [...document.querySelectorAll('a[href*="/watch?"]')].find((el) => new URL(el.href).searchParams.get('v') === id);
      return link && link.getBoundingClientRect().height > 0;
    }), memberIds);
    const exempted = await probe();
    for (const name of ['sidebar', 'search', 'legacyallowed', 'public', 'prefix']) assert.equal(exempted[`syf-test-${name}`], true, name);
    for (const name of ['legacy', 'other']) assert.equal(exempted[`syf-test-${name}`], false, name);

    // A membership exception must not override another feed filter's CSS.
    await options.evaluate(() => chrome.runtime.sendMessage({ type: 'SYF_PATCH_SETTINGS', patch: { hideShorts: true } }));
    await page.evaluate(() => {
      const link = document.createElement('a');
      link.id = 'syf-short-filter-check';
      link.href = '/shorts/short000001';
      document.getElementById('syf-test-search').append(link);
    });
    await page.waitForFunction(() => document.documentElement.classList.contains('syf-hide-shorts') &&
      document.getElementById('syf-test-search').getBoundingClientRect().height === 0);
    assert.equal((await probe())['syf-test-sidebar'], true, 'the non-Shorts exception should remain visible');
    await page.locator('#syf-short-filter-check').evaluate((link) => link.remove());
    assert.equal((await probe())['syf-test-search'], true);
    await options.evaluate((hideShorts) => chrome.runtime.sendMessage({ type: 'SYF_PATCH_SETTINGS', patch: { hideShorts } }), !!originalSettings?.hideShorts);

    // Confirm that an exception survives both settings and YouTube page reloads.
    await options.reload();
    await list().first().waitFor();
    extraPage = await context.newPage();
    await extraPage.goto(CHANNEL, { waitUntil: 'domcontentloaded' });
    await extraPage.waitForFunction((id) => {
      const css = document.getElementById('syf-members-only-rules')?.textContent || '';
      const link = [...document.querySelectorAll('a[href*="/watch?"]')].find((el) => new URL(el.href).searchParams.get('v') === id);
      return css.includes(':not(:has(') && link && link.getBoundingClientRect().height > 0;
    }, memberId);
    await extraPage.close();
    extraPage = undefined;
    await addChannel(`https://www.youtube.com/channel/${allowedChannelId}`);
    assert.equal(await list().count(), 1, 'handle and canonical ID must deduplicate');
    assert.match(await status().textContent(), /already/);

    // Remove in a second settings window; the first window and the live page
    // should update immediately via storage.onChanged.
    extraPage = await context.newPage();
    await extraPage.goto(`chrome-extension://${extensionId}/options/options.html`);
    await extraPage.locator('#memberExceptionsList button').first().click();
    await options.waitForFunction(() => document.querySelectorAll('#memberExceptionsList li').length === 0);
    await page.waitForFunction(() => document.getElementById('syf-test-legacyallowed').getBoundingClientRect().height === 0);
    const removed = await probe();
    for (const name of ['sidebar', 'search', 'legacyallowed', 'other']) assert.equal(removed[`syf-test-${name}`], false, name);
    await extraPage.close();
    extraPage = undefined;

    await checkbox.setChecked(false);
    await page.waitForFunction(() => !document.documentElement.classList.contains('syf-hide-members-only'));
    const restored = await probe();
    assert.ok(Object.values(restored).every(Boolean), 'disabling the filter must restore every card');
    await page.waitForFunction((ids) => ids.every((id) => {
      const link = [...document.querySelectorAll('a[href*="/watch?"]')].find((el) => new URL(el.href).searchParams.get('v') === id);
      return link && link.getBoundingClientRect().height > 0;
    }), memberIds);
    // Concurrent messages must merge without losing a different channel or
    // duplicating the same one. Editing exceptions must not enable the filter.
    const concurrent = await options.evaluate(async (id) => Promise.all([
      chrome.runtime.sendMessage({ type: 'SYF_ADD_MEMBER_EXCEPTION', input: '@SwitchandClickOfficial' }),
      chrome.runtime.sendMessage({ type: 'SYF_ADD_MEMBER_EXCEPTION', input: id }),
      chrome.runtime.sendMessage({ type: 'SYF_ADD_MEMBER_EXCEPTION', input: '@YouTube' }),
    ]), allowedChannelId);
    assert.ok(concurrent.every((result) => result.ok), 'concurrent channel lookup failed');
    assert.equal(await list().count(), 2);
    await assertChecked(options, false);
    const afterSettings = await options.evaluate(async (key) => (await chrome.storage.local.get(key))[key], SETTINGS_KEY);
    for (const key of Object.keys(originalSettings || {}).filter((key) => !['hideMembersOnly', 'membersOnlyChannelExceptions'].includes(key))) {
      assert.ok(JSON.stringify(afterSettings[key]) === JSON.stringify(originalSettings[key]), `unrelated setting changed: ${key}`);
    }
    console.log(JSON.stringify({ ok: true, signedIn, realMemberCards: memberIds.length,
      realPublicCards: publicIds.length, publicVisible, filtered, exempted, removed, restored,
      concurrentExceptions: 2 }, null, 2));
  } finally {
    if (settingsRead && options && !options.isClosed()) {
      await options.evaluate(async ({ key, settings }) => {
        await chrome.runtime.sendMessage({ type: 'SYF_PATCH_SETTINGS', patch: {
          hideMembersOnly: !!settings?.hideMembersOnly,
          membersOnlyChannelExceptions: settings?.membersOnlyChannelExceptions || [],
          hideShorts: !!settings?.hideShorts,
        } });
        if (settings === undefined) await chrome.storage.local.remove(key);
        else await chrome.storage.local.set({ [key]: settings });
      }, { key: SETTINGS_KEY, settings: originalSettings });
    }
    await page?.close();
    await extraPage?.close();
    await options?.close();
    await browser.close(); // CDP disconnect; do not close the user's browser.
  }
}

async function assertChecked(page, checked) {
  await page.waitForFunction((value) => document.querySelector('#hideMembersOnly')?.checked === value, checked);
}
