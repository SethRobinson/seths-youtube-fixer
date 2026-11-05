// Offline DOM and extension-runtime tests. Never launch/control a browser or device.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { build } from 'esbuild';
import { parseHTML } from 'linkedom';
import { extensionManifest } from './build-platform.mjs';

async function compile(entry, safari = true, format = 'iife') {
  const result = await build({ entryPoints: [entry], bundle: true, write: false, format,
    platform: 'browser', define: { __SYF_SAFARI__: String(safari), __SYF_DEV__: 'false' }, logLevel: 'silent' });
  return result.outputFiles[0].text;
}
async function module(entry) {
  return import(`data:text/javascript;base64,${Buffer.from(await compile(entry, true, 'esm')).toString('base64')}`);
}
const platform = await module('src/common/platform.ts');
const pages = await module('src/common/youtube-page.ts');
const members = await module('src/common/members-only.ts');
const review = await module('src/wipe/activity-review.ts');
const background = await compile('src/background/service-worker.ts');
const bridge = await compile('src/content/page-bridge.ts');

test('browser manifests retain shared assets and isolate Safari tab behavior', async () => {
  const base = JSON.parse(await readFile('src/manifest.json', 'utf8'));
  const original = JSON.stringify(base);
  for (const safari of [true, false]) {
    const output = extensionManifest(base, safari);
    for (const script of output.content_scripts.filter((entry) => entry.matches.includes('https://www.youtube.com/*'))) {
      assert.ok(script.matches.includes('https://m.youtube.com/*'));
    }
    assert.equal(output.content_scripts.some((entry) => entry.js.includes('content/embed.js')), !safari);
    assert.equal(!!output.declarative_net_request, !safari);
    assert.ok(output.permissions.includes('unlimitedStorage'));
  }
  assert.equal(JSON.stringify(base), original);
});

test('authentication origin accepts only HTTPS desktop/mobile YouTube', () => {
  assert.equal(platform.youtubeOrigin('https://m.youtube.com/watch?v=abcdefghijk'), 'https://m.youtube.com');
  assert.equal(platform.youtubeOrigin('https://www.youtube.com/'), 'https://www.youtube.com');
  for (const url of ['http://m.youtube.com/', 'https://m.youtube.com.evil.test/', 'https://evil.test/', 'invalid']) {
    assert.throws(() => platform.youtubeOrigin(url));
  }
});

test('layout adapters select actual DOM and do not reuse mobile boot data after navigation', () => {
  const { document } = parseHTML('<html><body><ytm-app><ytm-slim-video-metadata-section-renderer></ytm-slim-video-metadata-section-renderer></ytm-app></body></html>');
  globalThis.document = document;
  globalThis.location = { pathname: '/watch', search: '?v=abcdefghijk' };
  globalThis.window = { ytInitialData: { marker: 'boot' } };
  assert.equal(pages.isMobileYouTube(), true);
  assert.equal(pages.watchMount().localName, 'ytm-slim-video-metadata-section-renderer');
  assert.equal(pages.pageRoots('/watch?v=abcdefghijk')[0].marker, 'boot');
  location.search = '?v=01234567890';
  assert.deepEqual(pages.pageRoots('/watch?v=abcdefghijk'), []);
  document.querySelector('ytm-app').data = { marker: 'live' };
  assert.equal(pages.pageRoots('/watch?v=abcdefghijk')[0].marker, 'live');
  document.body.innerHTML = '<ytd-watch-flexy></ytd-watch-flexy><ytd-watch-metadata></ytd-watch-metadata>';
  document.querySelector('ytd-watch-flexy').data = { marker: 'desktop' };
  assert.equal(pages.isMobileYouTube(), false);
  assert.equal(pages.watchMount().localName, 'ytd-watch-metadata');
  assert.equal(pages.pageRoots('/')[0].marker, 'desktop');
});

test('mobile membership filtering collapses cards and preserves manual exceptions', () => {
  const id = 'abcdefghijk', owner = 'UCabcdefghijklmnopqrstuv';
  const card = { videoWithContextRenderer: { videoId: id, badges: [{ metadataBadgeRenderer: { style: 'BADGE_STYLE_TYPE_MEMBERS_ONLY' } }],
    shortBylineText: { runs: [{ navigationEndpoint: { browseEndpoint: { browseId: owner } } }] } } };
  const state = members.memberVideoState(card);
  assert.equal(state.membersOnly, true);
  assert.equal(state.channelId, owner);
  const { document } = parseHTML(`<html class="syf-hide-members-only"><body><ytm-rich-item-renderer><ytm-video-with-context-renderer><a href="/watch?v=${id}">Video</a></ytm-video-with-context-renderer></ytm-rich-item-renderer></body></html>`);
  const selector = members.membersOnlyCss([state]).split(' {')[0];
  assert.equal(document.querySelectorAll(selector).length, 2);
  assert.equal(document.querySelectorAll(members.membersOnlyCss([state], [owner]).split(' {')[0]).length, 0);
});

