// Shared helpers for driving the dedicated test Chrome via CDP.
//
// Chrome 149 hard-blocks the --load-extension command-line switch, so we can't
// load the unpacked extension that way. Instead we run a persistent dev profile
// (.test-profile) into which the extension is loaded ONCE via the chrome://extensions
// UI; it then auto-loads from dist/ on every launch. We spawn that Chrome ourselves
// (no automation flags) with a remote-debugging port and attach with connectOverCDP.
import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';
import http from 'node:http';
import path from 'node:path';

export const CHROME_PATH =
  process.env.SYF_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
export const PROFILE = process.env.SYF_PROFILE || path.resolve(process.cwd(), '.test-profile');
export const PORT = Number(process.env.SYF_CDP_PORT || 9222);
export const EXT_NAME = "Seth's YouTube Fixer";

export function cdpReachable(port = PORT) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/json/version' }, (r) => {
      resolve(r.statusCode === 200);
      r.resume();
    });
    req.on('error', () => resolve(false));
    req.setTimeout(800, () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** Ensure a dev Chrome is running on the CDP port. Returns true if we spawned it. */
export async function ensureChrome() {
  if (await cdpReachable()) return false;
  const child = spawn(
    CHROME_PATH,
    [
      `--user-data-dir=${PROFILE}`,
      `--remote-debugging-port=${PORT}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--restore-last-session=false',
      '--hide-crash-restore-bubble',
    ],
    { stdio: 'ignore', detached: true }
  );
  child.unref();
  for (let i = 0; i < 60; i++) {
    if (await cdpReachable()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Chrome did not expose CDP on port ${PORT}`);
}

export async function connect() {
  await ensureChrome();
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  return { browser, context: browser.contexts()[0] };
}

/** Read our extension's id from chrome://extensions (works even if the SW is asleep). */
export async function findExtensionId(context) {
  const page = await context.newPage();
  try {
    await page.goto('chrome://extensions');
    await page.waitForTimeout(400);
    return await page.evaluate((NAME) => {
      const mgr = document.querySelector('extensions-manager');
      const lists = mgr?.shadowRoot?.querySelectorAll('extensions-item-list') || [];
      for (const l of lists)
        for (const it of l.shadowRoot?.querySelectorAll('extensions-item') || []) {
          const nm = it.shadowRoot?.querySelector('#name')?.textContent?.trim();
          if (nm === NAME) return it.id || it.getAttribute('id') || '';
        }
      return '';
    }, EXT_NAME);
  } finally {
    await page.close();
  }
}

/** Reload the extension after a rebuild (SW reload if awake, else chrome://extensions button). */
export async function reloadExtension(context) {
  const isExt = (s) => s.url().startsWith('chrome-extension://');
  for (const sw of context.serviceWorkers().filter(isExt)) {
    const name = await sw.evaluate(() => chrome.runtime.getManifest().name).catch(() => '');
    if (name === EXT_NAME) {
      await sw.evaluate(() => chrome.runtime.reload()).catch(() => {});
      return true;
    }
  }
  const page = await context.newPage();
  try {
    await page.goto('chrome://extensions');
    await page.waitForTimeout(300);
    return await page.evaluate((NAME) => {
      const mgr = document.querySelector('extensions-manager');
      const lists = mgr?.shadowRoot?.querySelectorAll('extensions-item-list') || [];
      for (const l of lists)
        for (const it of l.shadowRoot?.querySelectorAll('extensions-item') || []) {
          const nm = it.shadowRoot?.querySelector('#name')?.textContent?.trim();
          if (nm === NAME) {
            it.shadowRoot?.querySelector('#dev-reload-button')?.click();
            return true;
          }
        }
      return false;
    }, EXT_NAME);
  } finally {
    await page.close();
  }
}
