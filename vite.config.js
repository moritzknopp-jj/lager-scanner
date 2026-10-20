import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const src = (f) => fileURLToPath(new URL('./src/' + f, import.meta.url));

// Two builds:
//  - default: GitHub Pages app (IndexedDB storage, Claude via API key)
//  - --mode artifact: claude.ai artifact (artifact database, Claude via the user's subscription)
// Relative base so either build works from any folder.
export default defineConfig(({ mode }) => {
  const artifact = mode === 'artifact';
  const alias = [];
  if (mode !== 'test') alias.push({ find: 'exceljs', replacement: 'exceljs/dist/exceljs.min.js' }); // self-contained browser bundle
  if (artifact) {
    alias.push({ find: /^\.\/db\.js$/, replacement: src('db-claude.js') });
    alias.push({ find: /^\.\/ai\.js$/, replacement: src('ai-claude.js') });
  }
  return {
    base: './',
    define: { __ARTIFACT__: JSON.stringify(artifact) },
    resolve: { alias },
    build: { outDir: artifact ? 'dist-artifact' : 'dist', chunkSizeWarningLimit: 2000, modulePreload: { polyfill: false } },
    test: { include: ['tests/unit/**/*.test.js'] },
  };
});
