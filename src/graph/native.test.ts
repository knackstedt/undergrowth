import { describe, expect, it } from 'vitest';
import {
    detectNativeFromFileList,
    detectNativeFromPackument,
    getCliCommands,
    mergeNativeDetections,
} from './native';

describe('getCliCommands', () => {
    it('returns empty for missing bin', () => {
        expect(getCliCommands(undefined)).toEqual([]);
    });
    it('handles string bin (unnamed command)', () => {
        expect(getCliCommands('bin/cli.js')).toEqual(['bin/cli.js']);
    });
    it('handles object bin', () => {
        expect(getCliCommands({ tsc: 'bin/tsc', tsserver: 'bin/tsserver' })).toEqual(['tsc', 'tsserver']);
    });
});

describe('detectNativeFromPackument', () => {
    it('returns empty for a plain JS package', () => {
        const r = detectNativeFromPackument({ name: 'lodash' });
        expect(r.kinds).toEqual([]);
        expect(r.details).toEqual([]);
    });

    it('detects napi-rs packages (@swc/core shape)', () => {
        const r = detectNativeFromPackument({
            name: '@swc/core',
            napi: { binaryName: 'swc', targets: ['x86_64-unknown-linux-gnu', 'aarch64-apple-darwin'] },
            optionalDependencies: {
                '@swc/core-linux-x64-gnu': '1.0.0',
                '@swc/core-darwin-arm64': '1.0.0',
            },
        });
        expect(r.kinds).toContain('napi');
        expect(r.kinds).toContain('platform-binary');
    });

    it('detects wasm32 napi targets and platform deps (sharp shape)', () => {
        const r = detectNativeFromPackument({
            name: 'sharp',
            optionalDependencies: {
                '@img/sharp-linux-x64': '0.2.0',
                '@img/sharp-webcontainers-wasm32': '0.2.0',
            },
            dependencies: { 'detect-libc': '^2.0.0' },
        });
        expect(r.kinds).toContain('platform-binary');
        expect(r.kinds).toContain('wasm');
        expect(r.kinds).toContain('native-addon');
    });

    it('detects node-gyp-build packages (bufferutil shape)', () => {
        const r = detectNativeFromPackument({
            name: 'bufferutil',
            dependencies: { 'node-gyp-build': '^4.3.0' },
            scripts: { install: 'node-gyp-build' },
        });
        expect(r.kinds).toContain('prebuild');
    });

    it('detects node-gyp via gypfile flag and install script', () => {
        expect(detectNativeFromPackument({ name: 'x', gypfile: true }).kinds).toContain('node-gyp');
        expect(detectNativeFromPackument({
            name: 'x',
            scripts: { install: 'node-gyp rebuild' },
        }).kinds).toContain('node-gyp');
    });

    it('detects node-pre-gyp binary config', () => {
        const r = detectNativeFromPackument({
            name: 'sqlite3',
            binary: { module_name: 'node_sqlite3', host: 'https://example.com' },
        });
        expect(r.kinds).toContain('prebuild');
    });

    it('detects platform-restricted packages (the platform pkgs themselves)', () => {
        const r = detectNativeFromPackument({
            name: '@swc/core-linux-x64-gnu',
            os: ['linux'], cpu: ['x64'], libc: ['glibc'],
        });
        expect(r.kinds).toContain('platform-binary');
    });

    it('detects wasm-only package names', () => {
        expect(detectNativeFromPackument({ name: 'esbuild-wasm' }).kinds).toContain('wasm');
    });

    it('does not flag ordinary -linux utility names as platform deps', () => {
        // a dep named "linux-utils" should not match the platform suffix pattern
        const r = detectNativeFromPackument({
            name: 'x',
            optionalDependencies: { 'linux-utils': '1.0.0' },
        });
        expect(r.kinds).toEqual([]);
    });
});

describe('detectNativeFromFileList', () => {
    it('detects .wasm files (tiktoken shape)', () => {
        const r = detectNativeFromFileList(['/package.json', '/lite/tiktoken_bg.wasm', '/tiktoken_bg.wasm']);
        expect(r.kinds).toEqual(['wasm']);
    });

    it('detects .node addons', () => {
        const r = detectNativeFromFileList(['/package.json', '/swc.linux-x64-gnu.node']);
        expect(r.kinds).toEqual(['native-addon']);
    });

    it('detects binding.gyp and prebuilds dir', () => {
        const r = detectNativeFromFileList(['/binding.gyp', '/prebuilds/linux-x64/x.napi.node']);
        expect(r.kinds).toContain('node-gyp');
        expect(r.kinds).toContain('prebuild');
        expect(r.kinds).toContain('native-addon');
    });

    it('detects shared libraries', () => {
        expect(detectNativeFromFileList(['/vendor/libfoo.so']).kinds).toContain('native-addon');
    });

    it('returns empty for pure-JS packages', () => {
        expect(detectNativeFromFileList(['/index.js', '/dist/main.mjs', '/README.md']).kinds).toEqual([]);
    });
});

describe('mergeNativeDetections', () => {
    it('dedupes kinds and details', () => {
        const m = mergeNativeDetections(
            { kinds: ['napi'], details: ['napi config'] },
            { kinds: ['napi', 'wasm'], details: ['napi config', 'ships 1 .wasm file'] }
        );
        expect(m.kinds.sort()).toEqual(['napi', 'wasm']);
        expect(m.details).toEqual(['napi config', 'ships 1 .wasm file']);
    });
});
