import { extractGithubRepo, fetchBundleSize, fetchLibrariesIoInfo, fetchRepologyRepos, fetchRepoStats, isLibrariesIoEnabled } from '../api/external';
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
