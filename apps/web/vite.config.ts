import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// In development the API runs on the Node server; Vite proxies /api to it so
// the browser sees one origin, exactly as in production.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: `http://localhost:${process.env.API_PORT ?? 8787}`, changeOrigin: false, xfwd: true },
    },
  },
  build: {
    sourcemap: false,
    target: 'es2022',
  },
});
