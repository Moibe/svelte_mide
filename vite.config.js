import { defineConfig, loadEnv } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [svelte()],
    server: {
      proxy: {
        '/api-desarrollo': {
          target: 'http://127.0.0.1:8000',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api-desarrollo/, ''),
        },
        '/api-staging': {
          target: 'http://172.10.30.15:8080',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api-staging/, ''),
        },
        '/api-produccion': {
          target: 'http://172.10.30.16:8080',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api-produccion/, ''),
        },
      },
    },
  };
});
