import { describe, expect, it } from 'vitest';
import { collectWarningHighlights, isNonOsiLicense, isSuspiciousVersion, isUnstableVersion, matchesWarningToggles, type WarnableNodeData } from './nodeWarnings';
import type { WarningToggles } from './WarningTogglesPanel';

const baseToggles = (overrides: Partial<WarningToggles> = {}): WarningToggles => ({
    maxDependencies: { enabled: false, value: 10 },
    singleMaintainer: false,
    prerelease: false,
    esmOnly: false,
    cjsOnly: false,
    noRecentUpdates: { enabled: false, months: 24 },
    hasAvailableUpdates: false,
    unstableVersion: false,
    suspiciousVersion: false,
    nonOsiLicense: { enabled: false, licenses: '' },
    staleTopLevel: false,
    ...overrides
});

const baseNode = (overrides: Partial<WarnableNodeData> = {}): WarnableNodeData => ({
    dependencies: {},
    maintainers: 3,
    version: '1.2.3',
    lastPublish: new Date().toISOString(),
    warningToggles: baseToggles(),
    ...overrides
});

describe('isUnstableVersion', () => {
    it('flags 0.x versions', () => {
        expect(isUnstableVersion('0.9.1')).toBe(true);
        expect(isUnstableVersion('1.0.0')).toBe(false);
    });

    it('flags prerelease suffixes', () => {
        expect(isUnstableVersion('1.0.0-beta.2')).toBe(true);
        expect(isUnstableVersion('2.0.0-rc.1')).toBe(true);
    });
});

describe('isSuspiciousVersion', () => {
    it('flags npm 4-segment versions and leading zeros', () => {
        expect(isSuspiciousVersion('1.0.0.1', 'npm')).toBe(true);
        expect(isSuspiciousVersion('01.0.0', 'npm')).toBe(true);
        expect(isSuspiciousVersion('1.2.3', 'npm')).toBe(false);
    });

    it('flags npm date-like majors', () => {
        expect(isSuspiciousVersion('20240315.0.0', 'npm')).toBe(true);
    });

    it('flags pypi epochs, dev and post releases', () => {
        expect(isSuspiciousVersion('1!2.0.0', 'pypi')).toBe(true);
        expect(isSuspiciousVersion('1.0.0.dev0', 'pypi')).toBe(true);
        expect(isSuspiciousVersion('1.0.0.post1', 'pypi')).toBe(true);
    });

    it('rejects control characters and non-ASCII', () => {
        expect(isSuspiciousVersion('1.0.0\x00', 'npm')).toBe(true);
        expect(isSuspiciousVersion('1.0.0-é', 'npm')).toBe(true);
    });
});

describe('isNonOsiLicense', () => {
    it('accepts common OSI licenses', () => {
        expect(isNonOsiLicense('MIT', '')).toBe(false);
        expect(isNonOsiLicense('Apache-2.0', '')).toBe(false);
        expect(isNonOsiLicense('(MIT OR Apache-2.0)', '')).toBe(false);
    });

    it('flags unknown and explicit non-OSI licenses', () => {
        expect(isNonOsiLicense('SomeCustomLicense', '')).toBe(true);
        expect(isNonOsiLicense('Proprietary', '')).toBe(true);
        expect(isNonOsiLicense('UNLICENSED', '')).toBe(true);
    });

    it('honours a user-provided allowlist', () => {
        expect(isNonOsiLicense('CC0-1.0', 'cc0-1.0, mit')).toBe(false);
        expect(isNonOsiLicense('GPL-3.0', 'mit, apache-2.0')).toBe(true);
    });

    it('does not flag missing license data', () => {
        expect(isNonOsiLicense(undefined, '')).toBe(false);
        expect(isNonOsiLicense('  ', '')).toBe(false);
    });
});

describe('matchesWarningToggles / collectWarningHighlights', () => {
    it('returns false and no highlights when all toggles are off', () => {
        const node = baseNode();
        expect(matchesWarningToggles(node)).toBe(false);
        expect(collectWarningHighlights(node)).toEqual([]);
    });

    it('matches maxDependencies and reports the count', () => {
        const deps = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`dep${i}`, '^1.0.0']));
        const node = baseNode({
            dependencies: deps,
            warningToggles: baseToggles({ maxDependencies: { enabled: true, value: 10 } })
        });
        expect(matchesWarningToggles(node)).toBe(true);
        expect(collectWarningHighlights(node)).toEqual(['Too many dependencies (15 > 10)']);
    });

    it('matches single maintainer and esmOnly', () => {
        const node = baseNode({
            maintainers: 1,
            moduleType: 'esm',
            warningToggles: baseToggles({ singleMaintainer: true, esmOnly: true })
        });
        expect(matchesWarningToggles(node)).toBe(true);
        expect(collectWarningHighlights(node)).toEqual(['Single maintainer', 'ESM only']);
    });
});
