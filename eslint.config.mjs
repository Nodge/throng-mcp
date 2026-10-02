// @ts-check

import js from '@eslint/js';
import ts from 'typescript-eslint';

export default ts.config(
    {
        ignores: ['node_modules/**', 'coverage/**', 'dist/**', '.claude/**', 'backlog/**'],
    },
    js.configs.recommended,
    ...ts.configs.strictTypeChecked,
    ...ts.configs.stylisticTypeChecked,
    {
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
            '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
        },
    },
    {
        files: ['**/*.{js,mjs,cjs}'],
        ...ts.configs.disableTypeChecked,
    }
);
