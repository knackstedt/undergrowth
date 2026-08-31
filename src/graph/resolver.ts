import { fetchPackageMeta } from '../api/npm';
import { enrichBulkWithDepsDevData } from '../utils/depsdev-enrichment';
import { isPrerelease } from './timeline';

export type DependencySource = 'npm' | 'pypi' | 'crates' | 'go' | 'nuget' | 'github' | 'gitlab' | 'bitbucket' | 'external' | 'other';

// In memory representation of the graph
export interface GraphNodeData {
    id: string; // "react@18.2.0"
    pkgName: string; // "react"
    version: string;
    description: string;
    downloads?: number;
    maintainers: number;
    lastPublish: string;
    dependencies: Record<string, string>;
    isRoot?: boolean;
    readme?: string;
    deprecated?: boolean;
    moduleType?: 'cjs' | 'esm' | 'both';
    isOutdated?: boolean;
    isPrereleaseAvailable?: boolean;
    /** Latest stable version available (if outdated) */
    latestVersion?: string;
    /** Sorted list of newer stable versions (if outdated) */
    newerVersions?: string[];
    /** Sorted list of newer prerelease versions (if prerelease available) */
    prereleaseVersions?: string[];
    isPeer?: boolean;
    isPythonRoot?: boolean; // True when this is a requirements.txt root node
    source?: DependencySource;
    /** Status of the node: 'pending' | 'ready' | 'error' - shows if data is still being fetched */
    status?: 'pending' | 'ready' | 'error';
    /** True if this package could not be resolved from the npm registry */
    isNotFound?: boolean;
    /** Package size in bytes (from npm dist.unpackedSize) */
    size?: number;
    /** Package license (SPDX identifier or custom string) */
    license?: string;
    /** True if this is a direct dependency of the root package */
    isDirectDep?: boolean;
    /** SPDX licenses from deps.dev (more accurate than registry data) */
    spdxLicenses?: string[];
    /** Security advisories from deps.dev */
    depsDevAdvisories?: string[];
    /** External links from deps.dev */
    externalLinks?: Array<{ label: string; url: string; }>;
    /** True if this package is a micropackage (small footprint, narrow scope) */
    isMicropackage?: boolean;
}

/** Size threshold for micropackages in bytes (6KB default) */
export const MICROPACKAGE_SIZE_THRESHOLD = 6144;

export interface ResolvedGraph {
    nodes: Map<string, GraphNodeData>;
    edges: Array<{ source: string; target: string; type: 'dependency' | 'peer' | 'dev' | 'extra'; }>;
    errors: Array<{ pkg: string; error: string; }>;
    cycles: string[][];
}

import semver from 'semver';

// Resolve a version string against available versions
export function resolveVersion(versionDef: string, availableVersions: string[]): string {
    // fast path for explicit versions
    if (availableVersions.includes(versionDef)) return versionDef;

    // semver resolution
    // find the highest version that satisfies the range
    const valid = availableVersions.filter(v => semver.valid(v) && semver.satisfies(v, versionDef));
    if (valid.length === 0) {
        // Cannot satisfy, return latest fallback or just the exact string requested
        return availableVersions[availableVersions.length - 1] || versionDef;
    }
    return valid.sort(semver.rcompare)[0];
}

export function detectSource(_name: string, version: string): DependencySource {
    if (version.startsWith('github:')) return 'github';
    if (version.startsWith('gitlab:')) return 'gitlab';
    if (version.startsWith('bitbucket:')) return 'bitbucket';

    // URLs
    if (version.includes('github.com')) return 'github';
    if (version.includes('gitlab.com')) return 'gitlab';
    if (version.includes('bitbucket.org')) return 'bitbucket';

    if (version.startsWith('http')) return 'external';
    if (version.startsWith('git+') || version.startsWith('git:')) return 'external';

    // If it looks like a semver range or 'latest', it's likely npm
    if (semver.validRange(version) || version === 'latest' || version === 'local') return 'npm';

    // Fallback for everything else that isn't clearly npm
    if (version.includes(':') || version.includes('/')) return 'other';

    return 'npm';
}

