// Ground-truth diagnostic against REAL Chrome: what flags actually applied, and
// did our extension load? Reads chrome://version + chrome://extensions.
import { chromium } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const dist = path.join(process.cwd(), 'dist');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syf-diag-'));

const context = await chromium.launchPersistentContext(dir, {
  channel: process.env.SYF_CHANNEL || 'chrome',
  headless: false,
  viewport: null,
  args: [
    `--disable-extensions-except=${dist}`,
    `--load-extension=${dist}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
  ],
});

const p = context.pages()[0] ?? (await context.newPage());

await p.goto('chrome://version');
const v = await p.evaluate(() => ({
  version: document.getElementById('version')?.textContent?.trim(),
  exe: document.getElementById('executable_path')?.textContent?.trim(),
  profile: document.getElementById('profile_path')?.textContent?.trim(),
  cmd: document.getElementById('command_line')?.textContent?.trim(),
}));
console.log('VERSION :', v.version);
console.log('EXE     :', v.exe);
console.log('PROFILE :', v.profile);
console.log('CMDLINE :', v.cmd);
console.log('SWs     :', context.serviceWorkers().map((s) => s.url()));

await p.goto('chrome://extensions');
await new Promise((r) => setTimeout(r, 1500));
await p.screenshot({ path: 'test-results/chrome-extensions.png' });

const exts = await p
  .evaluate(() => {
    const out = [];
    const mgr = document.querySelector('extensions-manager');
    const lists = mgr?.shadowRoot?.querySelectorAll('extensions-item-list') || [];
    for (const list of lists) {
      const items = list.shadowRoot?.querySelectorAll('extensions-item') || [];
      for (const it of items) {
        out.push(it.shadowRoot?.querySelector('#name')?.textContent?.trim() || '(unnamed)');
      }
    }
    return out;
  })
  .catch((e) => ['evalfail:' + e.message]);
console.log('EXTENSIONS LISTED:', exts);

await context.close();
fs.rmSync(dir, { recursive: true, force: true });
