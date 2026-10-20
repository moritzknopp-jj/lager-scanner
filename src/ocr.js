// On-device label reading with Tesseract. Runs one photo at a time in a background worker.
import { createWorker } from 'tesseract.js';

let workerP = null;
let chain = Promise.resolve();

function worker() {
  workerP ||= createWorker(['deu', 'eng']).catch((e) => { workerP = null; throw e; });
  return workerP;
}

// Resolves { text, confidence }. Calls are queued so the phone isn't overloaded.
export function readLabel(blob) {
  const job = chain.then(async () => {
    const w = await worker();
    const { data } = await w.recognize(blob);
    return { text: data.text || '', confidence: Math.round(data.confidence || 0) };
  });
  chain = job.catch(() => {});
  return job;
}
