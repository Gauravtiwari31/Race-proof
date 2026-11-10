import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  build: {
    // Fastify serves the SPA, so UI, API and SSE share one origin and the session cookie just works.
    outDir: '../api/public',
    emptyOutDir: true,
  },
  server: {
    // API_PROXY=http://localhost:8080 in apps/web/.env.local points the dev UI at the Compose stack.
    proxy: { '/api': loadEnv(mode, process.cwd(), '').API_PROXY || 'http://localhost:3000' },
  },
}));
