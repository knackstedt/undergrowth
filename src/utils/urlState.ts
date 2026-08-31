import type { WarningToggles } from '../components/WarningTogglesPanel';

export interface ViewportState {
    x: number;
    y: number;
    zoom: number;
}

export interface URLState {
    ecosystem: 'npm' | 'pypi' | 'crates' | 'go' | 'nuget';
    package: string;
    version?: string;
    filters: WarningToggles;
    showPeerDeps: boolean;
    viewport: ViewportState;
    manifestUrl?: string;
    compare?: CompareState;
    micropackageThreshold?: number;
}

export interface CompareState {
    ecosystem: 'npm' | 'pypi' | 'crates' | 'go' | 'nuget';
    oldPackage: string;
    oldVersion?: string;
    newPackage: string;
    newVersion?: string;
}

/**
 * Parse a package identifier that may include a version (e.g., "react@18.2.0" or "requests>=2.28.0")
 * Returns the package name and version specifier (if present)
 */
export function parsePackageVersion(input: string): { name: string; version?: string } {
    // Handle npm/PyPI/Cargo version syntax
    // Patterns: pkg@version (npm/cargo), pkg==version, pkg>=version, pkg^version, pkg~version (PyPI/PEP 440)
    // Match: (scoped npm pkg OR regular name)(operator + version)?
    const match = input.match(/^(@[^/]+\/[^@]+|[^@>=^~<!]+)((?:@|>=|<=|==|~=|>|<|\^|~).+)?$/);
    if (!match) {
        return { name: input };
    }
    const name = match[1]?.trim() || input;
    // For @ syntax, strip it; otherwise keep the operator (>=, <=, ==, etc.)
    const versionSpec = match[2]?.trim() || '';
    const version = versionSpec.startsWith('@') ? versionSpec.slice(1) : versionSpec;
    return { name, version };
}

/**
 * Build a package identifier string from name and optional version
 */
export function buildPackageIdentifier(name: string, version?: string): string {
    if (!version) return name;
    return `${name}@${version}`;
}

/**
 * Pack filter toggles into a compressed byte array
 * Bits are packed as:
 * - bit 0: maxDependencies.enabled
 * - bit 1-5: maxDependencies.value (0-31, clamped)
 * - bit 6: singleMaintainer
 * - bit 7: (unused, was smallSize)
 * - bit 8: (unused)
 * - bit 9: prerelease
 * - bit 10: typedOnly
 * - bit 11: esmOnly
 * - bit 12: cjsOnly
 * - bit 13: showPeerDeps
 * - bit 14: noRecentUpdates.enabled
 * - bit 15-19: noRecentUpdates.months (0-31 months, scaled from actual)
 * - bit 20: hasAvailableUpdates
 * - bit 21: unstableVersion
 * - bit 22: suspiciousVersion
 * - bit 23: nonOsiLicense.enabled
 * - bit 24: staleTopLevel
 */
export function encodeFilters(filters: WarningToggles, showPeerDeps = false): string {
    let packed = 0;

    // Pack maxDependencies.enabled (1 bit)
    if (filters.maxDependencies.enabled) packed |= 1 << 0;

    // Pack maxDependencies.value (5 bits, clamped 0-31)
    const maxDepsValue = Math.min(31, Math.max(0, filters.maxDependencies.value));
    packed |= maxDepsValue << 1;

    // Pack remaining booleans
    if (filters.singleMaintainer) packed |= 1 << 6;
    if (filters.prerelease) packed |= 1 << 9;
    if (filters.esmOnly) packed |= 1 << 10;
    if (filters.cjsOnly) packed |= 1 << 11;
    if (filters.cjsOnly) packed |= 1 << 12;
    if (showPeerDeps) packed |= 1 << 13;

    // Pack new toggles
    if (filters.noRecentUpdates?.enabled) packed |= 1 << 14;
    const noRecentMonths = Math.min(31, Math.max(0, filters.noRecentUpdates?.months || 24));
    packed |= noRecentMonths << 15;
    if (filters.hasAvailableUpdates) packed |= 1 << 20;
    if (filters.unstableVersion) packed |= 1 << 21;
    if (filters.suspiciousVersion) packed |= 1 << 22;
    if (filters.nonOsiLicense?.enabled) packed |= 1 << 23;
    if (filters.staleTopLevel) packed |= 1 << 24;

    // Convert to base64url (URL-safe)
    return packNumberToBase64(packed);
}

