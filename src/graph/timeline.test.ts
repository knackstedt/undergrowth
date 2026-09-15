import { describe, expect, it } from 'vitest';
import {
    calculateAnimationSpeed,
    compareGraphs,
    distillVersions,
    getVersionChangeLevel,
    isPrerelease
} from './timeline';
import type { ResolvedGraph } from './resolver';

function makeGraph(ids: Record<string, string>): ResolvedGraph {
    const nodes = new Map(Object.entries(ids).map(([id, pkgName]) => [id, {
        id,
        pkgName,
        version: id.split('@').pop() ?? '',
        description: '',
        maintainers: 0,
        lastPublish: '',
        dependencies: {}
    }]));
    return { nodes, edges: [], errors: [], cycles: [] };
}

describe('isPrerelease', () => {
    it('detects semver prereleases', () => {
        expect(isPrerelease('1.0.0-alpha.1')).toBe(true);
        expect(isPrerelease('1.0.0')).toBe(false);
        expect(isPrerelease('2.0.0-rc.1')).toBe(true);
    });
});

describe('getVersionChangeLevel', () => {
    it('classifies major/minor/patch/none', () => {
        expect(getVersionChangeLevel('1.0.0', '2.0.0')).toBe('major');
        expect(getVersionChangeLevel('1.0.0', '1.1.0')).toBe('minor');
        expect(getVersionChangeLevel('1.0.0', '1.0.1')).toBe('patch');
        expect(getVersionChangeLevel('1.0.0', '1.0.0')).toBe('none');
        expect(getVersionChangeLevel('bad', '1.0.0')).toBe('none');
    });
});

describe('distillVersions', () => {
    const mk = (version: string) => ({ version, date: '', isPrerelease: false });

    it('keeps all versions under the threshold', () => {
        const input = [mk('1.0.0'), mk('1.0.1'), mk('1.1.0')];
        expect(distillVersions(input)).toHaveLength(3);
    });

    it('collapses patch runs when there are many versions', () => {
        const input = Array.from({ length: 60 }, (_, i) => mk(`1.0.${i}`));
        const out = distillVersions(input);
        expect(out.length).toBeLessThan(60);
        expect(out[0].version).toBe('1.0.0');
    });
});

describe('calculateAnimationSpeed', () => {
    it('clamps between 500ms and 3000ms', () => {
        expect(calculateAnimationSpeed(2)).toBe(3000);
        expect(calculateAnimationSpeed(1000)).toBe(500);
        expect(calculateAnimationSpeed(120)).toBe(1500);
    });
});

describe('compareGraphs', () => {
    it('diffs added, removed, updated, and unchanged nodes', () => {
        const prev = makeGraph({
            'react@17.0.0': 'react',
            'lodash@4.17.20': 'lodash',
            'left-pad@1.0.0': 'left-pad'
        });
        const curr = makeGraph({
            'react@18.2.0': 'react',      // same pkgName, different version -> updated
            'lodash@4.17.20': 'lodash',   // identical -> unchanged
            'axios@1.0.0': 'axios'        // new package -> added
        });
        const diff = compareGraphs(prev, curr);
        expect(diff.added).toEqual(['axios@1.0.0']);
        expect(diff.updated).toEqual(['react@18.2.0']);
        expect(diff.unchanged).toEqual(['lodash@4.17.20']);
        // An updated package's old version node id is also reported as removed
        expect(diff.removed.sort()).toEqual(['left-pad@1.0.0', 'react@17.0.0']);
    });

    it('treats a null previous graph as all-added', () => {
        const curr = makeGraph({ 'a@1.0.0': 'a', 'b@2.0.0': 'b' });
        const diff = compareGraphs(null, curr);
        expect(diff.added.sort()).toEqual(['a@1.0.0', 'b@2.0.0']);
        expect(diff.removed).toEqual([]);
    });
});
