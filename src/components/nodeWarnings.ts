import type { GraphNodeData } from '../graph/resolver';
import type { WarningToggles } from './WarningTogglesPanel';

export type WarnableNodeData = Pick<GraphNodeData,
    'dependencies' | 'maintainers' | 'version' | 'moduleType' | 'lastPublish' | 'license' | 'isDirectDep' | 'isOutdated' | 'source'
> & { warningToggles?: WarningToggles; };

// Common OSI-approved license identifiers (SPDX and common variants).
// Module-level so the ~140-entry list isn't rebuilt per node render.
export const OSI_APPROVED_LICENSES: readonly string[] = [
    // Permissive
    'mit',
    'apache-2.0', 'apache 2.0', 'apache-2', 'apache license 2.0',
    'bsd-2-clause', 'bsd 2-clause', 'bsd2',
    'bsd-3-clause', 'bsd 3-clause', 'bsd3', 'new bsd', 'modified bsd',
    'bsd-0-clause', '0bsd', 'bsd-zero-clause',
    'isc',
    'zlib',
    'unlicense',
    'wtfpl',
    '0-clause bsd',
    // Copyleft
    'gpl-3.0', 'gpl 3.0', 'gpl-3', 'gpl3', 'gpl v3',
    'gpl-2.0', 'gpl 2.0', 'gpl-2', 'gpl2', 'gpl v2',
    'lgpl-3.0', 'lgpl 3.0', 'lgpl-3', 'lgpl3',
    'lgpl-2.1', 'lgpl 2.1', 'lgpl-2', 'lgpl2',
    'agpl-3.0', 'agpl 3.0', 'agpl-3', 'agpl3',
    // Mozilla
    'mpl-2.0', 'mpl 2.0', 'mpl-2', 'mpl2',
    'mpl-1.1', 'mpl 1.1',
    'mpl-1.0',
    // Creative Commons
    'cc0-1.0', 'cc0', 'cc0 1.0',
    // Other
    'epl-2.0', 'epl 2.0', 'eclipse',
    'epl-1.0', 'epl 1.0',
    'artistic-2.0', 'artistic 2.0',
    'artistic-1.0', 'perl',
    'artistic-1.0-perl', 'artistic-1.0-cl8',
    'cddl-1.0',
    'cpl',
    'ms-pl', 'microsoft public license',
    'ncsa',
    'openssl',
    'python-2.0', 'psf',
    'ofl-1.1',
    'vim',
    'eupl-1.2',
    'mulanpsl-2.0',
    'osl-3.0',
    'postgresql',
    'hpnd', 'historical permission notice',
    'upl-1.0', 'universal permissive',
    'bouncycastle',
    'icu',
    'nmap',
    'psfrag',
    'xnet', 'x11',
    'spencer-99',
    'smlnj',
    'standardml-nj',
    'wmfTOpng',
    'xskat',
    'zlib-acknowledgement',
    'torque-1.1',
    'termware',
    'scea',
    'rpsl-1.0',
    'rscpl',
    'ricoh-2.0',
    'python-2.0-complete',
    'python-2.0.1',
    'plexus',
    'php-3.0', 'php-3.01',
    'osl-2.1', 'osl-2.0', 'osl-1.1', 'osl-1.0',
    'omron',
    'naist-2003',
    'nasa-1.3',
    'motosoto',
    'mitre',
    'miros',
    'lucent-pl-1.02',
    'liliq-r-1.1', 'liliq-rplus-1.1',
    'lbnl-bsd',
    'jabber-pl-2.0', 'jabber-ospl',
    'intel',
    'imlib2',
    'iiprf-1.1',
    'ibm-pl-1.0',
    'hpnd-sell-variant',
    'hpnd-sell-regexpr',
    'hpnd-pbm',
    'hpnd-indekeenu',
    'hpnd-doc',
    'hpnd-doc-sell',
    'haskell-report',
    'gtkbook',
    'gnuplot',
    'giftware',
    'generalmotors-1.0',
    'freetype',
    'frameworx-1.0',
    'fsfap',
    'fsf-free',
    'fsfullr',
    'fsful',
    'eurosym',
    'erlpl-1.1',
    'entessa',
    'ecl-2.0', 'ecl-1.0',
    'dvipdfm',
    'dtoa',
    'dotseqn',
    'drl-1.1',
    'docbook',
    'djgpp',
    'diffmark',
    'curl',
    'cpol-1.02',
    'copyleft-next-0.3.1', 'copyleft-next-0.3',
    'cpal-1.0',
    'cnri-python', 'cnri-python-gpl-compatible',
    'clisp-exception-2.0',
    'cecill-2.1', 'cecill-2.0', 'cecill-1.1', 'cecill-b', 'cecill-c',
    'catosl-1.1',
    'caldera',
    'catharon',
    'bsl-1.0',
    'borceux',
    'blueoak-1.0.0',
    'bittorrent-1.1', 'bittorrent-1.0',
    'bitstream-vera',
    'apsl-2.0', 'apsl-1.2', 'apsl-1.1', 'apsl-1.0',
    'ampas',
    'amdkyl',
    'aladdin',
    'afmparse',
    'adsl',
    'adobe-2006', 'adobe-glyph',
    'abstyles',
    'aal',
    'rpl-1.5', 'rpl-1.1',
    'afl-3.0', 'afl-2.1', 'afl-2.0', 'afl-1.2', 'afl-1.1'
];