export interface DecodedFilters {
    filters: WarningToggles;
    showPeerDeps: boolean;
}

/**
 * Decode filters from compressed string
 */
export function decodeFilters(encoded: string): DecodedFilters | null {
    try {
        const packed = unpackBase64ToNumber(encoded);
        if (packed === null) return null;

        return {
            filters: {
                maxDependencies: {
                    enabled: !!(packed & (1 << 0)),
                    value: (packed >> 1) & 0x1F, // 5 bits
                },
                singleMaintainer: !!(packed & (1 << 6)),
                prerelease: !!(packed & (1 << 9)),
                esmOnly: !!(packed & (1 << 10)),
                cjsOnly: !!(packed & (1 << 12)),
                // New toggles with defaults
                noRecentUpdates: {
                    enabled: !!(packed & (1 << 14)),
                    months: ((packed >> 15) & 0x1F) || 24,
                },
                hasAvailableUpdates: !!(packed & (1 << 20)),
                unstableVersion: !!(packed & (1 << 21)),
                suspiciousVersion: !!(packed & (1 << 22)),
                nonOsiLicense: {
                    enabled: !!(packed & (1 << 23)),
                    licenses: '',
                },
                staleTopLevel: !!(packed & (1 << 24)),
            },
            showPeerDeps: !!(packed & (1 << 13)),
        };
    } catch {
        return null;
    }
}

/**
 * Pack viewport (x, y, zoom) into a compressed string
 * Format: each value is encoded as float and packed together
 */
export function encodeViewport(viewport: ViewportState): string {
    // Pack x, y, zoom into a Float32Array and convert to base64
    const floats = new Float32Array([viewport.x, viewport.y, viewport.zoom]);
    const bytes = new Uint8Array(floats.buffer);
    return arrayBufferToBase64(bytes);
}

/**
 * Decode viewport from compressed string
 */
export function decodeViewport(encoded: string): ViewportState | null {
    try {
        const bytes = base64ToArrayBuffer(encoded);
        if (bytes.length !== 12) return null; // 3 floats * 4 bytes
        const floats = new Float32Array(bytes.buffer);
        return {
            x: floats[0],
            y: floats[1],
            zoom: floats[2],
        };
    } catch {
        return null;
    }
}

/**
 * Parse URL path and query params into state
 */
export function parseURLState(): Partial<URLState> | null {
    // Use hash-based routing: parse from hash fragment (without leading #)
    const hash = window.location.hash.slice(1) || '';
    const hashParts = hash.split('?');
    const path = hashParts[0] ? '/' + hashParts[0] : '';
    const search = hashParts[1] ? '?' + hashParts[1] : window.location.search;
    const params = new URLSearchParams(search);

    // Check for compare mode first
    const compareEncoded = params.get('compare');
    if (compareEncoded) {
        const compareState = decodeCompareState(compareEncoded);
        if (compareState) {
            // Parse filters
            const filtersEncoded = params.get('f');
            const decoded = filtersEncoded ? decodeFilters(filtersEncoded) : null;

            const mpt = params.get('mpt');
            return {
                ecosystem: compareState.ecosystem,
                package: compareState.oldPackage,
                version: compareState.oldVersion,
                compare: compareState,
                ...(decoded && { filters: decoded.filters, showPeerDeps: decoded.showPeerDeps }),
                ...(mpt && { micropackageThreshold: parseInt(mpt) * 1024 }),
            };
        }
    }

    // Check for manifest URL
    const manifestUrlEncoded = params.get('url');
    if (manifestUrlEncoded) {
        try {
            const manifestUrl = atob(manifestUrlEncoded);
            const ecosystem = (params.get('type') as 'npm' | 'pypi' | 'crates' | 'go' | 'nuget') || 'npm';

            // Parse filters
            const filtersEncoded = params.get('f');
            const decoded = filtersEncoded ? decodeFilters(filtersEncoded) : null;

            // Parse viewport
            const viewportEncoded = params.get('v');
            const viewport = viewportEncoded ? decodeViewport(viewportEncoded) : null;

            const mpt = params.get('mpt');
            return {
                ecosystem,
                package: manifestUrl.split('/').pop() || 'manifest',
                manifestUrl,
                ...(decoded && { filters: decoded.filters, showPeerDeps: decoded.showPeerDeps }),
                ...(viewport && { viewport }),
                ...(mpt && { micropackageThreshold: parseInt(mpt) * 1024 }),
            };
        } catch {
            // Invalid base64, fall through to normal parsing
        }
    }

    // Parse path: /ecosystem/package-name or /ecosystem/package-name@version
    // (path already has leading / prepended from hash parsing)
    const pathMatch = path.match(/^\/(npm|pypi|crates|go|nuget)\/(.+)$/);
    if (!pathMatch) return null;

    const ecosystem = pathMatch[1] as 'npm' | 'pypi' | 'crates' | 'go' | 'nuget';
    const rawPkg = decodeURIComponent(pathMatch[2]);
    const { name: pkg, version } = parsePackageVersion(rawPkg);

    // Parse filters
    const filtersEncoded = params.get('f');
    const decoded = filtersEncoded ? decodeFilters(filtersEncoded) : null;

    // Parse viewport
    const viewportEncoded = params.get('v');
    const viewport = viewportEncoded ? decodeViewport(viewportEncoded) : null;

    const mpt = params.get('mpt');
    return {
        ecosystem,
        package: pkg,
        version,
        ...(decoded && { filters: decoded.filters, showPeerDeps: decoded.showPeerDeps }),
        ...(viewport && { viewport }),
        ...(mpt && { micropackageThreshold: parseInt(mpt) * 1024 }),
    };
}

