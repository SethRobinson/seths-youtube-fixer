import { defineConfig } from '@playwright/test';

// Extensions require a headed, persistent context, so tests run single-worker.
export default defineConfig({
  testDir: 'test',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  outputDir: 'test-results',
});