// Helper to check if last publish is older than X months
export function isOlderThanMonths(lastPublish: string, months: number): boolean {
    const publishDate = new Date(lastPublish);
    const cutoffDate = new Date();
    cutoffDate.setMonth(cutoffDate.getMonth() - months);
    return publishDate < cutoffDate;
}

// Check for unstable versions (0.x, obvious prereleases)
export function isUnstableVersion(version: string): boolean {
    // 0.x versions indicate pre-stable/rapid development
    const major = parseInt(version.split('.')[0]);
    if (major === 0) return true;
    // Standard prerelease indicators
    return /-(alpha|beta|rc|pre|canary|next|dev|snapshot|nightly)/i.test(version);
}

// Check for suspicious version patterns that deviate from conventions
export function isSuspiciousVersion(version: string, source?: string): boolean {
    // Universal checks for all ecosystems

    // Extremely long version strings
    if (version.length > 40) return true;

    // Null bytes, newlines, or other control characters
    if (version.includes('\x00') || version.includes('\n') || version.includes('\r') || version.includes('\t')) return true;

    // Unicode symbols (excluding standard ASCII used in semver)
    if (version.split('').some(c => c.charCodeAt(0) > 127)) return true;

    // Normalize for further checks
    const v = version.trim();
    const parts = v.split(/[-+]/); // Separate version core from prerelease/build
    const core = parts[0];
    const suffix = parts[1] || '';
    const buildMeta = v.includes('+') ? v.split('+')[1] : '';

    // Check core version components
    const segments = core.split('.');

    // NPM-specific patterns
    if (source === 'npm' || !source) {
        // Missing patch version (1.0 instead of 1.0.0)
        if (segments.length === 2) return true;

        // Extra version segments (1.0.0.1)
        if (segments.length > 3) return true;

        // Leading zeros (00001.0.0)
        for (const seg of segments) {
            if (seg.length > 1 && seg.startsWith('0')) return true;
        }

        // Suspicious numeric patterns
        const major = parseInt(segments[0]) || 0;
        const minor = parseInt(segments[1]) || 0;
        const patch = parseInt(segments[2]) || 0;

        // 0.0.0 - likely a publish issue
        if (major === 0 && minor === 0 && patch === 0) return true;

        // 999.999.999 - likely a hack/workaround
        if (major > 100 && minor > 100 && patch > 100) return true;

        // Date-like versions (20240315.x.x)
        if (/^\d{8}$/.test(segments[0])) return true;

        // Prerelease deviations
        if (suffix) {
            // 1.0.0-0 (numeric only prerelease is technically valid but suspicious)
            if (/^\d+$/.test(suffix)) return true;

            // Invalid labels (contains characters other than alphanumeric and dots)
            if (/[^a-zA-Z0-9.]/.test(suffix)) return true;
        }

        // Build metadata issues
        if (buildMeta) {
            // Build metadata should be after +
            if (!version.includes('+')) return true;
        }
    }

    // PyPI-specific patterns
    if (source === 'pypi') {
        // Missing components (1.0 instead of 1.0.0)
        if (segments.length < 3) return true;

        // Extra segments (1.0.0.0)
        if (segments.length > 3) return true;

        // Leading zeros (00001.0.0)
        for (const seg of segments) {
            if (seg.length > 1 && seg.startsWith('0') && /^\d+$/.test(seg)) return true;
        }

        // PyPI epoch markers (1!1.0.0) - unusual
        if (v.includes('!')) return true;

        // Development releases (1.0.0.dev0)
        if (/\.dev\d+$/i.test(v)) return true;

        // Post releases (1.0.0.post0)
        if (/\.post\d+$/i.test(v)) return true;

        // Pre-release with dash instead of dot (1.0-1)
        if (/^\d+\.\d+-\d+/.test(v)) return true;
    }

    // NuGet-specific patterns
    if (source === 'nuget') {
        // Missing components (1.0 instead of 1.0.0.0)
        if (segments.length < 4) return true;

        // Extra segments beyond 4
        if (segments.length > 4) return true;

        // Leading zeros
        for (const seg of segments) {
            if (seg.length > 1 && seg.startsWith('0') && /^\d+$/.test(seg)) return true;
        }

        // Prerelease without proper suffix (1.0.0-beta should be 1.0.0-beta.1)
        if (suffix && !/^\d+/.test(suffix.split('.')[1] || '')) return true;

        // Build metadata present (+buildmeta is valid but flag it as suspicious for review)
        if (buildMeta) return true;
    }

    return false;
}

