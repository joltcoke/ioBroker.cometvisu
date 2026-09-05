import { federation } from '@module-federation/vite';
import react from '@vitejs/plugin-react';
import { moduleFederationShared } from '@iobroker/gui-components/modulefederation.admin.config';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const pack = JSON.parse(readFileSync('./package.json').toString());

export default defineConfig({
    plugins: [
        federation({
            manifest: true,
            name: 'ConfigCustomCometVisu',
            filename: 'customComponents.js',
            exposes: { './Components': './src/Components.tsx' },
            remotes: {},
            shared: Object.fromEntries(
                Object.entries(moduleFederationShared(pack)).map(([name, cfg]) => [
                    name,
                    // the admin provides every one of these as a singleton, so no local fallback
                    // copy has to be bundled and shipped with the adapter
                    { ...cfg, import: false },
                ]),
            ),
        }),
        react(),
    ],
    build: {
        target: 'chrome89',
        outDir: './build',
    },
    base: './',
});
