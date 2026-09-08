import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Integration tests boot the real Python worker; give them headroom.
    testTimeout: 60000,
    hookTimeout: 60000,
    pool: 'forks',
  },
})
