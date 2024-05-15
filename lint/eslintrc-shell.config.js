// https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/14ba1c2ffad7b204eb61be3a31bddecc029b0c1a/lint/eslintrc-shell.yml
// but adapted to flat config files

export default [
    {
        rules: {
            camelcase: [
                'error',
                {
                    properties: 'never',
                    allow: ['^vfunc_', '^on_'],
                },
            ],
            'consistent-return': 'error',
            eqeqeq: ['error', 'smart'],
            'key-spacing': [
                'error',
                {
                    mode: 'minimum',
                    beforeColon: false,
                    afterColon: true,
                },
            ],
            'prefer-arrow-callback': 'error',
            'jsdoc/require-param-description': 'off',
            'jsdoc/require-jsdoc': [
                'error',
                {
                    exemptEmptyFunctions: true,
                    publicOnly: {
                        esm: true,
                    },
                },
            ],
        },
    },
    {
        files: ['js/**', 'tests/shell/**'],
        ignores: ['js/portalHelper/*', 'js/extensions/*'],
        languageOptions: {
            globals: {
                global: 'readonly',
                _: 'readonly',
                C_: 'readonly',
                N_: 'readonly',
                ngettext: 'readonly',
            },
        },
    },
    {
        files: ['subprojects/extensions-app/js/**'],
        languageOptions: {
            globals: {
                _: 'readonly',
                C_: 'readonly',
                N_: 'readonly',
            },
        },
    },
];
