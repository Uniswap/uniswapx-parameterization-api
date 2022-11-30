const ts_preset = require('ts-jest/jest-preset')

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  ...ts_preset,
  testEnvironment: 'node',
  testPathIgnorePatterns: ['bin', 'dist'],
  collectCoverageFrom: ['**/*.ts', '!**/build/**', '!**/node_modules/**', '!**/dist/**', '!**/bin/**'],
}