import { test, expect } from '@playwright/test';
import path from 'node:path';
import { executablePath } from '../../playwright.config.js';
import { FIX, EVN, openApp, product } from './helpers.js';

const cam = (file) => ({
  launchOptions: {
    executablePath,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${path.join(FIX, file)}`],
  },
});

test.use(cam('steady.y4m'));

test.describe('camera, barcode held still', () => {
  test('counts the item once while it stays in view and reads the new label', async ({ page }) => {
    await openApp(page);
    await page.click('#camStart');
    const line = page.locator(`.line[data-ean="${EVN}"]`);
    await expect(line).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(`#q-${EVN}`)).toHaveValue('1');
    await page.waitForTimeout(3000);
    await expect(page.locator(`#q-${EVN}`)).toHaveValue('1');
    // Unknown barcode: a frame was captured and the label text read on the device.
    await expect.poll(async () => (await product(page, EVN))?.status).toBe('ocr');
    const p = await product(page, EVN);
    expect(p.hasImage).toBe(true);
    expect(p.model).toBe('SLK24018');
    expect(p.maker).toBe('EVN-Lichttechnik GmbH');
    await expect(line).toContainText('LED Netzgerät');
    await page.click('#camStop');
    await expect(page.locator('#camIdle')).toBeVisible();
  });
});
