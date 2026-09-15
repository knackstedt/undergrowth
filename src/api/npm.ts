import { PersistentCache } from '../utils/cache';
import { PermanentError, withRetry } from '../utils/retry';

// Raw npm registry response format (before normalization)
interface RawNpmPackageVersion {
    name: string;
    version: string;
    description: string;
    deprecated?: string | boolean;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    repository?: { type: string; url: string; };
    maintainers?: Array<{ name: string; email: string; }>;
    time?: Record<string, string>;
    type?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    exports?: any;
    main?: string;
    module?: string;
    types?: string;
    typings?: string;
    license?: string | { type?: string; url?: string } | Array<{ type?: string; url?: string }>;
    dist?: {
        unpackedSize?: number;
        fileCount?: number;
    };
}

// Normalized format used throughout the app
export interface NpmPackageVersion {
    name: string;
    version: string;
    description: string;
    deprecated?: string | boolean;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    repository?: { type: string; url: string; };
    maintainers?: Array<{ name: string; email: string; }>;
    time?: Record<string, string>;
    type?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    exports?: any;
    main?: string;
    module?: string;
    types?: string;
    typings?: string;
    license?: string; // Normalized to string from API response
    dist?: {
        unpackedSize?: number;
        fileCount?: number;
    };
}

export interface NpmPackageMeta {
    name: string;
    description: string;
    'dist-tags': Record<string, string>;
    versions: Record<string, NpmPackageVersion>;
    time: Record<string, string>;
    repository?: { type: string; url: string; };
    maintainers?: Array<{ name: string; email: string; }>;
    readme?: string;
}

export async function fetchPackageMeta(name: string, signal?: AbortSignal): Promise<NpmPackageMeta> {
    const cacheKey = `npm:${name}`;

    // getOrComputeRegistry dedupes concurrent fetches and caches results with TTL
    const fetchAndCache = async (): Promise<NpmPackageMeta> => {
        return await withRetry(async () => {
            // We use a CORS proxy if necessary, but registry.npmjs.org usually supports CORS for GET.
            // Scoped packages need special encoding: @scope/name -> @scope%2Fname
            const encodedName = name.startsWith('@')
                ? `@${name.slice(1).replace(/\//g, '%2F')}`
                : encodeURIComponent(name);
            const res = await fetch(`https://registry.npmjs.org/${encodedName}`, { signal });
            if (res.status >= 400 && res.status < 500) {
                // 4xx errors are permanent — don't retry them
                throw new PermanentError(`Package "${name}" not found (${res.status})`);
            }
            if (!res.ok) {
                throw new Error(`Failed to fetch package ${name}: ${res.statusText} (${res.status})`);
            }
            const rawData = await res.json() as { versions: Record<string, RawNpmPackageVersion> } & Omit<NpmPackageMeta, 'versions'>;

            // Strip unnecessary fields from versions to save memory
            // Historical versions contain huge amounts of data (scripts, devDependencies, dist) that we don't need
            const strippedVersions: Record<string, NpmPackageVersion> = {};
            for (const [version, pkg] of Object.entries(rawData.versions || {})) {
                let licenseStr: string | undefined;
                if (pkg.license) {
                    if (typeof pkg.license === 'string') {
                        licenseStr = pkg.license;
                    } else if (Array.isArray(pkg.license)) {
                        licenseStr = pkg.license.map((l: { type?: string }) => l.type || '').filter(Boolean).join(' OR ');
                    } else {
                        licenseStr = (pkg.license as { type?: string }).type || '';
                    }
                }
                strippedVersions[version] = {
                    name: pkg.name,
                    version: pkg.version,
                    description: pkg.description,
                    deprecated: pkg.deprecated,
                    dependencies: pkg.dependencies,
                    peerDependencies: pkg.peerDependencies,
                    repository: pkg.repository,
                    maintainers: pkg.maintainers,
                    type: pkg.type,
                    exports: pkg.exports,
                    main: pkg.main,
                    module: pkg.module,
                    types: pkg.types,
                    typings: pkg.typings,
                    dist: pkg.dist,
                    license: licenseStr
                };
            }

            const data: NpmPackageMeta = {
                name: rawData.name,
                description: rawData.description,
                'dist-tags': rawData['dist-tags'],
                versions: strippedVersions,
                time: rawData.time,
                repository: rawData.repository,
                maintainers: rawData.maintainers,
                readme: rawData.readme
            };

            return data;
        }, 5, 2500, signal);
    };

    return PersistentCache.getOrComputeRegistry(cacheKey, fetchAndCache);
}

export async function getDownloads(name: string, signal?: AbortSignal): Promise<number | null> {
    try {
        const data = await withRetry(async () => {
            // Scoped packages need special encoding: @scope/name -> @scope%2Fname
            const encodedName = name.startsWith('@')
                ? `@${name.slice(1).replace(/\//g, '%2F')}`
                : encodeURIComponent(name);
            const res = await fetch(`https://api.npmjs.org/downloads/point/last-week/${encodedName}`, { signal });
            if (!res.ok) {
                throw new Error(`Failed to fetch downloads: ${res.statusText} (${res.status})`);
            }
            return res.json();
        }, 5, 2500, signal);
        return data.downloads || 0;
    } catch (e) {
        console.error('Failed to fetch downloads', e);
    }
    return null;
}
