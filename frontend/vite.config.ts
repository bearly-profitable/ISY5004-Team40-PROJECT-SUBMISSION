import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    return {
      server: {
        port: 3000,
        // Localhost only: the dev server can read project files, so it should
        // not be reachable from the rest of the Wi-Fi. To test on a phone, run
        // with VITE_DEV_HOST=0.0.0.0 on a network you trust.
        host: env.VITE_DEV_HOST || 'localhost',
      },
      plugins: [react()],
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
