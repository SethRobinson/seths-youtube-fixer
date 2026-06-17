// Build script for Seth's YouTube Fixer.
// Bundles each TS entry point to dist/ as a standalone IIFE and copies static assets.
import esbuild from 'esbuild';
import { rm, mkdir, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const outDir = path.join(root, 'dist');
const watch = process.argv.includes('--watch');

const entryPoints = {
  'background/service-worker': 'src/background/service-worker.ts',
  'content/youtube': 'src/content/youtube.ts',
  'content/myactivity': 'src/content/myactivity.ts',
  'content/page-bridge': 'src/content/page-bridge.ts',
  'content/embed': 'src/content/embed.ts',
  'options/options': 'src/options/options.ts',
  'popup/popup': 'src/popup/popup.ts',
  'wipe/wipe': 'src/wipe/wipe.ts',
  'comments/search': 'src/comments/search.ts',
};

const staticFiles = [
  ['src/manifest.json', 'manifest.json'],
  ['src/content/styles.css', 'content/styles.css'],
  ['src/options/options.html', 'options/options.html'],
  ['src/popup/popup.html', 'popup/popup.html'],
  ['src/wipe/wipe.html', 'wipe/wipe.html'],
  ['src/comments/search.html', 'comments/search.html'],
  ['src/rules/iframe-rules.json', 'rules/iframe-rules.json'],
];

async function copyStatic() {
  for (const [from, to] of staticFiles) {
    const dest = path.join(outDir, to);
    await mkdir(path.dirname(dest), { recursive: true });
    await cp(path.join(root, from), dest);
  }
  const iconsSrc = path.join(root, 'src', 'icons');
  if (existsSync(iconsSrc)) {
    await cp(iconsSrc, path.join(outDir, 'icons'), { recursive: true });
  }
}

const buildOpts = {
  entryPoints: Object.fromEntries(
    Object.entries(entryPoints).map(([k, v]) => [k, path.join(root, v)])
  ),
  outdir: outDir,
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  // Ship no sourcemaps in a release build (smaller package, original TS not exposed);
  // keep them for dev. build_release.bat sets SYF_RELEASE=1. Code is left
  // unminified so the published package stays easy to review.
  sourcemap: process.env.SYF_RELEASE === '1' ? false : true,
  logLevel: 'info',
  // Dev-only read hook (window.__syfDebug, a token-index peek for tests) is compiled out
  // unless SYF_DEV=1, so it never ships in normal builds. (The old __syfSubmitFeedback
  // account-write hook was removed — feedback submission now lives in the isolated world.)
  define: { __SYF_DEV__: process.env.SYF_DEV === '1' ? 'true' : 'false' },
};

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

if (watch) {
  const ctx = await esbuild.context(buildOpts);
  await ctx.watch();
  await copyStatic();
  setInterval(copyStatic, 1000);
  console.log('[build] watching for changes…');
} else {
  await esbuild.build(buildOpts);
  await copyStatic();
  console.log('[build] done →', outDir);
}
