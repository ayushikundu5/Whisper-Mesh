/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],

  // `@noble/*` v2 ships pure ESM with no CommonJS build, so the default
  // "never transform node_modules" rule leaves raw `import` statements for the
  // CJS runtime to choke on. Transpiling just those packages is cheaper and
  // less fragile than putting the whole suite into Jest's experimental ESM mode.
  transform: {
    '^.+\\.[tj]s$': [
      'ts-jest',
      {
        tsconfig: { allowJs: true, module: 'CommonJS', target: 'ES2022' },
        diagnostics: { warnOnly: false },
      },
    ],
  },
  transformIgnorePatterns: ['/node_modules/(?!@noble/)'],

  // The simulation suite drives thousands of virtual deliveries across 20 nodes.
  testTimeout: 30000,
};
