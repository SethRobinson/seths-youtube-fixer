// Build script for Seth's YouTube Fixer.
// Bundles each TS entry point to dist/ as a standalone IIFE and copies static assets.
import esbuild from 'esbuild';
import { rm, mkdir, cp, readFile, writeFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { extensionManifest } from './build-platform.mjs';

const root = process.cwd();
const safari = process.argv.includes('--safari');
const outDir = path.join(root, safari ? 'dist-safari' : 'dist');
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
if (safari) delete entryPoints['content/embed'];

const staticFiles = [
  ['src/content/styles.css', 'content/styles.css'],
  ['src/options/options.html', 'options/options.html'],
  ['src/popup/popup.html', 'popup/popup.html'],
  ['src/wipe/wipe.html', 'wipe/wipe.html'],
  ['src/comments/search.html', 'comments/search.html'],
  ['src/rules/iframe-rules.json', 'rules/iframe-rules.json'],
];

async function copyStatic() {
  const manifest = extensionManifest(JSON.parse(await readFile(path.join(root, 'src/manifest.json'), 'utf8')), safari);
  await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  for (const [from, to] of staticFiles) {
    if (safari && to.startsWith('rules/')) continue;
    const dest = path.join(outDir, to);
    await mkdir(path.dirname(dest), { recursive: true });
    await cp(path.join(root, from), dest);
    if (safari && to === 'content/styles.css') {
      await appendFile(dest, '\n' + await readFile(path.join(root, 'src/content/safari-theme.css'), 'utf8'));
    }
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
  target: safari ? 'safari18' : 'chrome120',
  // Ship no sourcemaps in a release build (smaller package, original TS not exposed);
  // keep them for dev. build_release.bat sets SYF_RELEASE=1. Code is left
  // unminified so the published package stays easy to review.
  sourcemap: process.env.SYF_RELEASE === '1' ? false : true,
  logLevel: 'info',
  // Dev-only read hook (window.__syfDebug, a token-index peek for tests) is compiled out
  // unless SYF_DEV=1, so it never ships in normal builds. (The old __syfSubmitFeedback
  // account-write hook was removed — feedback submission now lives in the isolated world.)
  define: { __SYF_DEV__: process.env.SYF_DEV === '1' ? 'true' : 'false', __SYF_SAFARI__: String(safari) },
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
