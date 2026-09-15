import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Renderer is a plain multi-entry static bundle. The main process serves it
// from dist/renderer via file://, so base must be relative.
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  build: {
    outDir: resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'src/renderer/index.html'),
      },
    },
  },
});