function detectDependencyCycles(
    nodes: Map<string, GraphNodeData>,
    edges: Array<{ source: string; target: string; type: 'dependency' | 'peer' | 'dev' | 'extra'; }>
): string[][] {
    const adjacency = new Map<string, string[]>();
    for (const nodeId of nodes.keys()) {
        adjacency.set(nodeId, []);
    }

    for (const edge of edges) {
        if (!adjacency.has(edge.source) || !adjacency.has(edge.target)) continue;
        adjacency.get(edge.source)!.push(edge.target);
    }

    const state = new Map<string, 0 | 1 | 2>();
    const stack: string[] = [];
    const stackIndex = new Map<string, number>();
    const uniqueCycles = new Map<string, string[]>();

    const canonicalize = (cycle: string[]): { key: string; ordered: string[]; } => {
        const variants: string[] = [];
        const reversed = [...cycle].reverse();

        for (let i = 0; i < cycle.length; i++) {
            variants.push([...cycle.slice(i), ...cycle.slice(0, i)].join('->'));
            variants.push([...reversed.slice(i), ...reversed.slice(0, i)].join('->'));
        }

        const key = variants.sort()[0];
        return { key, ordered: key.split('->') };
    };

    const visit = (nodeId: string) => {
        state.set(nodeId, 1);
        stackIndex.set(nodeId, stack.length);
        stack.push(nodeId);

        for (const next of adjacency.get(nodeId) || []) {
            const nextState = state.get(next) || 0;

            if (nextState === 0) {
                visit(next);
                continue;
            }

            if (nextState !== 1) {
                continue;
            }

            const start = stackIndex.get(next);
            if (start === undefined) continue;

            const cycleCore = stack.slice(start);
            const { key, ordered } = canonicalize(cycleCore);
            uniqueCycles.set(key, [...ordered, ordered[0]]);
        }

        stack.pop();
        stackIndex.delete(nodeId);
        state.set(nodeId, 2);
    };

    for (const nodeId of adjacency.keys()) {
        if ((state.get(nodeId) || 0) === 0) {
            visit(nodeId);
        }
    }

    return Array.from(uniqueCycles.values());
}

export type ProgressCallback = (resolved: number, total: number) => void;

export interface ResolverOptions {
    showPeerDeps?: boolean;
}

