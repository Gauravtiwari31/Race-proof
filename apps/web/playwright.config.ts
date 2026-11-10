import { defineConfig, devices } from '@playwright/test';

const PORT = 3100;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    // PW_CHANNEL=chrome uses an installed browser instead of downloading one.
    ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}),
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Prepares the database, then runs the built API in the same process (see the file for why).
    command: 'node e2e/start-server.mjs',
    url: `http://127.0.0.1:${PORT}/api/healthz`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      DATABASE_URL: 'postgres://fndn_api_e2e:e2e-only@localhost:5433/fndn_e2e'.replace('localhost:5433', new URL(process.env.TEST_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5433/postgres').host),
      PORT: String(PORT),
      HOST: '127.0.0.1',
      LOG_LEVEL: 'warn',
      INVITE_LIMIT_PER_IP: '100000',
      SIGNUP_LIMIT_PER_IP: '100000',
    },
  },
});
