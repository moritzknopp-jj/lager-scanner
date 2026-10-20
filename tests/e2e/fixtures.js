// Generates test images: a real EAN-13 barcode as PNG and as Y4M video for Chromium's fake camera.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
const R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

export function ean13Modules(code) {
  const d = code.split('').map(Number);
  let bits = '101';
  for (let i = 1; i <= 6; i++) bits += (PARITY[d[0]][i - 1] === 'L' ? L : G)[d[i]];
  bits += '01010';
  for (let i = 7; i <= 12; i++) bits += R[d[i]];
  return bits + '101';
}

// Grayscale image (Uint8Array, 255 = white) with the barcode centred.
export function barcodeGray(code, w, h, moduleW = 6) {
  const px = new Uint8Array(w * h).fill(255);
  const bits = ean13Modules(code);
  const x0 = Math.floor((w - bits.length * moduleW) / 2);
  const y0 = Math.floor(h * 0.25), y1 = Math.floor(h * 0.75);
  for (let i = 0; i < bits.length; i++) {
    if (bits[i] !== '1') continue;
    for (let y = y0; y < y1; y++) px.fill(0, y * w + x0 + i * moduleW, y * w + x0 + (i + 1) * moduleW);
  }
  return px;
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function grayPng(px, w, h) {
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w + 1)] = 0; Buffer.from(px.buffer, y * w, w).copy(raw, y * (w + 1) + 1); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// frames: array of grayscale images (or null for a blank frame).
export function y4m(frames, w, h, fps = 10) {
  const parts = [Buffer.from(`YUV4MPEG2 W${w} H${h} F${fps}:1 Ip A1:1 C420jpeg\n`)];
  const chroma = Buffer.alloc((w / 2) * (h / 2), 128);
  const blank = Buffer.alloc(w * h, 255);
  for (const f of frames) parts.push(Buffer.from('FRAME\n'), f ? Buffer.from(f) : blank, chroma, chroma);
  return Buffer.concat(parts);
}

export const EAN = '4037293393362';

export function writeFixtures(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const W = 640, H = 480;
  const bc = barcodeGray(EAN, W, H, 5);
  // Barcode always in view.
  fs.writeFileSync(path.join(dir, 'steady.y4m'), y4m(Array(20).fill(bc), W, H));
  // In view 1 s, out of view 1.5 s, repeating: like holding up one lamp after another.
  fs.writeFileSync(path.join(dir, 'blink.y4m'), y4m([...Array(10).fill(bc), ...Array(15).fill(null)], W, H));
  fs.writeFileSync(path.join(dir, 'barcode.png'), grayPng(barcodeGray(EAN, 1200, 800, 8), 1200, 800));
  // A product photo without any barcode: a grey box.
  const plain = new Uint8Array(900 * 700).fill(235);
  for (let y = 150; y < 550; y++) plain.fill(120, y * 900 + 200, y * 900 + 700);
  fs.writeFileSync(path.join(dir, 'nobarcode.png'), grayPng(plain, 900, 700));
}
