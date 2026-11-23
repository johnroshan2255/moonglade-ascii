import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { host: true },
  preview: { host: true },
  build: {
    // WebGL2 baseline: Android Chrome 80+, iOS Safari 15+
    target: ['es2020', 'chrome80', 'safari15', 'firefox78'],
    chunkSizeWarningLimit: 2500,
  },
});
