import { PersistentCache } from '../utils/cache';
import { withRetry, PermanentError } from '../utils/retry';

export type PackageSystem = 'GO' | 'RUBYGEMS' | 'NPM' | 'CARGO' | 'MAVEN' | 'PYPI' | 'NUGET';

export interface DepsDevVersionKey {
    system: PackageSystem;
    name: string;
    version: string;
}

export interface DepsDevPackageKey {
    system: PackageSystem;
    name: string;
}

export interface DepsDevVersion {
    versionKey: DepsDevVersionKey;
    publishedAt?: string;
    isDefault?: boolean;
    isDeprecated?: boolean;
    deprecationReason?: string;
}

export interface DepsDevPackage {
    packageKey: DepsDevPackageKey;
    versions: DepsDevVersion[];
}

export interface DepsDevLink {
    label: string;
    url: string;
}

export interface DepsDevAdvisory {
    id: string;
}

export interface DepsDevVersionInfo {
    versionKey: DepsDevVersionKey;
    publishedAt?: string;
    isDefault?: boolean;
    isDeprecated?: boolean;
    deprecationReason?: string;
    licenses?: string[];
    advisories?: DepsDevAdvisory[];
    links?: DepsDevLink[];
}

const inFlightCache = new Map<string, Promise<DepsDevPackage | DepsDevVersionInfo>>();

function encodePackageName(name: string): string {
    return encodeURIComponent(name).replace(/%2F/g, '%252F');
}

function systemToString(system: PackageSystem): string {
    return system.toLowerCase();
}

export async function fetchPackage(system: PackageSystem, name: string): Promise<DepsDevPackage> {
    const cacheKey = `depsdev:package:${system}:${name}`;

    if (inFlightCache.has(cacheKey)) {
        return inFlightCache.get(cacheKey)! as Promise<DepsDevPackage>;
    }

    const fetchAndCache = async (): Promise<DepsDevPackage> => {
        try {
            return await withRetry(async () => {
                const encodedName = encodePackageName(name);
                const systemStr = systemToString(system);
                const url = `https://api.deps.dev/v3/systems/${systemStr}/packages/${encodedName}`;
                
                const res = await fetch(url);
                
                if (res.status >= 400 && res.status < 500) {
                    throw new PermanentError(`Package "${name}" not found in deps.dev (${res.status})`);
                }
                
                if (!res.ok) {
                    throw new Error(`Failed to fetch package from deps.dev: ${res.statusText} (${res.status})`);
                }
                
                const data = await res.json() as DepsDevPackage;
                
                await PersistentCache.setRegistry(cacheKey, data);
                
                return data;
            });
        } catch (err) {
            inFlightCache.delete(cacheKey);
            throw err;
        }
    };

    const promise = PersistentCache.getOrComputeRegistry(cacheKey, fetchAndCache);
    inFlightCache.set(cacheKey, promise);
    return promise;
}

export async function fetchVersionInfo(
    system: PackageSystem,
    name: string,
    version: string
): Promise<DepsDevVersionInfo> {
    const cacheKey = `depsdev:version:${system}:${name}:${version}`;

    if (inFlightCache.has(cacheKey)) {
        return inFlightCache.get(cacheKey)! as Promise<DepsDevVersionInfo>;
    }

    const fetchAndCache = async (): Promise<DepsDevVersionInfo> => {
        try {
            return await withRetry(async () => {
                const encodedName = encodePackageName(name);
                const encodedVersion = encodeURIComponent(version);
                const systemStr = systemToString(system);
                const url = `https://api.deps.dev/v3/systems/${systemStr}/packages/${encodedName}/versions/${encodedVersion}`;
                
                const res = await fetch(url);
                
                if (res.status >= 400 && res.status < 500) {
                    throw new PermanentError(`Version "${version}" of package "${name}" not found in deps.dev (${res.status})`);
                }
                
                if (!res.ok) {
                    throw new Error(`Failed to fetch version from deps.dev: ${res.statusText} (${res.status})`);
                }
                
                const data = await res.json() as DepsDevVersionInfo;
                
                await PersistentCache.setRegistry(cacheKey, data);
                
                return data;
            });
        } catch (err) {
            inFlightCache.delete(cacheKey);
            throw err;
        }
    };

    const promise = PersistentCache.getOrComputeRegistry(cacheKey, fetchAndCache);
    inFlightCache.set(cacheKey, promise);
    return promise;
}

export function getSecurityAdvisories(versionInfo: DepsDevVersionInfo): string[] {
    return versionInfo.advisories?.map(a => a.id) || [];
}

export function getSPDXLicenses(versionInfo: DepsDevVersionInfo): string[] {
    return versionInfo.licenses || [];
}