async function runBfsResolution(
    graph: ResolvedGraph,
    queue: Array<{ name: string; versionDef: string; parentId: string | null; isPeer?: boolean; }>,
    options: ResolverOptions = {},
    onProgress?: ProgressCallback
): Promise<void> {
    const inProgress = new Set<string>();
    let resolved = 0;
    let total = queue.length;

    const processQueue = async () => {
        const CONCURRENCY = 10;
        const batch = queue.splice(0, CONCURRENCY);

        await Promise.all(batch.map(async ({ name, versionDef, parentId, isPeer }) => {
            let resolvedVersion = versionDef;

            try {
                const meta = await fetchPackageMeta(name);

                const versions = Object.keys(meta.versions);
                if (versionDef === 'latest') {
                    resolvedVersion = meta['dist-tags'].latest || versions[versions.length - 1];
                } else {
                    resolvedVersion = resolveVersion(versionDef, versions);
                }

                const nodeId = `${name}@${resolvedVersion}`;

                if (parentId) {
                    const edgeType = isPeer ? 'peer' : 'dependency';
                    if (!graph.edges.find(e => e.source === parentId && e.target === nodeId)) {
                        graph.edges.push({ source: parentId, target: nodeId, type: edgeType });
                    }
                }

                if (graph.nodes.has(nodeId) || inProgress.has(nodeId)) {
                    resolved++;
                    onProgress?.(resolved, total);
                    return;
                }

                inProgress.add(nodeId);

                const pkgData = meta.versions[resolvedVersion];
                if (!pkgData) {
                    throw new Error(`Version ${resolvedVersion} not found for ${name}`);
                }

                const dependencies = pkgData.dependencies || {};

                // Detect module type from exports, type field, or main/module
                let moduleType: 'cjs' | 'esm' | 'both' | undefined;
                const hasEsm = pkgData.module || pkgData.exports?.import || (pkgData.type === 'module');
                const hasCjs = pkgData.main || pkgData.exports?.require || (!pkgData.type || pkgData.type === 'commonjs');
                if (hasEsm && hasCjs) moduleType = 'both';
                else if (hasEsm) moduleType = 'esm';
                else if (hasCjs) moduleType = 'cjs';

                // Check if parent is root to identify direct dependencies
                const isRoot = parentId === null;
                const isDirectDep = parentId ? (graph.nodes.get(parentId)?.isRoot ?? false) : false;

                // Build lists of newer versions for tooltip and detail panel first
                const allVersions = Object.keys(meta.versions);
                const newer = allVersions.filter(v => semver.valid(v) && semver.gt(v, resolvedVersion));
                const newerStable = newer.filter(v => !isPrerelease(v)).sort(semver.compare);
                const newerPrerelease = newer.filter(v => isPrerelease(v));

                // Check if package is outdated (only if semver-higher releases actually exist)
                const latestVersion = meta['dist-tags']?.latest;
                let isOutdated = false;
                let isPrereleaseAvailable = false;
                let newerVersions: string[] = [];
                let prereleaseVersions: string[] = [];
                if (latestVersion && resolvedVersion !== latestVersion && newer.length > 0) {
                    if (isPrerelease(latestVersion) && !isPrerelease(resolvedVersion)) {
                        isPrereleaseAvailable = true;
                    } else {
                        isOutdated = true;
                    }
                }

                // Condense versions: show latest of each newer major,
                // plus latest minor for current major, plus latest patch for current minor
                const parsed = semver.parse(resolvedVersion);
                const preByMajor = new Map<number, string>();
                let preLatestMinor: string | undefined;
                let preLatestPatch: string | undefined;
                for (const v of newerPrerelease) {
                    const p = semver.parse(v);
                    if (!p) continue;
                    if (p.major > (parsed?.major ?? 0)) {
                        const existing = preByMajor.get(p.major);
                        if (!existing || semver.gt(v, existing)) {
                            preByMajor.set(p.major, v);
                        }
                    } else if (p.major === (parsed?.major ?? 0) && p.minor > (parsed?.minor ?? 0)) {
                        if (!preLatestMinor || semver.gt(v, preLatestMinor)) {
                            preLatestMinor = v;
                        }
                    } else if (p.major === (parsed?.major ?? 0) && p.minor === (parsed?.minor ?? 0) && p.patch > (parsed?.patch ?? 0)) {
                        if (!preLatestPatch || semver.gt(v, preLatestPatch)) {
                            preLatestPatch = v;
                        }
                    }
                }
                prereleaseVersions = [...preByMajor.values(), ...(preLatestMinor ? [preLatestMinor] : []), ...(preLatestPatch ? [preLatestPatch] : [])].sort(semver.compare);

                const byMajor = new Map<number, string>();
                let latestMinor: string | undefined;
                let latestPatch: string | undefined;
                for (const v of newerStable) {
                    const p = semver.parse(v);
                    if (!p) continue;
                    if (p.major > (parsed?.major ?? 0)) {
                        const existing = byMajor.get(p.major);
                        if (!existing || semver.gt(v, existing)) {
                            byMajor.set(p.major, v);
                        }
                    } else if (p.major === (parsed?.major ?? 0) && p.minor > (parsed?.minor ?? 0)) {
                        if (!latestMinor || semver.gt(v, latestMinor)) {
                            latestMinor = v;
                        }
                    } else if (p.major === (parsed?.major ?? 0) && p.minor === (parsed?.minor ?? 0) && p.patch > (parsed?.patch ?? 0)) {
                        if (!latestPatch || semver.gt(v, latestPatch)) {
                            latestPatch = v;
                        }
                    }
                }
                newerVersions = [...byMajor.values(), ...(latestMinor ? [latestMinor] : []), ...(latestPatch ? [latestPatch] : [])].sort(semver.compare);

                // pkgData.license is already normalized to string by npm.ts fetchPackageMeta
                const licenseStr = pkgData.license;

                // DEBUG: Log license data for root packages
                if (isRoot) {
                    console.log(`[Resolver] Creating root node ${nodeId} with license:`, JSON.stringify(licenseStr));
                }

                const size = pkgData.dist?.unpackedSize;
                const fileCount = pkgData.dist?.fileCount;
                const hasSizeData = size !== undefined && size > 0;
                const isMicropackage = hasSizeData
                    ? size < MICROPACKAGE_SIZE_THRESHOLD
                    : (fileCount !== undefined && fileCount > 0 && fileCount <= 3);

                graph.nodes.set(nodeId, {
                    id: nodeId,
                    pkgName: name,
                    version: resolvedVersion,
                    description: pkgData.description || meta.description,
                    maintainers: meta.maintainers?.length || pkgData.maintainers?.length || 0,
                    lastPublish: meta.time?.[resolvedVersion] || meta.time?.modified || new Date().toISOString(),
                    dependencies: dependencies,
                    isRoot,
                    isPeer: isPeer || false,
                    readme: meta.readme,
                    source: detectSource(name, versionDef),
                    moduleType,
                    size,
                    license: licenseStr,
                    isDirectDep,
                    isOutdated: !!isOutdated,
                    isPrereleaseAvailable: !!isPrereleaseAvailable,
                    latestVersion: newerVersions.length > 0 ? newerVersions[newerVersions.length - 1] : undefined,
                    newerVersions: newerVersions.length > 0 ? newerVersions : undefined,
                    prereleaseVersions: prereleaseVersions.length > 0 ? prereleaseVersions : undefined,
                    isMicropackage
                });

                const newDeps = Object.entries(dependencies);
                total += newDeps.length;
                for (const [depName, depVersion] of newDeps) {
                    queue.push({ name: depName, versionDef: depVersion, parentId: nodeId });
                }

                if (options.showPeerDeps) {
                    const peerDeps = Object.entries(pkgData.peerDependencies || {});
                    total += peerDeps.length;
                    for (const [peerName, peerVersion] of peerDeps) {
                        queue.push({ name: peerName, versionDef: peerVersion, parentId: nodeId, isPeer: true });
                    }
                }
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : 'Unknown dependency resolution error';
                graph.errors.push({ pkg: name, error: message });

                // Root package failure — re-throw so the caller can show a dialog
                if (parentId === null) {
                    throw err;
                }

                // If this is a dependency (not the root), add a ghost "not found" node
                // so the graph still shows that something was expected here.
                const ghostId = `${name}@${versionDef}`;
                if (!graph.nodes.has(ghostId)) {
                    graph.nodes.set(ghostId, {
                        id: ghostId,
                        pkgName: name,
                        version: versionDef,
                        description: 'Package could not be resolved',
                        maintainers: 0,
                        lastPublish: new Date().toISOString(),
                        dependencies: {},
                        isNotFound: true,
                        source: detectSource(name, versionDef)
                    });
                    graph.edges.push({ source: parentId, target: ghostId, type: 'dependency' });
                } else if (!graph.edges.find(e => e.source === parentId && e.target === ghostId)) {
                    graph.edges.push({ source: parentId, target: ghostId, type: 'dependency' });
                }
            }

            resolved++;
            onProgress?.(resolved, total);
        }));
    };

    while (queue.length > 0) {
        await processQueue();
    }
}

