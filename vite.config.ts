import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  build: { outDir: '../dist/web', emptyOutDir: true, target: 'es2022' },
  server: { proxy: { '/api': { target: 'http://127.0.0.1:8787', ws: true } } },
});
