import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node', // Default wrapper is node, we can override to jsdom in specific files using a pragma
    setupFiles: ['./tests/setup-jsdom.ts'],
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['server/**/*.ts', 'src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['tests/**/*.ts', 'scripts/**/*.ts'],
    },
    alias: {
      '@': path.resolve(__dirname, './'),
      '@client': path.resolve(__dirname, './src'),
      '@server': path.resolve(__dirname, './server'),
      '@tests': path.resolve(__dirname, './tests'),
    },
  },
});
