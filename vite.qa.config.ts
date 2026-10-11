import { defineConfig } from 'vite';
export default defineConfig({ root: 'tests/browser', server: { proxy: { '/api': { target: 'http://127.0.0.1:8787', ws: true } } } });
