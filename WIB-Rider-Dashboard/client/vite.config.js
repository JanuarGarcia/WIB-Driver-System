import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('leaflet') || id.includes('react-leaflet')) return 'vendor-leaflet';
          if (id.includes('@react-google-maps/api')) return 'vendor-google-maps';
          if (id.includes('react-router-dom')) return 'vendor-router';
          if (id.includes('react-toastify')) return 'vendor-toast';
          /*
           * Keep `react`, `react-dom`, and `scheduler` in ONE chunk. Splitting `react` vs `react-dom`
           * produced a tiny `vendor-react` (~8kB) and broke runtime pairing → blank white screen in production.
           */
          if (id.includes('node_modules/react-dom') || id.includes('node_modules/scheduler')) {
            return 'vendor-react';
          }
          if (
            /node_modules[/\\]react[/\\]/.test(id) &&
            !id.includes('react-router') &&
            !id.includes('react-toastify') &&
            !id.includes('react-leaflet') &&
            !id.includes('@react-google-maps')
          ) {
            return 'vendor-react';
          }
          return 'vendor';
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/admin/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
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
