import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './'),
      '@client': path.resolve(__dirname, './src'),
      '@server': path.resolve(__dirname, './server'),
      '@tests': path.resolve(__dirname, './tests'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // `ws: true` is what lets `/api/voice` upgrade through here. Without it the
      // dev server answers the handshake itself with a 404 and the microphone
      // works in a production build only — the kind of gap that is found late.
      //
      // The `/ws` entry that used to sit below this one proxied a path nothing
      // ever served: the voice socket lives under `/api`, so one entry covers
      // both the JSON routes and the upgrade.
      //
      // `changeOrigin` rewrites `Host`, which defeats the `Origin`-versus-`Host`
      // fallback in `assertNotCrossSite`. That is why `devOrigins()` allowlists
      // this port explicitly — see the comment there.
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist/client',
    sourcemap: true,
  },
});
