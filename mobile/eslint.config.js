// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

// `pnpm lint` runs `eslint .`, so everything first-party is linted: src, the tests and their support files, the
// mocks and the config files. Only build output and generated code is left out (node_modules is ignored by ESLint
// itself). __tests__/lint-scope.test.ts checks a test file is still linted.
module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/', 'web-build/', '.expo/', 'expo-env.d.ts', 'ios/', 'android/', 'coverage/'],
  },
]);
