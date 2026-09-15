import { describe, expect, it } from 'vitest';
import {
    comparePythonVersions,
    parseRequirement,
    parseRequirementsTxt,
    resolvePythonVersion
} from './pypi';

describe('resolvePythonVersion', () => {
    const versions = ['1.0.0', '1.5.0', '2.0.0', '2.5.0', '2.9.9', '3.0.0', '3.1.0a1'];

    it('returns the latest stable for empty/wildcard specifiers', () => {
        expect(resolvePythonVersion(null, versions)).toBe('3.0.0');
        expect(resolvePythonVersion('*', versions)).toBe('3.0.0');
        expect(resolvePythonVersion('latest', versions)).toBe('3.0.0');
    });

    it('resolves compound specifiers respecting every clause', () => {
        // The old bug: ">=2.0,<3.0" was compared as a single version
        expect(resolvePythonVersion('>=2.0,<3.0', versions)).toBe('2.9.9');
        expect(resolvePythonVersion('>=1.0,<2.0', versions)).toBe('1.5.0');
        expect(resolvePythonVersion('>1.0.0,<=2.0.0', versions)).toBe('2.0.0');
    });

    it('handles ~= compatible-release clauses', () => {
        // ~=2.0 means >=2.0, ==2.*
        expect(resolvePythonVersion('~=2.0', versions)).toBe('2.9.9');
        // ~=2.0.0 means >=2.0.0, ==2.0.*
        expect(resolvePythonVersion('~=2.0.0', versions)).toBe('2.0.0');
    });

    it('handles != exclusion clauses', () => {
        expect(resolvePythonVersion('>=2.0,!=2.5.0,<3.0', versions)).toBe('2.9.9');
        expect(resolvePythonVersion('!=3.0.0', versions)).toBe('2.9.9');
    });

    it('handles wildcard equality', () => {
        expect(resolvePythonVersion('==2.*', versions)).toBe('2.9.9');
        expect(resolvePythonVersion('==1.5.*', versions)).toBe('1.5.0');
    });

    it('resolves exact pins', () => {
        expect(resolvePythonVersion('==1.5.0', versions)).toBe('1.5.0');
        expect(resolvePythonVersion('1.5.0', versions)).toBe('1.5.0');
    });

    it('prefers stable over prerelease when both satisfy', () => {
        expect(resolvePythonVersion('>=3.0', versions)).toBe('3.0.0');
    });

    it('uses prereleases when they are the only candidates', () => {
        // >=3.1 excludes 3.1.0a1 per PEP 440 (prerelease < its release)
        expect(resolvePythonVersion('>=3.1a0', versions)).toBe('3.1.0a1');
    });

    it('falls back to latest when nothing matches', () => {
        expect(resolvePythonVersion('>=99.0', versions)).toBe('3.0.0');
    });
});

describe('comparePythonVersions', () => {
    it('orders prereleases before finals', () => {
        expect(comparePythonVersions('1.0a1', '1.0b1')).toBe(-1);
        expect(comparePythonVersions('1.0b2', '1.0rc1')).toBe(-1);
        expect(comparePythonVersions('1.0rc1', '1.0')).toBe(-1);
        expect(comparePythonVersions('1.0', '1.0rc1')).toBe(1);
    });

    it('orders dev builds before their stage', () => {
        expect(comparePythonVersions('1.0.dev1', '1.0a1')).toBe(-1);
        expect(comparePythonVersions('1.0a1.dev1', '1.0a1')).toBe(-1);
    });

    it('orders post releases after finals', () => {
        expect(comparePythonVersions('1.0', '1.0.post1')).toBe(-1);
        expect(comparePythonVersions('1.0.post1', '1.0.1')).toBe(-1);
    });

    it('handles epochs', () => {
        expect(comparePythonVersions('1!1.0', '2.0')).toBe(1);
        expect(comparePythonVersions('1.0', '1!0.1')).toBe(-1);
    });

    it('treats missing release segments as zero', () => {
        expect(comparePythonVersions('1.0', '1.0.0')).toBe(0);
        expect(comparePythonVersions('1.2', '1.10')).toBe(-1);
    });

    it('strips local segments and leading v', () => {
        expect(comparePythonVersions('1.0+local.1', '1.0')).toBe(0);
        expect(comparePythonVersions('v1.0', '1.0')).toBe(0);
    });
});

describe('parseRequirement', () => {
    it('parses bare names', () => {
        expect(parseRequirement('requests')).toEqual({ name: 'requests', specifier: null, source: 'pypi' });
    });

    it('parses specifiers including extras', () => {
        expect(parseRequirement('requests>=2.0')).toEqual({ name: 'requests', specifier: '>=2.0', source: 'pypi' });
        expect(parseRequirement('pillow~=9.0')).toEqual({ name: 'pillow', specifier: '~=9.0', source: 'pypi' });
    });

    it('skips comments and option lines', () => {
        expect(parseRequirement('# comment')).toBeNull();
        expect(parseRequirement('-r other.txt')).toBeNull();
        expect(parseRequirement('')).toBeNull();
    });

    it('classifies git and url sources', () => {
        expect(parseRequirement('git+https://github.com/x/y.git')?.source).toBe('git');
        expect(parseRequirement('https://example.com/pkg-1.0.tar.gz')?.source).toBe('url');
    });
});

describe('parseRequirementsTxt', () => {
    it('parses a mixed file', () => {
        const deps = parseRequirementsTxt([
            'requests>=2.0',
            '# comment',
            'flask==2.0.1',
            '',
            'git+https://github.com/x/y.git',
            'numpy'
        ].join('\n'));
        expect(deps.map(d => d.name)).toEqual(['requests', 'flask', 'git+https://github.com/x/y.git', 'numpy']);
    });
});
