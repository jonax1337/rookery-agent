import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/** The API and socket live on the Rookery server; Vite proxies both in dev. */
const BACKEND = process.env.ROOKERY_BACKEND ?? 'http://127.0.0.1:4317';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5317,
    proxy: {
      '/api': { target: BACKEND, changeOrigin: false },
      '/ws': { target: BACKEND, ws: true, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 900 },
});
