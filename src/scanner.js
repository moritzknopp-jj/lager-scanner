// Live camera scanning, photo decoding and frame capture.
import { BrowserMultiFormatReader } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';

const LINEAR = [BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E, BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.ITF];

function reader(formats, tryHarder = false) {
  const hints = new Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, formats);
  if (tryHarder) hints.set(DecodeHintType.TRY_HARDER, true);
  return new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 80, delayBetweenScanSuccess: 80 });
}

// Calls onCode(text) for every frame that holds a barcode. Returns { stop() }.
export async function startCamera(video, onCode) {
  const r = reader([...LINEAR, BarcodeFormat.QR_CODE]);
  const controls = await r.decodeFromConstraints(
    { audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } },
    video,
    (result) => { if (result) onCode(result.getText()); },
  );
  return controls;
}

export function scaledCanvas(source, max = 1600) {
  const w = source.videoWidth || source.naturalWidth || source.width;
  const h = source.videoHeight || source.naturalHeight || source.height;
  const r = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * r);
  c.height = Math.round(h * r);
  c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
  return c;
}

// Still image of the current camera view, for OCR and for Claude.
export function captureFrame(video, max = 1600) {
  if (!video || !video.videoWidth) return Promise.resolve(null);
  const c = scaledCanvas(video, max);
  return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.85));
}

export function loadImage(blob) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { res(img); setTimeout(() => URL.revokeObjectURL(url), 1000); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Could not open the photo.')); };
    img.src = url;
  });
}

export async function shrinkPhoto(blob, max = 1600) {
  const img = await loadImage(blob);
  const c = scaledCanvas(img, max);
  return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.85));
}

// Find a barcode in a photo. Linear codes first, QR only as a fallback.
export async function decodePhoto(blob) {
  const img = await loadImage(blob);
  for (const formats of [LINEAR, [BarcodeFormat.QR_CODE, BarcodeFormat.DATA_MATRIX]]) {
    const r = reader(formats, true);
    for (const size of [1600, 1100, 2400]) {
      try { return r.decodeFromCanvas(scaledCanvas(img, size)).getText(); } catch { /* try next size */ }
      await new Promise((ok) => setTimeout(ok, 0));
    }
  }
  return null;
}
