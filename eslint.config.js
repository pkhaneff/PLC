// ESLint v9+ flat config
const js = require('@eslint/js');
const prettier = require('eslint-plugin-prettier');
const prettierConfig = require('eslint-config-prettier');
const tsPlugin = require('@typescript-eslint/eslint-plugin');
const tsParser = require('@typescript-eslint/parser');

module.exports = [
  // =====================================================
  // JAVASCRIPT FILES
  // =====================================================
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
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
      ...js.configs.recommended.rules,
      ...prettierConfig.rules,

      // ===== CODING STANDARDS =====
      'max-len': [
        'error',
        {
          code: 120,
          tabWidth: 2,
          ignoreUrls: true,
          ignoreStrings: true,
          ignoreTemplateLiterals: true,
          ignoreRegExpLiterals: true,
        },
      ],

      'max-lines': [
        'warn',
        {
          max: 300,
          skipBlankLines: true,
          skipComments: true,
        },
      ],

      'max-lines-per-function': [
        'warn',
        {
          max: 30,
          skipBlankLines: true,
          skipComments: true,
          IIFEs: true,
        },
      ],

      // ===== BEST PRACTICES =====
      complexity: ['warn', 10],
      'max-depth': ['warn', 4],
      'max-nested-callbacks': ['warn', 3],
      'max-params': ['warn', 4],
      'consistent-return': 'warn',

      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'prefer-const': 'warn',
      'no-var': 'error',
      eqeqeq: ['error', 'always'],
      curly: ['error', 'all'],
      'no-console': 'off',

      'no-multiple-empty-lines': [
        'error',
        {
          max: 2,
          maxEOF: 1,
        },
      ],

      // Prettier
      'prettier/prettier': 'error',
    },
  },

  // =====================================================
  // TYPESCRIPT FILES
  // =====================================================
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    plugins: {
      prettier,
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...prettierConfig.rules,

      // ===== NAMING CONVENTION =====
      '@typescript-eslint/naming-convention': [
        'error',

        // Variables & functions
        {
          selector: 'variableLike',
          format: ['camelCase'],
          leadingUnderscore: 'allow',
        },

        // Boolean variables
        {
          selector: 'variable',
          types: ['boolean'],
          format: ['camelCase'],
          prefix: ['is', 'has', 'can', 'should', 'did', 'will'],
        },

        // Functions
        {
          selector: 'function',
          format: ['camelCase'],
        },

        // Classes, interfaces, types, enums
        {
          selector: 'typeLike',
          format: ['PascalCase'],
        },

        // Enum members
        {
          selector: 'enumMember',
          format: ['UPPER_CASE'],
        },

        // Constants
        {
          selector: 'variable',
          modifiers: ['const'],
          format: ['camelCase', 'UPPER_CASE'],
        },

        // Private members
        {
          selector: 'memberLike',
          modifiers: ['private'],
          format: ['camelCase'],
          leadingUnderscore: 'require',
        },
      ],

      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],

      // Prettier
      'prettier/prettier': 'error',
    },
  },

  // =====================================================
  // IGNORE FILES
  // =====================================================
  {
    ignores: ['node_modules/**', 'dist/**', 'build/**', 'coverage/**', '*.min.js', 'logs/**'],
  },
];
