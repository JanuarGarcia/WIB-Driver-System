import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, '/admin/api'),
      },
      '/uploads': { target: 'http://localhost:3000', changeOrigin: true },
      '/upload': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
});
