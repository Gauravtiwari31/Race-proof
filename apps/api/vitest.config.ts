import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/globalSetup.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Each worker's app holds a pool of up to 15 connections, and Postgres defaults to 100 in total.
    maxWorkers: 4,
  },
});
