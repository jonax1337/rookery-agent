import { fileURLToPath, URL } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  /**
   * The API and socket live on the Rookery server; Vite proxies both in dev.
   * The port comes from the repo root's `.env` like the server's own, so a
   * checkout whose server runs beside an installed Rookery (ROOKERY_PORT=4318)
   * talks to that server and not to the installed one on 4317.
   */
  const env = { ...loadEnv(mode, fileURLToPath(new URL('../..', import.meta.url)), 'ROOKERY_'), ...process.env };
  const BACKEND = env.ROOKERY_BACKEND ?? `http://127.0.0.1:${env.ROOKERY_PORT ?? 4317}`;

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: {
      port: 5317,
      proxy: {
        '/api': { target: BACKEND, changeOrigin: false },
        // changeOrigin stays off so the browser's Origin keeps matching the
        // forwarded Host — the server's same-origin check must see them equal.
        '/ws': { target: BACKEND, ws: true, changeOrigin: false },
      },
    },
    build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 900 },
  };
});