function backgroundRuntime() {
  let listener;
  const values = {};
  const tabs = [];
  const event = { addListener() {}, removeListener() {} };
  const chrome = {
    runtime: { id: 'test-extension', getURL: (path) => `safari-web-extension://test/${path}`,
      onInstalled: event, onStartup: event, onMessage: { addListener(fn) { listener = fn; } } },
    storage: { local: {
      async get(key) { return structuredClone({ [key]: values[key] }); },
      async set(data) { await Promise.resolve(); Object.assign(values, structuredClone(data)); },
      async getBytesInUse() { return 100; }, async remove(keys) { for (const key of keys) delete values[key]; },
    } },
    tabs: { onRemoved: event, onUpdated: event, async query() { return []; },
      async create(options) { tabs.push(options); return { id: tabs.length }; } },
  };
  vm.runInNewContext(background, { chrome, console, URL, URLSearchParams, crypto: webcrypto, structuredClone,
    setTimeout, clearTimeout, setInterval, clearInterval, fetch: () => { throw Error('Unexpected network access'); } });
  return { values, tabs, async send(message) {
    return Promise.race([new Promise((resolve) => listener(message, { id: chrome.runtime.id }, resolve)),
      new Promise((_, reject) => { const t = setTimeout(() => reject(Error('No response')), 2000); t.unref(); })]);
  } };
}

test('Safari worker starts without windows, DNR or onSuspend and persists before acknowledging', async () => {
  const runtime = backgroundRuntime();
  assert.equal((await runtime.send({ type: 'SYF_PATCH_SETTINGS', patch: { hideShorts: true } })).ok, true);
  assert.equal(runtime.values['syf.settings'].hideShorts, true);
  await runtime.send({ type: 'SYF_CAPTURE', items: [{ videoId: 'abcdefghijk', notInterestedToken: 'fixture-token' }] });
  assert.ok(runtime.values['syf.feedback'].videos.abcdefghijk);
  const logged = await runtime.send({ type: 'SYF_LOG_ACTION', entry: { type: 'notInterested', source: 'app', videoId: 'abcdefghijk' } });
  assert.equal(runtime.values['syf.actionlog'][0].id, logged.id);
  await runtime.send({ type: 'SYF_MARK_UNDONE', id: logged.id });
  assert.equal(runtime.values['syf.actionlog'][0].undone, true);
  await runtime.send({ type: 'SYF_OPEN_COMMENT_SEARCH', videoId: 'abcdefghijk' });
  assert.ok(runtime.tabs[0].url.includes('/comments/search.html?'));
});

test('Safari Forget recent opens a foreground tab routed to the selected Brand account', async () => {
  const runtime = backgroundRuntime();
  await runtime.send({ type: 'SYF_OPEN_PAGE', page: 'wipe', minutes: 30, authUser: '2', pageId: '12345' });
  const url = new URL(runtime.tabs[0].url);
  assert.equal(url.pathname, '/b/12345/product/youtube');
  assert.equal(url.searchParams.get('authuser'), '2');
  assert.equal(url.hash, '#syf-forget=30');
  assert.equal(runtime.tabs[0].active, true);
});

test('mobile bridge observes fetch and XHR feedback data without initiating requests', async () => {
  const { document } = parseHTML('<html><body><ytm-app></ytm-app></body></html>');
  const messages = [], listeners = {};
  const card = (id) => ({ videoWithContextRenderer: { videoId: id, menu: { menuRenderer: { items: [
    { menuServiceItemRenderer: { icon: { iconType: 'HIDE' }, serviceEndpoint: { feedbackEndpoint: { feedbackToken: 'captured-only' } } } },
  ] } } } });
  const window = { ytInitialData: card('abcdefghijk'), postMessage: (m) => messages.push(m),
    addEventListener: (name, fn) => { listeners[name] = fn; },
    fetch: async () => ({ clone: () => ({ text: async () => JSON.stringify(card('01234567890')) }) }),
  };
  class XHR {
    open() {} send() {} addEventListener(name, fn) { this[name] = fn; }
  }
  const location = { pathname: '/', search: '', origin: 'https://m.youtube.com' };
  vm.runInNewContext(bridge, { document, window, location, URL, URLSearchParams, XMLHttpRequest: XHR, console,
    setInterval: () => 1, clearInterval() {} });
  assert.ok(messages.some((m) => m.type === 'CAPTURE' && m.items[0].videoId === 'abcdefghijk'));
  await window.fetch('/youtubei/v1/next');
  await new Promise((r) => setImmediate(r));
  assert.ok(messages.some((m) => m.type === 'CAPTURE' && m.items[0].videoId === '01234567890'));
  const xhr = new XHR(); xhr.open('POST', '/youtubei/v1/browse'); xhr.send('{}');
  xhr.responseType = 'json'; xhr.response = card('newvideo001'); xhr.load();
  assert.ok(messages.some((m) => m.type === 'CAPTURE' && m.items[0].videoId === 'newvideo001'));
  assert.ok(!('__syfSubmitFeedback' in window));
  xhr.open('GET', '/watch?v=pbjvideo001&pbj=1'); xhr.send();
  xhr.responseType = ''; xhr.responseText = ")]}'\n" + JSON.stringify([{ response: card('pbjvideo001') }]); xhr.load();
  assert.ok(messages.some((m) => m.type === 'CAPTURE' && m.items[0].videoId === 'pbjvideo001'));
});

