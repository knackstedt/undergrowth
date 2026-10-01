import { extractGithubRepo, fetchBundleSize, fetchLibrariesIoInfo, fetchPackageFileList, fetchRepologyRepos, fetchRepoStats, isLibrariesIoEnabled } from '../api/external';
import { detectNativeFromFileList, mergeNativeDetections } from '../graph/native';
import type { GraphNodeData } from '../graph/resolver';

const ENRICHMENT_CONCURRENCY = 6;

/**
 * Best-effort external metadata feeds for rendered nodes: bundlephobia
 * bundle sizes (npm), ungh repository stats (GitHub-backed projects),
 * repology distro coverage, and libraries.io metrics when an API key is
 * configured. Runs over a bounded worker pool; individual feed failures
 * are swallowed so enrichment never blocks the graph.
 */
export async function enrichWithExternalMetadata(
    nodes: Map<string, GraphNodeData>,
    signal?: AbortSignal
): Promise<void> {
    const entries = Array.from(nodes.values()).filter(n => !n.isNotFound);
    const useLibrariesIo = isLibrariesIoEnabled();
    let cursor = 0;

    const worker = async () => {
        while (cursor < entries.length && !signal?.aborted) {
            const node = entries[cursor++];

            // Fall back to the deps.dev SOURCE_REPO link when the registry
            // itself didn't report a repository URL
            let repoUrl = node.repoUrl;
            if (!repoUrl && node.externalLinks) {
                repoUrl = node.externalLinks
                    .find(l => /github\.com|gitlab\.com|bitbucket\.org/.test(l.url))?.url;
                if (repoUrl) node.repoUrl = repoUrl;
            }

            const tasks: Promise<void>[] = [];

            if (node.source === 'npm') {
                tasks.push(fetchBundleSize(node.pkgName, node.version, signal).then(size => {
                    if (size) node.bundleSize = size;
                }));
                // File-listing pass catches .wasm/.node payloads that leave
                // no trace in registry metadata (e.g. @dqbd/tiktoken)
                tasks.push(fetchPackageFileList(node.pkgName, node.version, signal).then(listing => {
                    if (!listing) return;
                    const detected = detectNativeFromFileList(listing.paths);
                    if (detected.kinds.length === 0) return;
                    const merged = mergeNativeDetections(
                        { kinds: node.nativeKinds || [], details: node.nativeDetails || [] },
                        detected
                    );
                    node.nativeKinds = merged.kinds;
                    node.nativeDetails = merged.details;
                    node.nativeArtifacts = {
                        wasm: listing.paths.filter(p => /\.wasm$/i.test(p)).slice(0, 20),
                        addons: listing.paths.filter(p => /\.node$/i.test(p)).slice(0, 20),
                        other: listing.paths.filter(p => /\.(so|dylib|dll)$/i.test(p) || /(^|\/)binding\.gyp$/i.test(p)).slice(0, 20)
                    };
                }));
            }

            const gh = extractGithubRepo(repoUrl);
            if (gh) {
                tasks.push(fetchRepoStats(gh.owner, gh.repo, signal).then(stats => {
                    if (stats) node.repoStats = stats;
                }));
            }

            tasks.push(fetchRepologyRepos(node.pkgName, signal).then(repos => {
                if (repos.length > 0) node.distroRepos = repos;
            }));

            if (useLibrariesIo && node.source) {
                tasks.push(fetchLibrariesIoInfo(node.source, node.pkgName, signal).then(info => {
                    if (info) node.librariesIo = info;
                }));
            }

            await Promise.all(tasks);
        }
    };

    await Promise.all(
        Array.from({ length: Math.min(ENRICHMENT_CONCURRENCY, entries.length) }, () => worker())
    );
}
