import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/e2e/**/*.test.ts'], testTimeout: 600_000, hookTimeout: 120_000 } });
