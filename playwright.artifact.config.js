import { defineConfig } from '@playwright/test';

// Browser tests for the claude.ai build (dist-artifact), with a stand-in for claude.ai's runtime.
export default defineConfig({
  testDir: 'tests/e2e-artifact',
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
  globalSetup: './tests/e2e/global-setup.js',
  use: {
    baseURL: 'http://localhost:4174',
    viewport: { width: 390, height: 844 },
    launchOptions: { executablePath: process.env.CHROMIUM_PATH || undefined },
  },
  webServer: { command: 'npm run build:artifact && npx vite preview --mode artifact --outDir dist-artifact --port 4174 --strictPort', url: 'http://localhost:4174', reuseExistingServer: !process.env.CI, timeout: 120_000 },
});
