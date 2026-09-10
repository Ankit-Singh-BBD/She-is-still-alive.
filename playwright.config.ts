import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:3099',
    trace: 'on-first-retry',
  },
  webServer: {
    command:
      'FACULTY_MODE=local-only DATABASE_PATH=/tmp/madhurita-e2e.db PORT=3099 npx tsx server/main.ts',
    url: 'http://127.0.0.1:3099/api/hello',
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
