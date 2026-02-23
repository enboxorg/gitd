import eslint from '@eslint/js';
import globals from 'globals';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import stylisticPlugin from '@stylistic/eslint-plugin';

/** @type {import('eslint').Linter.Config[]} */
export default [
  eslint.configs.recommended,
  {
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaFeatures : { modules: true },
        ecmaVersion  : 'latest',
        project      : true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
        ...globals.es2021,
        console: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint' : tsPlugin,
      '@stylistic'         : stylisticPlugin,
    },
    files   : ['**/*.ts'],
    ignores : ['**/*.d.ts'],
    rules   : {
      'curly'      : ['error', 'all'],
      'no-console' : 'off',
      'no-undef'   : 'off',
      'indent'     : ['error', 2, { SwitchCase: 1 }],

      'object-curly-spacing' : ['error', 'always'],
      'no-multi-spaces'      : ['error'],
      'no-trailing-spaces'   : ['error'],

      'key-spacing': [
        'error',
        {
          align: {
            afterColon  : true,
            beforeColon : true,
            on          : 'colon',
          },
        },
      ],

      'keyword-spacing' : ['error', { before: true, after: true }],
      'quotes'          : ['error', 'single', { allowTemplateLiterals: true }],
      'max-len'         : ['error', { code: 150, ignoreStrings: true }],

      '@stylistic/semi' : ['error', 'always'],
      'semi'            : ['off'],

      'no-unused-vars'                    : 'off',
      'no-redeclare'                      : 'off',
      'no-dupe-class-members'             : 'off',
      '@typescript-eslint/no-unused-vars' : [
        'error',
        {
          vars               : 'all',
          args               : 'after-used',
          ignoreRestSiblings : true,
          argsIgnorePattern  : '^_',
          varsIgnorePattern  : '^_',
        },
      ],

      '@typescript-eslint/explicit-function-return-type' : ['error'],
      '@typescript-eslint/consistent-type-imports'       : 'error',
      '@typescript-eslint/no-explicit-any'               : 'off',
      '@typescript-eslint/no-non-null-assertion'         : 'off',
      '@typescript-eslint/ban-ts-comment'                : 'off',

      'prefer-const' : ['error', { destructuring: 'all' }],
      'sort-imports' : ['error', {
        ignoreCase            : true,
        ignoreDeclarationSort : false,
        ignoreMemberSort      : false,
        memberSyntaxSortOrder : ['none', 'all', 'single', 'multiple'],
        allowSeparatedGroups  : true,
      }],
    },
  },
  {
    ignores: ['**/*.js', '**/*.cjs', '**/*.mjs', 'dist/**'],
  },
];
