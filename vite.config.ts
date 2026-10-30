import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, '.') } },
  server: {
    // Keep the existing AI Studio HMR controls.
    hmr: process.env.DISABLE_HMR !== 'true',
    watch: process.env.DISABLE_HMR === 'true' ? null : {},
    // In local development, send API calls to the Express backend.
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY_TARGET || 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
}));
