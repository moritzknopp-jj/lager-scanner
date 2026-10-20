import { defineConfig } from 'vite';

// Relative base so the build works under https://<user>.github.io/<repo>/
export default defineConfig(({ mode }) => ({
  base: './',
  build: { outDir: 'dist', chunkSizeWarningLimit: 2000 },
  // In the browser use ExcelJS's self-contained bundle; tests run the Node build.
  resolve: mode === 'test' ? {} : { alias: { exceljs: 'exceljs/dist/exceljs.min.js' } },
  test: { include: ['tests/unit/**/*.test.js'] },
}));
