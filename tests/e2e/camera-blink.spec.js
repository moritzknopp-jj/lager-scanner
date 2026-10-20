import { test, expect } from '@playwright/test';
import path from 'node:path';
import { executablePath } from '../../playwright.config.js';
import { FIX, EVN, openApp } from './helpers.js';

const cam = (file) => ({
  launchOptions: {
    executablePath,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${path.join(FIX, file)}`],
  },
});

test.use(cam('blink.y4m'));

test.describe('camera, items brought in one after another', () => {
  test('counts each time the barcode comes back into view', async ({ page }) => {
    await openApp(page);
    await page.click('#camStart');
    await expect(page.locator(`#q-${EVN}`)).toHaveValue('1', { timeout: 15_000 });
    const t0 = Date.now();
    await expect.poll(async () => Number(await page.locator(`#q-${EVN}`).inputValue()), { timeout: 15_000 }).toBeGreaterThanOrEqual(4);
    const elapsed = (Date.now() - t0) / 1000;
    const n = Number(await page.locator(`#q-${EVN}`).inputValue());
    // The video cycle is 2.5 s (1 s in view, 1.5 s away): never more than one count per cycle.
    expect(n).toBeLessThanOrEqual(Math.ceil(elapsed / 2.5) + 2);
  });
});
