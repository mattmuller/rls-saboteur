import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/matrix/**/*.test.ts'], testTimeout: 900_000, hookTimeout: 120_000 } });