/**
 * After BFS resolution, marks any node that is NOT reachable from a root node
 * purely via regular (non-peer) dependency edges as `isPeer = true`.
 * This ensures that descendants-only-via-peer-deps inherit the peer styling.
 */
function markPurelyPeerNodes(graph: ResolvedGraph): void {
    // BFS from all root nodes, following only non-peer edges
    const regularReachable = new Set<string>();
    const queue: string[] = [];

    for (const [id, node] of graph.nodes) {
        if (node.isRoot) queue.push(id);
    }

    while (queue.length > 0) {
        const nodeId = queue.shift()!;
        if (regularReachable.has(nodeId)) continue;
        regularReachable.add(nodeId);

        for (const edge of graph.edges) {
            if (edge.source === nodeId && edge.type !== 'peer') {
                queue.push(edge.target);
            }
        }
    }

    // Any non-root, non-ghost node that can only be reached via peer edges → isPeer
    for (const [id, node] of graph.nodes) {
        if (!regularReachable.has(id) && !node.isRoot && !node.isNotFound) {
            node.isPeer = true;
        }
    }
}

export async function resolveDependencyTree(
    rootPkg: string,
    rootVersion?: string,
    options?: ResolverOptions,
    onProgress?: ProgressCallback
): Promise<ResolvedGraph> {
    const graph: ResolvedGraph = {
        nodes: new Map(),
        edges: [],
        errors: [],
        cycles: []
    };

    const queue = [{ name: rootPkg, versionDef: rootVersion || 'latest', parentId: null as string | null }];
    await runBfsResolution(graph, queue, options, onProgress);

    if (options?.showPeerDeps) markPurelyPeerNodes(graph);
    graph.cycles = detectDependencyCycles(graph.nodes, graph.edges);
    return graph;
}

