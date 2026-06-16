import { test as base, chromium, type BrowserContext } from '@playwright/test';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';

// Chrome 149 blocks --load-extension, so we attach to a real Chrome (dedicated
// dev profile, with the extension UI-loaded once) over the CDP port instead.
const CHROME =
  process.env.SYF_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE = process.env.SYF_PROFILE || path.resolve(process.cwd(), '.test-profile');
const PORT = Number(process.env.SYF_CDP_PORT || 9222);
const EXT_NAME = "Seth's YouTube Fixer";

function reachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/json/version' }, (r) => {
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

async function ensureChrome(): Promise<void> {
  if (await reachable()) return;
  const child = spawn(
    CHROME,
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
    if (await reachable()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Chrome did not expose CDP on port ${PORT}`);
}

export const test = base.extend<{ context: BrowserContext; extensionId: string }>({
  context: async ({}, use) => {
    await ensureChrome();
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    await use(browser.contexts()[0]);
    await browser.close(); // disconnect; leaves the dev Chrome running
  },
  extensionId: async ({ context }, use) => {
    const page = await context.newPage();
    await page.goto('chrome://extensions');
    await page.waitForTimeout(400);
    const id = await page.evaluate((NAME) => {
      const mgr = document.querySelector('extensions-manager') as any;
      const lists = mgr?.shadowRoot?.querySelectorAll('extensions-item-list') || [];
      for (const l of lists)
        for (const it of (l as any).shadowRoot?.querySelectorAll('extensions-item') || []) {
          const nm = it.shadowRoot?.querySelector('#name')?.textContent?.trim();
          if (nm === NAME) return it.id || it.getAttribute('id') || '';
        }
      return '';
    }, EXT_NAME);
    await page.close();
    if (!id) {
      throw new Error(`${EXT_NAME} is not loaded — run \`npm run setup\` and Load unpacked dist/ once.`);
    }
    await use(id);
  },
});

export const expect = test.expect;
