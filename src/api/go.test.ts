import { describe, expect, it } from 'vitest';
import { isOptionalDependency, parseGoMod, resolveGoVersion } from './go';

describe('parseGoMod', () => {
    it('parses require blocks and marks indirect deps', () => {
        const deps = parseGoMod(`module example.com/myapp

go 1.21

require (
    github.com/some/pkg v1.2.3
    github.com/other/pkg v2.0.0 // indirect
)
`);
        expect(deps).toEqual([
            { path: 'github.com/some/pkg', version: 'v1.2.3', indirect: false },
            { path: 'github.com/other/pkg', version: 'v2.0.0', indirect: true }
        ]);
    });

    it('parses single-line requires', () => {
        const deps = parseGoMod(`module example.com/myapp
go 1.21
require github.com/single/pkg v1.0.0
`);
        expect(deps).toEqual([{ path: 'github.com/single/pkg', version: 'v1.0.0', indirect: false }]);
    });

    it('ignores replace/exclude/retract directives and comments', () => {
        const deps = parseGoMod(`module example.com/myapp

// a comment
replace example.com/orig => example.com/fork v1.0.0
exclude example.com/bad v1.0.0

require example.com/real v1.0.0
`);
        expect(deps).toEqual([{ path: 'example.com/real', version: 'v1.0.0', indirect: false }]);
    });
});

describe('resolveGoVersion', () => {
    const versions = ['v1.0.0', 'v1.2.0', 'v1.5.0', 'v2.0.0'];

    it('returns latest for empty/latest requirements', () => {
        expect(resolveGoVersion('', versions)).toBe('v2.0.0');
        expect(resolveGoVersion('latest', versions)).toBe('v2.0.0');
    });

    it('matches exact versions', () => {
        expect(resolveGoVersion('v1.2.0', versions)).toBe('v1.2.0');
    });

    it('adds the v prefix when missing', () => {
        expect(resolveGoVersion('1.5.0', versions)).toBe('v1.5.0');
    });

    it('passes pseudo-versions through unchanged', () => {
        const pseudo = 'v0.0.0-20240101120000-abcdef123456';
        expect(resolveGoVersion(pseudo, versions)).toBe(pseudo);
    });

    it('approximates MVS for missing versions (lowest >= requirement)', () => {
        expect(resolveGoVersion('v1.1.0', versions)).toBe('v1.2.0');
    });

    it('falls back to latest when nothing is >= requirement', () => {
        expect(resolveGoVersion('v9.9.9', versions)).toBe('v2.0.0');
    });
});

describe('isOptionalDependency', () => {
    it('flags indirect deps as optional', () => {
        expect(isOptionalDependency({ path: 'x', version: 'v1.0.0', indirect: true })).toBe(true);
        expect(isOptionalDependency({ path: 'x', version: 'v1.0.0', indirect: false })).toBe(false);
        expect(isOptionalDependency({ path: 'x', version: 'v1.0.0' })).toBe(false);
    });
});
