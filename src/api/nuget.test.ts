import { describe, expect, it } from 'vitest';
import { resolveNuGetVersion } from './nuget';

describe('resolveNuGetVersion', () => {
    // availableVersions must be sorted ascending — same as the API contract
    const versions = ['1.0.0', '1.5.0', '2.0.0', '2.5.0', '3.0.0'];

    it('returns latest for empty/wildcard ranges', () => {
        expect(resolveNuGetVersion('', versions)).toBe('3.0.0');
        expect(resolveNuGetVersion('*', versions)).toBe('3.0.0');
    });

    it('resolves exact plain versions', () => {
        expect(resolveNuGetVersion('1.5.0', versions)).toBe('1.5.0');
    });

    it('treats missing plain versions as a minimum bound', () => {
        expect(resolveNuGetVersion('1.2.0', versions)).toBe('3.0.0');
    });

    it('resolves inclusive ranges [min,max]', () => {
        expect(resolveNuGetVersion('[1.0.0,2.0.0]', versions)).toBe('2.0.0');
        expect(resolveNuGetVersion('[1.5.0,2.0.0]', versions)).toBe('2.0.0');
    });

    it('resolves exclusive ranges (min,max)', () => {
        expect(resolveNuGetVersion('(1.0.0,2.0.0)', versions)).toBe('1.5.0');
        expect(resolveNuGetVersion('(1.5.0,)', versions)).toBe('3.0.0');
    });

    it('resolves half-open ranges', () => {
        expect(resolveNuGetVersion('(,2.0.0]', versions)).toBe('2.0.0');
        expect(resolveNuGetVersion('(,2.0.0)', versions)).toBe('1.5.0');
        expect(resolveNuGetVersion('[2.0.0,)', versions)).toBe('3.0.0');
    });

    it('falls back to latest when the range matches nothing', () => {
        expect(resolveNuGetVersion('[9.0.0,10.0.0]', versions)).toBe('3.0.0');
    });
});
