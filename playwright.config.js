import { defineConfig } from '@playwright/test';

// CHROMIUM_PATH lets the tests use a preinstalled Chromium instead of downloading one.
export const executablePath = process.env.CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  globalSetup: './tests/e2e/global-setup.js',
  use: {
    baseURL: 'http://localhost:4173',
    viewport: { width: 390, height: 844 },
    permissions: ['camera'],
    launchOptions: { executablePath },
  },
  webServer: { command: 'npm run build && npm run preview', url: 'http://localhost:4173', reuseExistingServer: !process.env.CI, timeout: 120_000 },
});