test('mobile navigation response hooks accept PBJ but exclude unrelated responses', () => {
  const base = 'https://m.youtube.com/';
  assert.ok(pages.isYouTubeDataRequest('/watch?v=abcdefghijk&pbj=1', base));
  assert.ok(pages.isYouTubeDataRequest('/youtubei/v1/player?key=public', base));
  assert.equal(pages.isYouTubeDataRequest('https://evil.test/watch?pbj=1', base), false);
  assert.equal(pages.isYouTubeDataRequest('/watch?v=abcdefghijk', base), false);
  assert.deepEqual(pages.parseYouTubeResponse(")]}'\n[{}]"), [{}]);
});

test('foreground history review deletes only the reviewed tokens and stops on failure', async () => {
  const { document, window } = parseHTML('<html><body></body></html>');
  globalThis.document = document;
  globalThis.location = { pathname: '/product/youtube', search: '' };
  let shadow;
  const attach = window.HTMLElement.prototype.attachShadow;
  window.HTMLElement.prototype.attachShadow = function (options) { shadow = attach.call(this, options); return shadow; };
  const rows = [{ title: '<img onerror=bad()>', timeText: 'now', ms: Date.now(), token: 'one' }];
  const deleted = [];
  review.mountActivityReview(() => rows, async (token) => { deleted.push(token); return false; }, 15);
  assert.deepEqual(deleted, []);
  shadow.querySelector('#scan').click();
  assert.equal(shadow.querySelector('li').textContent, 'now — <img onerror=bad()>');
  assert.equal(shadow.querySelector('img'), null);
  rows.push({ title: 'arrived after review', timeText: 'now', ms: Date.now(), token: 'two' });
  await shadow.querySelector('#delete').onclick();
  assert.deepEqual(deleted, ['one']);
  assert.equal(shadow.querySelector('#delete').hidden, true);
  assert.equal(shadow.querySelector('#scan').disabled, true);
});

