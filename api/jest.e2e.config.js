// End-to-end tests (require a running Postgres via DATABASE_URL).
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: 'test/.*\\.e2e-spec\\.ts$',
  transform: { '^.+\\.(t|j)s$': 'ts-jest' },
  moduleNameMapper: {
    '^prisma/generated/(.*)$': '<rootDir>/prisma/generated/$1',
  },
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  testEnvironment: 'node',
  testTimeout: 30000,
};
