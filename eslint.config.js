// ESLint v9+ uses flat config format (eslint.config.js)
const js = require('@eslint/js');
const prettier = require('eslint-plugin-prettier');
const prettierConfig = require('eslint-config-prettier');

module.exports = [
  // Apply to all JS files
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        // Node.js globals
        console: 'readonly',
        process: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        module: 'readonly',
        require: 'readonly',
        exports: 'writable',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
      },
    },
    plugins: {
      prettier,
    },
    rules: {
      // Extend recommended rules
      ...js.configs.recommended.rules,
      ...prettierConfig.rules,

      // ===== CODING STANDARDS =====

      // Max line length: 120 characters
      'max-len': [
        'error',
        {
          code: 120,
          tabWidth: 2,
          ignoreUrls: true,
          ignoreStrings: true,
          ignoreTemplateLiterals: true,
          ignoreRegExpLiterals: true,
          ignoreComments: false,
        },
      ],

      // Max lines per file: 300 (warn at 300)
      'max-lines': [
        'warn',
        {
          max: 300,
          skipBlankLines: true,
          skipComments: true,
        },
      ],

      // Max lines per function: 30
      'max-lines-per-function': [
        'warn',
        {
          max: 30,
          skipBlankLines: true,
          skipComments: true,
          IIFEs: true,
        },
      ],

      // ===== ADDITIONAL BEST PRACTICES =====

      // Complexity: max 10 (cyclomatic complexity)
      complexity: ['warn', 10],

      // Max depth of nested blocks: 4
      'max-depth': ['warn', 4],

      // Max nested callbacks: 3
      'max-nested-callbacks': ['warn', 3],

      // Max parameters per function: 4
      'max-params': ['warn', 4],

      // Require consistent return
      'consistent-return': 'warn',

      // No unused variables
      'no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],

      // Prefer const over let
      'prefer-const': 'warn',

      // No var
      'no-var': 'error',

      // Require === instead of ==
      eqeqeq: ['error', 'always'],

      // No console (off because we use winston)
      'no-console': 'off',

      // Require curly braces for all control statements
      curly: ['error', 'all'],

      // No multiple empty lines
      'no-multiple-empty-lines': [
        'error',
        {
          max: 2,
          maxEOF: 1,
        },
      ],

      // Prettier integration
      'prettier/prettier': 'error',
    },
  },
  // Ignore patterns
  {
    ignores: ['node_modules/**', 'dist/**', 'build/**', 'coverage/**', '*.min.js', 'logs/**'],
  },
];