// Check if license is open source friendly
export function isNonOsiLicense(license: string | undefined, allowedLicenses: string): boolean {
    // If no license data available (e.g., cached before license extraction), don't flag it
    // User can clear cache (F12 -> Application -> IndexedDB -> undergrowth-cache -> Clear) to refresh
    if (!license || license.trim() === '') return false;

    const licenseLower = license.toLowerCase().trim();

    // Check for explicit non-open-source indicators
    if (licenseLower === 'unlicensed' ||
        licenseLower.includes('proprietary') ||
        licenseLower.includes('commercial') ||
        licenseLower.includes('all rights reserved') ||
        licenseLower.includes('see license')) {
        return true;
    }

    if (!allowedLicenses.trim()) {
        // Check if any OSI-approved license is found in the license string
        const isApproved = OSI_APPROVED_LICENSES.some(l => licenseLower.includes(l));
        return !isApproved;
    }

    // Check against user-provided list
    const allowed = allowedLicenses.toLowerCase().split(',').map(l => l.trim());
    return !allowed.some(l => licenseLower.includes(l));
}

/** True if the node matches any active warning filter (red highlight). */
export function matchesWarningToggles(data: WarnableNodeData): boolean {
    const t = data.warningToggles;
    if (!t) return false;
    return (
        (t.maxDependencies.enabled && Object.keys(data.dependencies || {}).length > t.maxDependencies.value) ||
        (t.singleMaintainer && data.maintainers === 1) ||
        (t.prerelease && /-(alpha|beta|rc|pre|canary|next|dev)/i.test(data.version)) ||
        (t.esmOnly && data.moduleType === 'esm') ||
        (t.cjsOnly && data.moduleType === 'cjs') ||
        (t.noRecentUpdates?.enabled && isOlderThanMonths(data.lastPublish, t.noRecentUpdates.months)) ||
        (t.unstableVersion && isUnstableVersion(data.version)) ||
        (t.suspiciousVersion && isSuspiciousVersion(data.version, data.source)) ||
        (t.nonOsiLicense?.enabled && isNonOsiLicense(data.license, t.nonOsiLicense.licenses)) ||
        (t.staleTopLevel && !!data.isDirectDep && isOlderThanMonths(data.lastPublish, 24) && !!data.isOutdated)
    );
}

/** Human-readable explanations for each active warning on a node. */
export function collectWarningHighlights(data: WarnableNodeData): string[] {
    const t = data.warningToggles;
    if (!t) return [];
    const highlights: string[] = [];
    const depsCount = Object.keys(data.dependencies || {}).length;

    if (t.maxDependencies.enabled && depsCount > t.maxDependencies.value) {
        highlights.push(`Too many dependencies (${depsCount} > ${t.maxDependencies.value})`);
    }
    if (t.singleMaintainer && data.maintainers === 1) {
        highlights.push('Single maintainer');
    }
    if (t.prerelease && /-(alpha|beta|rc|pre|canary|next|dev)/i.test(data.version)) {
        highlights.push('Prerelease version');
    }
    if (t.esmOnly && data.moduleType === 'esm') {
        highlights.push('ESM only');
    }
    if (t.cjsOnly && data.moduleType === 'cjs') {
        highlights.push('CJS only');
    }
    if (t.noRecentUpdates?.enabled && isOlderThanMonths(data.lastPublish, t.noRecentUpdates.months)) {
        highlights.push(`No updates in ${t.noRecentUpdates.months} months`);
    }
    if (t.unstableVersion && isUnstableVersion(data.version)) {
        highlights.push('Unstable version (0.x or prerelease)');
    }
    if (t.suspiciousVersion && isSuspiciousVersion(data.version, data.source)) {
        highlights.push('Suspicious version pattern');
    }
    if (t.nonOsiLicense?.enabled && isNonOsiLicense(data.license, t.nonOsiLicense.licenses)) {
        highlights.push('Non-OSI license');
    }
    if (t.staleTopLevel && data.isDirectDep && isOlderThanMonths(data.lastPublish, 24) && data.isOutdated) {
        highlights.push('Stale top-level dependency');
    }
    return highlights;
}
