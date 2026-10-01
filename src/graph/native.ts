import type { NpmPackageVersion } from '../api/npm';

/**
 * Native-binary / WASM detection for npm packages.
 *
 * Tier 1 (`detectNativeFromPackument`) works purely off registry metadata —
 * no extra fetches. It catches the dominant conventions:
 *
 *   - napi-rs:            `napi` config block + `*-{os}-{arch}(-{abi})` optionalDeps
 *   - node-pre-gyp:       `binary` block
 *   - node-gyp:           `gypfile` flag or `binding.gyp` / node-gyp install script
 *   - prebuild-download:  prebuild-install / node-gyp-build / prebuildify signals
 *   - platform binaries:  optional deps on per-OS/arch packages (esbuild, swc,
 *                         sharp, rollup, biome, lightningcss, typescript@7 …)
 *   - wasm:               wasm32/wasi targets or `*-wasm` package naming
 *
 * Tier 2 (`detectNativeFromFileList`) inspects the published tarball's file
 * list (fetched lazily via unpkg ?meta) and is authoritative for self-contained
 * wasm/.node payloads that leave no metadata trace (e.g. @dqbd/tiktoken).
 */

export type NativeKind =
    /** .wasm payload or wasm32/wasi target */
    | 'wasm'
    /** napi / napi-rs addon (declared via napi config) */
    | 'napi'
    /** node-gyp / binding.gyp compile-on-install */
    | 'node-gyp'
    /** downloads a prebuilt .node at install time (prebuild-install et al.) */
    | 'prebuild'
    /** publishes per-OS/arch binary packages (esbuild/swc/sharp style) or has os/cpu/libc constraints */
    | 'platform-binary'
    /** ships .node files or other native binaries inside the tarball */
    | 'native-addon';

export interface NativeDetection {
    kinds: NativeKind[];
    /** Human-readable evidence, e.g. "install script runs node-gyp" */
    details: string[];
}

const empty: NativeDetection = { kinds: [], details: [] };

// Dependency package names whose presence implies a native install step
const NATIVE_DEP_SIGNALS: Record<string, { kind: NativeKind; detail: string }> = {
    'node-gyp': { kind: 'node-gyp', detail: 'depends on node-gyp' },
    'node-gyp-build': { kind: 'prebuild', detail: 'depends on node-gyp-build' },
    'node-pre-gyp': { kind: 'prebuild', detail: 'depends on node-pre-gyp' },
    '@mapbox/node-pre-gyp': { kind: 'prebuild', detail: 'depends on node-pre-gyp' },
    'prebuild-install': { kind: 'prebuild', detail: 'depends on prebuild-install' },
    'prebuildify': { kind: 'prebuild', detail: 'depends on prebuildify' },
    'cmake-js': { kind: 'node-gyp', detail: 'depends on cmake-js' },
    'node-addon-api': { kind: 'napi', detail: 'depends on node-addon-api' },
    'bindings': { kind: 'native-addon', detail: 'depends on bindings (.node loader)' },
    'detect-libc': { kind: 'native-addon', detail: 'depends on detect-libc (native loading)' },
    'napi-build-utils': { kind: 'napi', detail: 'depends on napi-build-utils' },
    '@napi-rs/wasm-runtime': { kind: 'wasm', detail: 'depends on @napi-rs/wasm-runtime' },
};

// Install-script commands and what they imply
const INSTALL_SCRIPT_SIGNALS: Array<{ re: RegExp; kind: NativeKind; detail: string }> = [
    { re: /\bnode-pre-gyp\b/, kind: 'prebuild', detail: 'install script runs node-pre-gyp' },
    { re: /\bprebuild-install\b/, kind: 'prebuild', detail: 'install script runs prebuild-install' },
    { re: /\bprebuildify\b/, kind: 'prebuild', detail: 'install script runs prebuildify' },
    { re: /\bnode-gyp-build\b/, kind: 'prebuild', detail: 'install script runs node-gyp-build' },
    { re: /\bnode-gyp\b/, kind: 'node-gyp', detail: 'install script runs node-gyp' },
    { re: /\bcmake-js\b/, kind: 'node-gyp', detail: 'install script runs cmake-js' },
    { re: /\bnapi\b/, kind: 'napi', detail: 'install script invokes napi' },
    { re: /\bcargo\b/, kind: 'native-addon', detail: 'install script compiles with cargo' },
    { re: /\bwasm-pack\b/, kind: 'wasm', detail: 'install script runs wasm-pack' },
    { re: /\bemcc|emscripten\b/, kind: 'wasm', detail: 'install script runs emscripten' },
];

// Names like @swc/core-linux-x64-gnu, @esbuild/darwin-arm64, @img/sharp-win32-ia32,
// lightningcss-freebsd-x64, @img/sharp-webcontainers-wasm32. Requires a known
// arch token after the OS so `linux-utils`-style names don't false-positive.
const PLATFORM_OS_TOKENS = '(?:android|aix|darwin|freebsd|linux|linuxmusl|netbsd|openbsd|sunos|wasi|webcontainers|win32)';
const PLATFORM_ARCH_TOKENS = '(?:x64|arm64|aarch64|armv7|arm|ia32|x86|x86_64|ppc64|ppc64le|s390x|riscv64|loong64|mips64el|wasm32|universal)';
const PLATFORM_DEP_RE = new RegExp(`-${PLATFORM_OS_TOKENS}-${PLATFORM_ARCH_TOKENS}(?:-[a-z0-9]+)*$`, 'i');
// Bare wasm32/wasi suffixes: @img/sharp-wasm32, @resvg/resvg-wasm32-wasi
const WASM_DEP_RE = /-(?:wasm32|wasi)$/i;

