import { test, expect } from '@playwright/test';
import { executablePath } from '../../playwright.config.js';
import { openApp, product, ean13 } from './helpers.js';

// Real Tesseract in the browser (downloads its language data from the CDN on first use).
const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } : undefined;
test.use({ launchOptions: { executablePath, proxy }, ignoreHTTPSErrors: !!proxy });

test('reads a printed label on the device', async ({ page }) => {
  test.setTimeout(180_000);
  await openApp(page, { ocr: 'real' });
  const code = ean13('402000000001');
  await page.evaluate(async (c) => {
    const cv = document.createElement('canvas'); cv.width = 1200; cv.height = 600;
    const g = cv.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
    g.fillStyle = '#000'; g.font = 'bold 64px Arial'; g.fillText('SLK24018', 40, 100);
    g.font = '44px Arial';
    g.fillText('LED Netzgerät 24V/DC 0,1-18W IP20', 40, 190);
    g.fillText('Pri. 220-240V/AC 50/60Hz', 40, 260);
    g.fillText('EVN-Lichttechnik GmbH', 40, 360);
    g.fillText('Zum Lichtblick 1-12', 40, 420);
    g.fillText('90610 Winkelhaid', 40, 480);
    const blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.9));
    await window.__lager.handleCode(c, 'photo', blob);
  }, code);
  await expect.poll(async () => (await product(page, code))?.status, { timeout: 150_000 }).toBe('ocr');
  const p = await product(page, code);
  expect(p.model).toBe('SLK24018');
  expect(p.maker).toMatch(/EVN-Lichttechnik GmbH/);
  expect(p.name).toMatch(/Netzger/);
});