/**
 * Encode compare state for URL
 * Format: ecosystem|oldPackage[@oldVersion]|newPackage[@newVersion]
 */
export function encodeCompareState(state: CompareState): string {
    const oldIdentifier = buildPackageIdentifier(state.oldPackage, state.oldVersion);
    const newIdentifier = buildPackageIdentifier(state.newPackage, state.newVersion);
    const combined = `${state.ecosystem}|${oldIdentifier}|${newIdentifier}`;
    // Base64 encode to handle special characters
    return btoa(combined).replace(/=/g, '');
}

/**
 * Decode compare state from URL
 */
export function decodeCompareState(encoded: string): CompareState | null {
    try {
        // Add padding if needed
        const pad = (4 - (encoded.length % 4)) % 4;
        const padded = encoded + '='.repeat(pad);
        const decoded = atob(padded);
        const parts = decoded.split('|');
        if (parts.length !== 3) return null;

        const ecosystem = parts[0] as 'npm' | 'pypi' | 'crates' | 'go' | 'nuget';
        if (!['npm', 'pypi', 'crates', 'go', 'nuget'].includes(ecosystem)) return null;

        const { name: oldPackage, version: oldVersion } = parsePackageVersion(parts[1]);
        const { name: newPackage, version: newVersion } = parsePackageVersion(parts[2]);

        return {
            ecosystem,
            oldPackage,
            oldVersion,
            newPackage,
            newVersion
        };
    } catch {
        return null;
    }
}

/**
 * Build URL from state components
 */
export function buildURL(
    ecosystem: 'npm' | 'pypi' | 'crates' | 'go' | 'nuget',
    pkg: string,
    filters?: WarningToggles,
    viewport?: ViewportState,
    showPeerDeps?: boolean,
    version?: string,
    manifestUrl?: string,
    compare?: CompareState,
    micropackageThreshold?: number
): string {
    // If compare state is provided, use compare mode
    if (compare) {
        const params = new URLSearchParams();
        params.set('compare', encodeCompareState(compare));

        if (filters) {
            params.set('f', encodeFilters(filters, showPeerDeps));
        }
        if (micropackageThreshold !== undefined && micropackageThreshold !== 6144) {
            params.set('mpt', String(Math.round(micropackageThreshold / 1024)));
        }

        return `#?${params.toString()}`;
    }

    // If manifest URL is provided, use query parameter format
    if (manifestUrl) {
        const params = new URLSearchParams();
        params.set('url', btoa(manifestUrl));
        params.set('type', ecosystem);

        if (filters) {
            params.set('f', encodeFilters(filters, showPeerDeps));
        }
        if (micropackageThreshold !== undefined && micropackageThreshold !== 6144) {
            params.set('mpt', String(Math.round(micropackageThreshold / 1024)));
        }

        if (viewport) {
            params.set('v', encodeViewport(viewport));
        }

        return `#?${params.toString()}`;
    }

    const identifier = buildPackageIdentifier(pkg, version);
    const encodedPkg = encodeURIComponent(identifier);
    const path = `${ecosystem}/${encodedPkg}`;

    const params = new URLSearchParams();

    if (filters) {
        params.set('f', encodeFilters(filters, showPeerDeps));
    }
    if (micropackageThreshold !== undefined && micropackageThreshold !== 6144) {
        params.set('mpt', String(Math.round(micropackageThreshold / 1024)));
    }

    if (viewport) {
        params.set('v', encodeViewport(viewport));
    }

    const query = params.toString();
    return query ? `#${path}?${query}` : `#${path}`;
}

