import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFixtures } from './fixtures.js';

export default function globalSetup() {
  writeFixtures(path.join(path.dirname(fileURLToPath(import.meta.url)), '.fixtures'));
}
