import eslintConfigPrettier from 'eslint-config-prettier';
import gjsConfig from './lint/eslintrc-gjs.config.js';
import gnomeShellConfig from './lint/eslintrc-shell.config.js';
import extensionConfig from './lint/eslintrc-extension.config.js';

export default [
    ...gjsConfig,
    ...gnomeShellConfig,
    eslintConfigPrettier,
    ...extensionConfig,
];
