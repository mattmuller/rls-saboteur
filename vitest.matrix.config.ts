import { defineConfig } from 'vitest/config';
// One file at a time: both files wipe and recreate databases on the same cluster.
export default defineConfig({ test: { include: ['test/matrix/**/*.test.ts'], testTimeout: 900_000, hookTimeout: 120_000, fileParallelism: false } });
