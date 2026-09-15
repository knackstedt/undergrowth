import type { ProgressCallback, ResolvedGraph, ResolverOptions } from './resolver';
import type { FetchedManifest } from '../utils/fetchManifest';
import { enrichWithExternalMetadata } from '../utils/external-enrichment';

export type Ecosystem = 'npm' | 'pypi' | 'crates' | 'go' | 'nuget';

export const ECOSYSTEMS: Ecosystem[] = ['npm', 'pypi', 'crates', 'go', 'nuget'];

/**
 * Uniform interface over the five ecosystem resolvers. Each resolver module is
 * loaded lazily so the per-ecosystem code stays code-split.
 */
export interface EcosystemDriver {
    /** Resolve a package@version into a full dependency graph. */
    resolveTree(
        name: string,
        version: string | undefined,
        options: ResolverOptions,
        onProgress?: ProgressCallback
    ): Promise<ResolvedGraph>;
    /** Resolve a parsed manifest file (package.json, requirements.txt, ...). */
    resolveManifest(
        manifest: FetchedManifest,
        options: ResolverOptions,
        onProgress?: ProgressCallback
    ): Promise<ResolvedGraph>;
    /** Enrich a resolved graph with deps.dev metadata. */
    enrich(graph: ResolvedGraph, signal?: AbortSignal): Promise<void>;
}

/**
 * Run all enrichment passes over a resolved graph: the ecosystem's own
 * deps.dev enrichment plus the cross-ecosystem external metadata feeds
 * (bundlephobia, ungh, repology, libraries.io).
 */
export async function enrichGraph(driver: EcosystemDriver, graph: ResolvedGraph, signal?: AbortSignal): Promise<void> {
    await Promise.allSettled([
        driver.enrich(graph, signal),
        enrichWithExternalMetadata(graph.nodes, signal)
    ]);
}

export async function loadEcosystem(ecosystem: Ecosystem): Promise<EcosystemDriver> {
    switch (ecosystem) {
        case 'pypi': {
            const m = await import('./python-resolver');
            return {
                resolveTree: (name, version, options, onProgress) =>
                    m.resolvePythonDependencyTree(name, version || '*', options, onProgress),
                resolveManifest: (manifest, options, onProgress) => {
                    if (manifest?.type !== 'pypi') throw new Error(`Expected a pypi manifest`);
                    return m.resolvePythonDependencyTreeFromManifest(manifest.data, options, onProgress);
                },
                enrich: (graph, signal) => m.enrichPythonGraphWithDepsDevData(graph, signal),
            };
        }
        case 'crates': {
            const m = await import('./rust-resolver');
            return {
                resolveTree: (name, version, options, onProgress) =>
                    m.resolveRustDependencyTree(name, version || '*', options, onProgress),
                resolveManifest: (manifest, options, onProgress) => {
                    if (manifest?.type !== 'crates') throw new Error(`Expected a crates manifest`);
                    return m.resolveRustDependencyTreeFromManifest(manifest.data, options, onProgress);
                },
                enrich: (graph, signal) => m.enrichRustGraphWithDepsDevData(graph, signal),
            };
        }
        case 'go': {
            const m = await import('./go-resolver');
            return {
                resolveTree: (name, version, options, onProgress) =>
                    m.resolveGoDependencyTree(name, version || 'latest', options, onProgress),
                resolveManifest: (manifest, options, onProgress) => {
                    if (manifest?.type !== 'go') throw new Error(`Expected a go manifest`);
                    return m.resolveGoDependencyTreeFromManifest(manifest.data, options, onProgress);
                },
                enrich: (graph, signal) => m.enrichGoGraphWithDepsDevData(graph, signal),
            };
        }
        case 'nuget': {
            const m = await import('./csharp-resolver');
            return {
                resolveTree: (name, version, options, onProgress) =>
                    m.resolveCSharpDependencyTree(name, version || '*', undefined, options, onProgress),
                resolveManifest: (manifest, options, onProgress) => {
                    if (manifest?.type !== 'nuget') throw new Error(`Expected a nuget manifest`);
                    return m.resolveCSharpDependencyTreeFromManifest(manifest.data, options, onProgress);
                },
                enrich: (graph, signal) => m.enrichCSharpGraphWithDepsDevData(graph, signal),
            };
        }
        case 'npm':
        default: {
            const m = await import('./resolver');
            return {
                resolveTree: (name, version, options, onProgress) =>
                    m.resolveDependencyTree(name, version, options, onProgress),
                resolveManifest: (manifest, options, onProgress) => {
                    if (manifest?.type !== 'npm') throw new Error(`Expected a npm manifest`);
                    return m.resolveDependencyTreeFromManifest(manifest.data, options, onProgress);
                },
                enrich: (graph, signal) => m.enrichGraphWithDepsDevData(graph, signal),
            };
        }
    }
}