test('phone toolbar opens settings in a tab and submits/undoes only through isolated code', async () => {
  const code = await compile('src/content/youtube.ts');
  const { document } = parseHTML('<html><body><ytm-app><ytm-slim-video-metadata-renderer></ytm-slim-video-metadata-renderer></ytm-app></body></html>');
  document.cookie = 'SAPISID=fixture-cookie';
  const frames = [], requests = [], sent = [], listeners = {};
  let active = false;
  const location = new URL('https://m.youtube.com/watch?v=abcdefghijk');
  const window = { addEventListener: (name, fn) => { listeners[name] = fn; }, postMessage() {} };
  const chrome = {
    storage: { local: { get: async () => ({}) }, onChanged: { addListener() {} } },
    runtime: { id: 'test', onMessage: { addListener() {} }, getURL: (path) => `safari-web-extension://test/${path}`,
      async sendMessage(message) {
        sent.push(message);
        if (message.type === 'SYF_LOG_ACTION') { active = true; return { ok: true, id: 'logged' }; }
        if (message.type === 'SYF_MARK_UNDONE') { active = false; return { ok: true }; }
        if (message.type === 'SYF_LOOKUP') return { ok: true, nahToken: 'captured', nahUndoToken: 'undo-captured',
          nahActive: active ? { id: 'logged', undoToken: 'undo-captured' } : undefined };
        return { ok: true };
      } },
  };
  vm.runInNewContext(code, { document, window, location, chrome, URL, URLSearchParams,
    crypto: webcrypto, TextEncoder, console: { log() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: (fn) => frames.push(fn), setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    fetch: async (url, init) => { requests.push({ url, init }); return { ok: true, status: 200, json: async () => ({ feedbackResponses: [{ isProcessed: true }] }) }; },
  });
  const settle = async () => { for (let i = 0; i < 12; i++) { while (frames.length) frames.shift()(); await new Promise(setImmediate); } };
  await settle();
  assert.equal(document.querySelectorAll('#syf-bar').length, 1);
  assert.equal(document.querySelectorAll('.syf-more-actions button').length, 5);
  document.querySelector('[data-action="info"]').click();
  assert.ok(sent.some((message) => message.type === 'SYF_OPEN_OPTIONS'));
  assert.equal(document.querySelector('iframe'), null);
  listeners.message({ source: window, data: { __syf: true, dir: 'from-page', type: 'YT_CONFIG',
    apiKey: 'public-key', context: { client: { clientName: 'MWEB' } }, clientName: 2, clientVersion: 'test', authUser: '2' } });
  assert.equal(requests.length, 0, 'page messages cannot trigger an authenticated write');
  document.querySelector('[data-action="nah"]').click();
  await settle();
  assert.equal(requests.length, 1);
  assert.ok(requests[0].url.startsWith('https://m.youtube.com/youtubei/'));
  assert.equal(requests[0].init.headers['X-Origin'], 'https://m.youtube.com');
  assert.equal(requests[0].init.headers['X-Goog-AuthUser'], '2');
  assert.equal(JSON.parse(requests[0].init.body).feedbackTokens[0], 'captured');
  assert.equal(document.querySelector('[data-action="nah"]').dataset.state, 'sent');
  document.querySelector('[data-action="nah"]').click();
  await settle();
  assert.equal(requests.length, 2);
  assert.equal(JSON.parse(requests[1].init.body).feedbackTokens[0], 'undo-captured');
  assert.equal(document.querySelector('[data-action="nah"]').dataset.state, 'ready');
  document.cookie = '';
  document.querySelector('[data-action="nah"]').click();
  await settle();
  assert.equal(requests.length, 2, 'signed-out pages cannot submit previously cached feedback');
});

test('Safari comment matches reuse a YouTube tab without losing the cached search', async () => {
  const code = await compile('src/comments/search.ts');
  const { document } = parseHTML(await readFile('src/comments/search.html', 'utf8'));
  const created = [], updated = [];
  let apiCalls = 0;
  const chrome = {
    storage: { local: { get: async () => ({}) } },
    runtime: { async sendMessage(message) {
      if (message.type === 'SYF_COMMENTS_PAGE') {
        apiCalls++;
        return { ok: true, threads: [{ top: { id: 'comment-id', text: 'A wonderful example', author: 'Viewer', publishedAt: new Date().toISOString(), likeCount: 1 }, replies: [], totalReplyCount: 0 }] };
      }
      return { ok: true, used: 1, limit: 10000 };
    } },
    tabs: { async create(options) { created.push(options); return { id: 17 }; }, async update(id, options) { updated.push({ id, ...options }); } },
  };
  vm.runInNewContext(code, { document, window: { addEventListener() {} }, chrome, URLSearchParams,
    location: { search: '?v=abcdefghijk' }, console });
  await new Promise(setImmediate);
  document.querySelector('#cs-q').value = 'wonderful';
  document.querySelector('#cs-go').click();
  await new Promise(setImmediate);
  assert.equal(document.querySelectorAll('.cs-row').length, 1);
  document.querySelector('.cs-row').click();
  await new Promise(setImmediate);
  assert.ok(created[0].url.includes('&lc=comment-id'));
  assert.equal(document.querySelector('#cs-frame').getAttribute('src'), null);
  document.querySelector('.cs-row').click();
  await new Promise(setImmediate);
  assert.equal(created.length, 1);
  assert.equal(updated[0].id, 17);
  document.querySelector('#cs-q').value = 'example';
  document.querySelector('#cs-go').click();
  await new Promise(setImmediate);
  assert.equal(apiCalls, 1);
  assert.equal(document.querySelectorAll('.cs-row').length, 1);
});

test('foreground history deletion stops after backgrounding and rejects changed account routes', async () => {
  const { document, window } = parseHTML('<html><body></body></html>');
  globalThis.document = document;
  globalThis.location = { pathname: '/b/12345/product/youtube', search: '?authuser=1' };
  let shadow;
  const attach = window.HTMLElement.prototype.attachShadow;
  window.HTMLElement.prototype.attachShadow = function (options) { shadow = attach.call(this, options); return shadow; };
  const rows = ['one', 'two'].map((token) => ({ title: token, timeText: 'now', ms: Date.now(), token }));
  const deleted = [];
  review.mountActivityReview(() => rows, async (token) => {
    deleted.push(token);
    document.hidden = true;
    document.dispatchEvent(new window.Event('visibilitychange'));
    return true;
  }, 15);
  shadow.querySelector('#scan').click();
  await shadow.querySelector('#delete').onclick();
  assert.deepEqual(deleted, ['one']);
  assert.equal(shadow.querySelectorAll('li').length, 1);
  document.hidden = false;
  location.search = '?authuser=2';
  await shadow.querySelector('#delete').onclick();
  assert.deepEqual(deleted, ['one']);
  assert.equal(shadow.querySelector('#delete').hidden, true);
});
