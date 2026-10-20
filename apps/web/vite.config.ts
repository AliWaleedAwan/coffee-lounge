/**
 * Staff web app build. In production the API's staff listener serves `dist/` on the
 * same origin as the API (API.md §1), so cookies, CSRF and the CSP stay same-origin.
 * In development Vite proxies /api and /health to the local API without changing the
 * Host header, so the server's same-origin check sees Vite's origin on both sides.
 */
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const api = process.env['CL_API_ORIGIN'] ?? 'http://127.0.0.1:8443';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    // Everything must be served by the shop server: no inline scripts or data URLs.
    assetsInlineLimit: 0,
    // Two apps from one build: staff (index.html, staff listener) and guest (guest.html,
    // customer listener, P3-2).
    rollupOptions: {
      input: {
        staff: fileURLToPath(new URL('./index.html', import.meta.url)),
        guest: fileURLToPath(new URL('./guest.html', import.meta.url)),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: api, changeOrigin: false },
      '/health': { target: api, changeOrigin: false },
    },
  },
});
