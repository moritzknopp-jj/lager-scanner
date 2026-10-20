import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '.fixtures');
export const EVN = '4037293393362';

export const EVN_OCR = `SLK24018 To; 2 ;
LED Netzgerät 24V/DC = 0,1-18W = [P20 EM Z 0]
Pri. 220-240V/AC | 50/60Hz
EVN-Lichttechnik GmbH
Zum Lichtblick 1-12
90610 Winkelhaid
www.evn-lichttechnik.com 4 037293 393362`;

// Opens the app on a fresh, empty database. ocr: 'good' | 'bad' | 'real'.
export async function openApp(page, { ocr = 'good' } = {}) {
  if (ocr !== 'real') {
    await page.addInitScript(([mode, text]) => {
      window.__lagerTestOcr = async () => (mode === 'good' ? { text, confidence: 62 } : { text: '| ; i', confidence: 8 });
    }, [ocr, EVN_OCR]);
  }
  await page.goto(`/?db=t-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await page.waitForFunction(() => window.__lager);
}

export async function photoOf(page, code) {
  await page.evaluate(async (c) => {
    const cv = document.createElement('canvas'); cv.width = 64; cv.height = 64;
    await window.__lager.handleCode(c, 'photo', await new Promise((r) => cv.toBlob(r, 'image/jpeg')));
  }, code);
}

export async function setKey(page, batch = '10') {
  await page.click('#openSettings');
  await page.fill('#set-key', 'sk-ant-test-key');
  await page.selectOption('#set-batch', batch);
  await page.click('.sheet [data-act=save-settings]');
  await page.waitForFunction((b) => window.__lager.state.meta.batchSize === Number(b), batch);
}

export async function typeCode(page, code) {
  await page.fill('#codeInput', code);
  await page.press('#codeInput', 'Enter');
  await page.waitForTimeout(400); // longer than the scanner bounce guard
}

export async function product(page, ean) {
  return page.evaluate((e) => window.__lager.state.products[e], ean);
}

// Valid EAN-13 from a 12-digit stem.
export function ean13(stem) {
  let sum = 0;
  for (let i = 11, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += Number(stem[i]) * w;
  return stem + ((10 - (sum % 10)) % 10);
}

// Fake Messages API. reply(body) returns the parsed JSON the model "answers".
export async function mockClaude(page, reply) {
  const calls = [];
  await page.route('https://api.anthropic.com/**', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST' } });
    }
    const body = req.postDataJSON();
    calls.push({ body, headers: req.headers() });
    const answer = reply(body);
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'request-id': 'req_test' },
      body: JSON.stringify({
        id: 'msg_test', type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'text', text: JSON.stringify(answer) }],
        stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1000, output_tokens: 200 },
      }),
    });
  });
  return calls;
}

export const kindOf = (body) => (/You research products/.test(body.system) ? 'research' : /You identify products/.test(body.system) ? 'identify' : /You match lines/.test(body.system) ? 'match' : 'other');

// Every EAN in the request's text blocks.
export function requestedEans(body) {
  const text = body.messages[0].content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  const m = text.match(/Return one entry in "items" for each of these EANs: ([\d, ]+)/);
  return m ? m[1].split(',').map((s) => s.trim()) : [];
}