export interface LocalManifest {
    name: string;
    version?: string;
    description?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
}

export async function resolveDependencyTreeFromManifest(manifest: LocalManifest, options: ResolverOptions = {}, onProgress?: ProgressCallback): Promise<ResolvedGraph> {
    const graph: ResolvedGraph = {
        nodes: new Map(),
        edges: [],
        errors: [],
        cycles: []
    };

    const rootId = `${manifest.name}@${manifest.version || 'local'}`;
    const allDeps = { ...manifest.dependencies };

    graph.nodes.set(rootId, {
        id: rootId,
        pkgName: manifest.name,
        version: manifest.version || 'local',
        description: manifest.description || '',
        maintainers: 0,
        lastPublish: new Date().toISOString(),
        dependencies: allDeps,
        isRoot: true,
        source: 'npm' // Root from manifest is effectively the local npm package
    });

    const queue = Object.entries(allDeps).map(([name, versionDef]) => ({
        name,
        versionDef,
        parentId: rootId }));

    await runBfsResolution(graph, queue, options, onProgress);

    if (options?.showPeerDeps) markPurelyPeerNodes(graph);
    graph.cycles = detectDependencyCycles(graph.nodes, graph.edges);
    return graph;
}


/**
 * Enrich a resolved graph with metadata from deps.dev.
 * This provides enhanced license information and security advisories.
 * Should be called after dependency resolution is complete.
 */
export async function enrichGraphWithDepsDevData(graph: ResolvedGraph): Promise<void> {
    const nodesBySource = new Map<DependencySource, Map<string, GraphNodeData>>();
    
    for (const node of graph.nodes.values()) {
        if (!node.source || node.isNotFound) {
            continue;
        }
        
        if (!nodesBySource.has(node.source)) {
            nodesBySource.set(node.source, new Map());
        }
        
        nodesBySource.get(node.source)!.set(node.id, node);
    }
    
    const enrichmentPromises = Array.from(nodesBySource.entries()).map(([source, nodes]) => {
        return enrichBulkWithDepsDevData(nodes, source);
    });
    
    await Promise.allSettled(enrichmentPromises);
}

