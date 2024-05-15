// Override GJS, GNOME Shell and prettier config options here

export default [
    {
        rules: {
            curly: ['error', 'all'],
        },
    },
    {
        files: ['tiling-assistant@leleat-on-github/**'],
        ignores: ['tiling-assistant@leleat-on-github/prefs**'],
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
        files: ['tiling-assistant@leleat-on-github/prefs**'],
        languageOptions: {
            globals: {
                _: 'readonly',
                C_: 'readonly',
                N_: 'readonly',
            },
        },
    },
];