/** npm CLI commands declared by a version's `bin` field. */
export function getCliCommands(bin: string | Record<string, string> | undefined): string[] {
    if (!bin) return [];
    if (typeof bin === 'string') return bin ? [bin] : [];
    return Object.keys(bin);
}

/** Tier 1: infer native/wasm traits from packument metadata alone. */
export function detectNativeFromPackument(pkg: Pick<NpmPackageVersion,
    'name' | 'napi' | 'binary' | 'gypfile' | 'scripts' | 'dependencies' | 'optionalDependencies' | 'os' | 'cpu' | 'libc'
>): NativeDetection {
    const kinds = new Set<NativeKind>();
    const details: string[] = [];
    const add = (kind: NativeKind, detail: string) => {
        if (!kinds.has(kind)) {
            kinds.add(kind);
            details.push(detail);
        }
    };

    if (pkg.napi) {
        const targets = pkg.napi.targets?.length;
        add('napi', `napi config${targets ? ` (${targets} target triples)` : ''}`);
        if (pkg.napi.targets?.some(t => /wasm32|wasi/.test(t))) {
            add('wasm', 'napi targets include wasm32/wasi');
        }
    }

    if (pkg.binary) {
        add('prebuild', 'node-pre-gyp binary config');
    }

    if (pkg.gypfile) {
        add('node-gyp', 'gypfile flag (binding.gyp)');
    }

    for (const [hook, cmd] of Object.entries(pkg.scripts || {})) {
        for (const sig of INSTALL_SCRIPT_SIGNALS) {
            if (sig.re.test(cmd)) {
                add(sig.kind, `${sig.detail} (${hook})`);
            }
        }
    }

    const allDeps = { ...pkg.dependencies, ...pkg.optionalDependencies };
    for (const depName of Object.keys(allDeps)) {
        const sig = NATIVE_DEP_SIGNALS[depName];
        if (sig) {
            add(sig.kind, sig.detail);
        }
    }

    const platformDeps = Object.keys(pkg.optionalDependencies || {})
        .filter(d => PLATFORM_DEP_RE.test(d) || WASM_DEP_RE.test(d));
    if (platformDeps.length > 0) {
        add('platform-binary', `ships ${platformDeps.length} platform-specific binary package${platformDeps.length !== 1 ? 's' : ''}`);
        if (platformDeps.some(d => /wasm32|wasi|webcontainers/i.test(d))) {
            add('wasm', 'has a wasm32 platform package');
        }
        // Platform-split packages are the signature napi-rs/esbuild layout;
        // flag napi too when an explicit napi config corroborates it
        if (pkg.napi) {
            add('napi', 'napi-rs platform packages');
        }
    }

    if (pkg.os?.length || pkg.cpu?.length || pkg.libc?.length) {
        const parts = [
            pkg.os?.length ? `os:${pkg.os.join('/')}` : '',
            pkg.cpu?.length ? `cpu:${pkg.cpu.join('/')}` : '',
            pkg.libc?.length ? `libc:${pkg.libc.join('/')}` : ''
        ].filter(Boolean).join(', ');
        add('platform-binary', `platform-restricted package (${parts})`);
    }

    // Package name itself signals a wasm-only build (esbuild-wasm, ffmpeg.wasm…)
    if (/(?:^|[./_-])wasm(?:$|[._-])/i.test(pkg.name) && !kinds.has('wasm')) {
        add('wasm', 'wasm package name');
    }

    if (details.length === 0) return empty;
    return { kinds: [...kinds], details };
}

/** Tier 2: scan published file names (e.g. from unpkg ?meta) for native artifacts. */
export function detectNativeFromFileList(paths: string[]): NativeDetection {
    const kinds = new Set<NativeKind>();
    const details: string[] = [];
    const add = (kind: NativeKind, detail: string) => {
        if (!kinds.has(kind)) {
            kinds.add(kind);
            details.push(detail);
        }
    };

    const wasm = paths.filter(p => /\.wasm$/i.test(p));
    const addons = paths.filter(p => /\.node$/i.test(p));
    const gyp = paths.some(p => /(^|\/)binding\.gyp$/i.test(p));
    const prebuildDir = paths.some(p => /(^|\/)prebuilds?\//i.test(p));
    const sharedLibs = paths.filter(p => /\.(so|dylib|dll)$/i.test(p));

    if (wasm.length) add('wasm', `ships ${wasm.length} .wasm file${wasm.length !== 1 ? 's' : ''}`);
    if (addons.length) add('native-addon', `ships ${addons.length} .node addon${addons.length !== 1 ? 's' : ''}`);
    if (gyp) add('node-gyp', 'binding.gyp in tarball');
    if (prebuildDir) add('prebuild', 'prebuilds/ directory');
    if (sharedLibs.length) add('native-addon', `ships ${sharedLibs.length} shared librar${sharedLibs.length !== 1 ? 'ies' : 'y'}`);

    if (details.length === 0) return empty;
    return { kinds: [...kinds], details };
}

/** Merge two detections, deduplicating kinds and details. */
export function mergeNativeDetections(a: NativeDetection, b: NativeDetection): NativeDetection {
    const kinds = [...new Set([...a.kinds, ...b.kinds])];
    const details = [...new Set([...a.details, ...b.details])];
    return { kinds, details };
}

/** Short display label for a kind badge. */
export const NATIVE_KIND_LABELS: Record<NativeKind, string> = {
    wasm: 'WASM',
    napi: 'N-API',
    'node-gyp': 'node-gyp',
    prebuild: 'prebuilt',
    'platform-binary': 'native binary',
    'native-addon': 'native addon',
};
