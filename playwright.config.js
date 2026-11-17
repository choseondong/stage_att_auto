// @ts-check
import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';

dotenv.config();

export default defineConfig({
  testDir: '.',
  testIgnore: ['**/node_modules/**', '**/results/**'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: '.playwright/report', open: 'never' }]],
  outputDir: '.playwright/test-results',
  use: {
    ...devices['Desktop Chrome'],
    locale: 'ko-KR',
    screenshot: 'off',
    video: 'off',
    trace: 'off',
  },
  projects: [
    { name: 'attendance', testMatch: /stage_att\.spec\.js/ },
    { name: 'reset', testMatch: /stage_att_reset\.spec\.js/ },
  ],
});