/**
 * Update browser URL without navigation
 */
export function updateURL(
    ecosystem: 'npm' | 'pypi' | 'crates' | 'go' | 'nuget',
    pkg: string,
    filters?: WarningToggles,
    viewport?: ViewportState,
    showPeerDeps?: boolean,
    version?: string,
    manifestUrl?: string,
    compare?: CompareState,
    micropackageThreshold?: number
): void {
    const url = buildURL(ecosystem, pkg, filters, viewport, showPeerDeps, version, manifestUrl, compare, micropackageThreshold);
    window.history.replaceState(null, '', url);
}

// Helper functions for base64 encoding/decoding

function packNumberToBase64(num: number): string {
    // Pack into bytes (up to 4 bytes for 32-bit int)
    const bytes: number[] = [];
    let n = num;
    do {
        bytes.push(n & 0x3F); // 6 bits at a time
        n >>= 6;
    } while (n > 0);

    // Encode to base64url
    return bytes.map(b => BASE64URL_CHARS[b]).join('');
}

function unpackBase64ToNumber(str: string): number | null {
    let result = 0;
    for (let i = 0; i < str.length; i++) {
        const idx = BASE64URL_CHARS.indexOf(str[i]);
        if (idx === -1) return null;
        result |= idx << (6 * i);
    }
    return result;
}

const BASE64URL_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function arrayBufferToBase64(buffer: Uint8Array): string {
    let result = '';
    for (let i = 0; i < buffer.length; i += 3) {
        const b1 = buffer[i];
        const b2 = buffer[i + 1] ?? 0;
        const b3 = buffer[i + 2] ?? 0;

        result += BASE64URL_CHARS[b1 >> 2];
        result += BASE64URL_CHARS[((b1 & 0x03) << 4) | (b2 >> 4)];
        if (i + 1 < buffer.length) {
            result += BASE64URL_CHARS[((b2 & 0x0F) << 2) | (b3 >> 6)];
        }
        if (i + 2 < buffer.length) {
            result += BASE64URL_CHARS[b3 & 0x3F];
        }
    }

    // Add padding chars removed, base64url doesn't use padding
    return result;
}

function base64ToArrayBuffer(str: string): Uint8Array {
    // Calculate expected length
    const pad = (4 - (str.length % 4)) % 4;
    const fullStr = str + '='.repeat(pad);

    const result: number[] = [];
    for (let i = 0; i < fullStr.length; i += 4) {
        const c1 = BASE64URL_CHARS.indexOf(fullStr[i]);
        const c2 = BASE64URL_CHARS.indexOf(fullStr[i + 1]);
        const c3 = BASE64URL_CHARS.indexOf(fullStr[i + 2]);
        const c4 = BASE64URL_CHARS.indexOf(fullStr[i + 3]);

        if (c1 === -1 || c2 === -1) continue;

        result.push((c1 << 2) | (c2 >> 4));
        if (c3 !== -1 && fullStr[i + 2] !== '=') {
            result.push(((c2 & 0x0F) << 4) | (c3 >> 2));
        }
        if (c4 !== -1 && fullStr[i + 3] !== '=') {
            result.push(((c3 & 0x03) << 6) | c4);
        }
    }

    return new Uint8Array(result);
}
