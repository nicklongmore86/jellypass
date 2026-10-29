/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  testMatch: ['<rootDir>/__tests__/**/*.test.ts?(x)'],
  // A bounded memory footprint wherever it runs (the CI runner has 4 cores and 16 GB): two workers, not one per core,
  // and a worker whose heap is still above 1 GB after a test file is replaced before it takes the next. The CI job also
  // caps each Node heap (NODE_OPTIONS in .github/workflows/mobile.yaml).
  maxWorkers: 2,
  workerIdleMemoryLimit: '1GB',
};
