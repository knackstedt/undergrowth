import { describe, expect, it } from 'vitest';
import {
    buildPackageIdentifier,
    decodeCompareState,
    decodeFilters,
    decodeViewport,
    encodeCompareState,
    encodeFilters,
    encodeViewport,
    parsePackageVersion
} from './urlState';
import type { WarningToggles } from '../components/WarningTogglesPanel';

const baseToggles: WarningToggles = {
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
    staleTopLevel: false
};

describe('encodeFilters/decodeFilters round-trip', () => {
    it('round-trips default filters', () => {
        const decoded = decodeFilters(encodeFilters(baseToggles));
        expect(decoded).not.toBeNull();
        expect(decoded!.filters).toEqual({ ...baseToggles, nonOsiLicense: { enabled: false, licenses: '' } });
        expect(decoded!.showPeerDeps).toBe(false);
    });

    it('round-trips all flags set', () => {
        const toggles: WarningToggles = {
            maxDependencies: { enabled: true, value: 42 },
            singleMaintainer: true,
            prerelease: true,
            esmOnly: true,
            cjsOnly: true,
            noRecentUpdates: { enabled: true, months: 6 },
            hasAvailableUpdates: true,
            unstableVersion: true,
            suspiciousVersion: true,
            nonOsiLicense: { enabled: true, licenses: 'MIT,Apache-2.0' },
            staleTopLevel: true
        };
        const decoded = decodeFilters(encodeFilters(toggles, true));
        expect(decoded).not.toBeNull();
        const f = decoded!.filters;
        expect(f.maxDependencies).toEqual({ enabled: true, value: 42 });
        expect(f.singleMaintainer).toBe(true);
        expect(f.prerelease).toBe(true);
        expect(f.esmOnly).toBe(true);
        expect(f.cjsOnly).toBe(true);
        expect(f.noRecentUpdates).toEqual({ enabled: true, months: 6 });
        expect(f.hasAvailableUpdates).toBe(true);
        expect(f.unstableVersion).toBe(true);
        expect(f.suspiciousVersion).toBe(true);
        expect(f.nonOsiLicense.enabled).toBe(true);
        expect(f.staleTopLevel).toBe(true);
        expect(decoded!.showPeerDeps).toBe(true);
    });

    it('preserves maxDependencies values above 31 (7-bit field)', () => {
        // Regression: values used to be clamped to 31 on encode
        const toggles = { ...baseToggles, maxDependencies: { enabled: true, value: 100 } };
        const decoded = decodeFilters(encodeFilters(toggles));
        expect(decoded!.filters.maxDependencies.value).toBe(100);
    });

    it('does not bleed esmOnly into cjsOnly', () => {
        // Regression: cjsOnly used to be written to two bits
        const onlyEsm = { ...baseToggles, esmOnly: true };
        const onlyCjs = { ...baseToggles, cjsOnly: true };
        expect(decodeFilters(encodeFilters(onlyEsm))!.filters.cjsOnly).toBe(false);
        expect(decodeFilters(encodeFilters(onlyCjs))!.filters.esmOnly).toBe(false);
    });

    it('returns null for garbage input', () => {
        expect(decodeFilters('!!!not-base64!!!')).toBeNull();
    });
});

describe('encodeViewport/decodeViewport round-trip', () => {
    it('round-trips x/y/zoom as float32', () => {
        const vp = { x: 123.5, y: -456.25, zoom: 1.5 };
        const decoded = decodeViewport(encodeViewport(vp));
        expect(decoded).not.toBeNull();
        expect(decoded!.x).toBeCloseTo(vp.x, 5);
        expect(decoded!.y).toBeCloseTo(vp.y, 5);
        expect(decoded!.zoom).toBeCloseTo(vp.zoom, 5);
    });
});

describe('parsePackageVersion', () => {
    it('parses bare names', () => {
        expect(parsePackageVersion('lodash')).toEqual({ name: 'lodash', version: '' });
    });

    it('parses npm @version syntax', () => {
        expect(parsePackageVersion('react@18.2.0')).toEqual({ name: 'react', version: '18.2.0' });
        expect(parsePackageVersion('@types/react@18.2.0')).toEqual({ name: '@types/react', version: '18.2.0' });
    });

    it('parses PEP 440 operators', () => {
        expect(parsePackageVersion('requests>=2.0')).toEqual({ name: 'requests', version: '>=2.0' });
        expect(parsePackageVersion('flask==2.0.1')).toEqual({ name: 'flask', version: '==2.0.1' });
    });
});

describe('buildPackageIdentifier', () => {
    it('joins name and version', () => {
        expect(buildPackageIdentifier('react', '18.2.0')).toBe('react@18.2.0');
        expect(buildPackageIdentifier('react')).toBe('react');
        expect(buildPackageIdentifier('react', '')).toBe('react');
    });
});

describe('encodeCompareState/decodeCompareState round-trip', () => {
    it('round-trips a comparison spec', () => {
        const state = {
            ecosystem: 'npm' as const,
            oldPackage: 'react',
            oldVersion: '17.0.0',
            newPackage: 'react',
            newVersion: '18.2.0'
        };
        expect(decodeCompareState(encodeCompareState(state))).toEqual(state);
    });

    it('rejects invalid ecosystems', () => {
        expect(decodeCompareState('aW52YWxpZHxhfGI')).toBeNull(); // "invalid|a|b"
    });
});
