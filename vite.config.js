import { resolve } from 'path';
import { defineConfig, loadEnv } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [svelte()],
    build: {
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'index.html'),
          embed: resolve(__dirname, 'embed/index.html'),
          contextlight: resolve(__dirname, 'embed/contextlight.html'),
        },
      },
    },
    server: {
      port: 4173,
      strictPort: true,
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:8080',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ''),
        },
      },
    },
    preview: {
      port: 4173,
      strictPort: true,
    },
  };
});
