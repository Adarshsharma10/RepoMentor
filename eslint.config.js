import js from '@eslint/js';
import globals from 'globals';

const serverFiles = ['server/src/**/*.js', 'server/scripts/**/*.js', 'server/test/**/*.js'];
const clientFiles = ['client/src/**/*.{js,jsx}'];

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.vite/**',
      'server/eval/**'
    ]
  },
  {
    files: serverFiles,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-undef': 'error',
      'no-unused-vars': ['error', { args: 'all', argsIgnorePattern: '^_' }]
    }
  },
  {
    files: clientFiles,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: globals.browser
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-undef': 'error',
      'no-unused-vars': ['error', { args: 'all', argsIgnorePattern: '^_' }]
    }
  }
];
