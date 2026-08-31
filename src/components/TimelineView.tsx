import type { Edge, Node } from '@xyflow/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { layoutGraph } from '../graph/layout';
import type { GraphNodeData, ResolvedGraph } from '../graph/resolver';
import { calculateAnimationSpeed, compareGraphs, convertToTimelineGraph, distillVersions, type TimelineVersion } from '../graph/timeline';
import { GraphView } from './GraphView';
import { LoadingOverlay } from './LoadingOverlay';
import { TimelineControls } from './TimelineControls';

interface TimelineViewProps {
    packageName: string;
    registry: 'npm' | 'pypi' | 'crates' | 'go' | 'nuget';
    versions: TimelineVersion[];
    fetchGraphForVersion: (version: string) => Promise<ResolvedGraph>;
    onClose: () => void;
}

export function TimelineView({
    packageName,
    registry,
    versions,
    fetchGraphForVersion,
    onClose
}: TimelineViewProps) {
    const [currentIndex, setCurrentIndex] = useState(0);
    const [isPlaying, setIsPlaying] = useState(false);
    const [animationSpeed, setAnimationSpeed] = useState(() => calculateAnimationSpeed(versions.length));
    const [isLoading, setIsLoading] = useState(false);
    const [loadingLabel, setLoadingLabel] = useState('');
    const [nodes, setNodes] = useState<Node<Record<string, unknown> & GraphNodeData & { timelineStatus: string; previousVersion?: string }>[]>([]);
    const [edges, setEdges] = useState<Edge[]>([]);
    const [fitViewSignal, setFitViewSignal] = useState(0);

    // Refs for animation state
    const playTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const isProcessingRef = useRef(false);
    const currentIndexRef = useRef(currentIndex);
    const isPlayingRef = useRef(isPlaying);
    const animationSpeedRef = useRef(animationSpeed);
    const previousStateRef = useRef<{
        nodes: Map<string, GraphNodeData>;
        edges: Array<{ source: string; target: string; type: 'dependency' | 'peer' | 'dev' | 'extra' }>;
        version: string;
    } | null>(null);

    // Preloading cache - stores node positions and complete edge data with ELK paths
    // Edge data includes path (startPoint, endPoint, bendPoints) needed for ElkEdge rendering
    const layoutCacheRef = useRef<Map<number, {
        nodePositions: Map<string, { x: number; y: number }>;
        edges: Array<{
            id: string;
            source: string;
            target: string;
            type: 'elk';
            animated?: boolean;
            style?: React.CSSProperties;
            data?: {
                type?: string;
                path?: {
                    startPoint: { x: number; y: number };
                    endPoint: { x: number; y: number };
                    bendPoints?: { x: number; y: number }[];
                };
            };
        }>;
    }>>(new Map());
    const preloadAbortRef = useRef<AbortController | null>(null);
    const [preloadProgress, setPreloadProgress] = useState({ loaded: 0, total: 0 });
    const [cachedIndices, setCachedIndices] = useState<Set<number>>(new Set());

    // Keep refs in sync with state
    useEffect(() => {
        currentIndexRef.current = currentIndex;
    }, [currentIndex]);

    useEffect(() => {
        isPlayingRef.current = isPlaying;
    }, [isPlaying]);

    useEffect(() => {
        animationSpeedRef.current = animationSpeed;
    }, [animationSpeed]);

    // Distill versions for display
    const distilledVersions = useRef(distillVersions(versions)).current;

    // Preload upcoming versions in background
    const preloadVersions = useCallback(async (startIndex: number) => {
        // Cancel any existing preload
        if (preloadAbortRef.current) {
            preloadAbortRef.current.abort();
        }
        const abortController = new AbortController();
        preloadAbortRef.current = abortController;

        // Preload next 50 versions (or remaining if fewer) - larger window for smoother animation
        const preloadCount = 50;
        const endIndex = Math.min(startIndex + preloadCount, distilledVersions.length);

        setPreloadProgress({ loaded: 0, total: endIndex - startIndex });

        for (let i = startIndex; i < endIndex; i++) {
            // Skip if already cached
            if (layoutCacheRef.current.has(i)) continue;

            // Check if aborted
            if (abortController.signal.aborted) return;

            try {
                const graph = await fetchGraphForVersion(distilledVersions[i].version);

                // Check if aborted before expensive layout
                if (abortController.signal.aborted) return;

                // Build previous state from cache if available
                const prevCached = i > 0 ? layoutCacheRef.current.get(i - 1) : null;
                const prevGraph = i > 0 ? await fetchGraphForVersion(distilledVersions[i - 1].version) : null;

                const diff = compareGraphs(
                    prevGraph
                        ? {
                            nodes: new Map([...prevGraph.nodes].map(([k, v]) => [k, v])),
                            edges: prevGraph.edges,
                            errors: [],
                            cycles: []
                        }
                        : null,
                    graph
                );

                const { nodes: flowNodes, edges: flowEdges } = convertToTimelineGraph(
                    graph,
                    diff,
                    prevCached ? {
                        nodes: new Map(), // Empty - we only need positions from cache
                        edges: prevCached.edges.map(e => ({
                            source: e.source,
                            target: e.target,
                            type: (e.type as 'dependency' | 'peer' | 'dev' | 'extra') || 'dependency'
                        })),
                        version: distilledVersions[i - 1]?.version || ''
                    } : null
                );

                // Run ELK layout
                const layout = await layoutGraph({
                    nodes: new Map(flowNodes.map(n => [n.id, n.data as GraphNodeData])),
                    edges: flowEdges.map(e => ({
                        source: e.source,
                        target: e.target,
                        type: (e.data?.type as 'dependency' | 'peer' | 'dev' | 'extra') || 'dependency'
                    })),
                    errors: [],
                    cycles: []
                });

                // Extract minimal data: positions and edges only
                const nodePositions = new Map<string, { x: number; y: number }>();
                for (const layoutNode of layout.nodes) {
                    nodePositions.set(layoutNode.id, layoutNode.position);
                }

                // Store complete edge data with ELK path data for proper rendering
                const fullEdges = layout.edges.map(e => ({
                    id: e.id || `${e.source}->${e.target}`,
                    source: e.source,
                    target: e.target,
                    type: 'elk' as const,
                    animated: e.animated,
                    style: e.style,
                    data: e.data
                }));

                // Store complete data in cache
                layoutCacheRef.current.set(i, {
                    nodePositions,
                    edges: fullEdges
                });

                // Update cached indices for UI
                setCachedIndices(prev => new Set([...prev, i]));

                setPreloadProgress(prev => ({ ...prev, loaded: prev.loaded + 1 }));
            } catch (error) {
                console.error(`Failed to preload version ${i}:`, error);
            }
        }
    }, [distilledVersions, fetchGraphForVersion]);

    // Load graph for current version (uses cache if available)
    const loadVersionGraph = useCallback(async (index: number) => {
        if (index < 0 || index >= distilledVersions.length) return;
        if (isProcessingRef.current) return;

        isProcessingRef.current = true;
        const version = distilledVersions[index];

        // Check layout cache first
        const cached = layoutCacheRef.current.get(index);
        if (cached) {
            setIsLoading(false); // No loading needed, we have positions cached
            setLoadingLabel(`v${version.version} (cached)`);

            // Fetch current and next version graphs for proper removed node handling
            const graph = await fetchGraphForVersion(version.version);
            const nextGraph = index < distilledVersions.length - 1
                ? await fetchGraphForVersion(distilledVersions[index + 1].version)
                : null;

            // Compare with previous state
            const prevGraph = previousStateRef.current
                ? { nodes: previousStateRef.current.nodes, edges: previousStateRef.current.edges }
                : null;

            const diff = compareGraphs(
                prevGraph
                    ? {
                        nodes: new Map([...prevGraph.nodes].map(([k, v]) => [k, v])),
                        edges: prevGraph.edges,
                        errors: [],
                        cycles: []
                    }
                    : null,
                graph
            );

            console.log(`[Timeline] Version ${version.version}:`, {
                previousNodeCount: prevGraph?.nodes.size || 0,
                currentNodeCount: graph.nodes.size,
                added: diff.added.length,
                removed: diff.removed.length,
                updated: diff.updated.length,
                unchanged: diff.unchanged.length,
                previousIds: prevGraph ? Array.from(prevGraph.nodes.keys()).slice(0, 5) : [],
                currentIds: Array.from(graph.nodes.keys()).slice(0, 5)
            });

            // Convert to get proper timeline status - pass nextGraph to mark nodes that will be removed
            const { nodes: flowNodes, edges: flowEdges } = convertToTimelineGraph(
                graph,
                diff,
                previousStateRef.current,
                nextGraph
            );

            console.log(`[Timeline] Flow nodes for ${version.version}:`,
                flowNodes.map(n => ({ id: n.id, status: n.data.timelineStatus })).slice(0, 10)
            );

            // Apply cached positions
            const positionedNodes = flowNodes.map(node => {
                const cachedPos = cached.nodePositions.get(node.id);
                return {
                    ...node,
                    position: cachedPos || { x: 0, y: 0 }
                };
            });

            // Use cached edges if available (they have proper ELK path data)
            // Otherwise fall back to flowEdges (which will trigger new layout)
            const cachedEdges = cached.edges.length > 0 ? cached.edges : flowEdges;

            setNodes(positionedNodes);
            setEdges(cachedEdges);

            // Update previous state reference - store actual graph nodes (not display nodes)
            // This is needed so the next version can detect updates by matching pkgName
            previousStateRef.current = {
                nodes: new Map(graph.nodes),
                edges: graph.edges,
                version: version.version
            };

            isProcessingRef.current = false;

            // Trigger fit view on first load or when there are large graph changes
            // (only count added/removed, not updated)
            const structuralChanged = diff.added.length + diff.removed.length;
            if (index === 0 || structuralChanged > 5) {
                setFitViewSignal(s => s + 1);
            }

            // Trigger preloading for next versions
            preloadVersions(index + 1);

            return;
        }

        // Not in cache - load normally with loading indicator
        setIsLoading(true);
        setLoadingLabel(`Loading v${version.version}...`);

        try {
            // Fetch current and next version graphs for proper removed node handling
            const graph = await fetchGraphForVersion(version.version);
            const nextGraph = index < distilledVersions.length - 1
                ? await fetchGraphForVersion(distilledVersions[index + 1].version)
                : null;

            // Compare with previous state
            const prevGraph = previousStateRef.current
                ? { nodes: previousStateRef.current.nodes, edges: previousStateRef.current.edges }
                : null;

            const diff = compareGraphs(
                prevGraph
                    ? {
                        nodes: new Map([...prevGraph.nodes].map(([k, v]) => [k, v])),
                        edges: prevGraph.edges,
                        errors: [],
                        cycles: []
                    }
                    : null,
                graph
            );

            console.log(`[Timeline] (non-cached) Version ${version.version}:`, {
                previousNodeCount: prevGraph?.nodes.size || 0,
                currentNodeCount: graph.nodes.size,
                added: diff.added.length,
                removed: diff.removed.length,
                updated: diff.updated.length,
                unchanged: diff.unchanged.length
            });

            // Convert to React Flow format with timeline status - pass nextGraph
            const { nodes: flowNodes, edges: flowEdges } = convertToTimelineGraph(
                graph,
                diff,
                previousStateRef.current,
                nextGraph
            );

            // Layout the graph
            const layout = await layoutGraph({
                nodes: new Map(flowNodes.map(n => [n.id, n.data as GraphNodeData])),
                edges: flowEdges.map(e => ({
                    source: e.source,
                    target: e.target,
                    type: (e.data?.type as 'dependency' | 'peer' | 'dev' | 'extra') || 'dependency'
                })),
                errors: [],
                cycles: []
            });

            // Update state with laid out nodes
            const positionedNodes = flowNodes.map(node => {
                const layoutNode = layout.nodes.find(n => n.id === node.id);
                return {
                    ...node,
                    position: layoutNode?.position || { x: 0, y: 0 }
                };
            });

            setNodes(positionedNodes);
            setEdges(layout.edges);

            // Extract and store complete data in cache including edge paths
            const nodePositions = new Map<string, { x: number; y: number }>();
            for (const node of positionedNodes) {
                nodePositions.set(node.id, node.position);
            }
            const fullEdges = layout.edges.map(e => ({
                id: e.id || `${e.source}->${e.target}`,
                source: e.source,
                target: e.target,
                type: 'elk' as const,
                animated: e.animated,
                style: e.style,
                data: e.data
            }));
            layoutCacheRef.current.set(index, {
                nodePositions,
                edges: fullEdges
            });

            // Update cached indices for UI
            setCachedIndices(prev => new Set([...prev, index]));

            // Update previous state reference - store actual graph nodes
            previousStateRef.current = {
                nodes: new Map(graph.nodes),
                edges: graph.edges,
                version: version.version
            };

            // Trigger fit view on first load or when there are large graph changes
            // (only count added/removed, not updated)
            const structuralChanged = diff.added.length + diff.removed.length;
            if (index === 0 || structuralChanged > 5) {
                setFitViewSignal(s => s + 1);
            }

            // Start preloading next versions
            preloadVersions(index + 1);
        } catch (error) {
            console.error('Failed to load version graph:', error);
        } finally {
            setIsLoading(false);
            isProcessingRef.current = false;
        }
    }, [distilledVersions, fetchGraphForVersion, preloadVersions]);

    // Reset when package changes
    useEffect(() => {
        // Clear all state for new package
        setCurrentIndex(0);
        setIsPlaying(false);
        setIsLoading(false);
        setNodes([]);
        setEdges([]);
        setCachedIndices(new Set());
        layoutCacheRef.current.clear();
        previousStateRef.current = null;
        isProcessingRef.current = false;

        // Clear any pending timeouts
        if (playTimeoutRef.current) {
            clearTimeout(playTimeoutRef.current);
            playTimeoutRef.current = null;
        }
        if (preloadAbortRef.current) {
            preloadAbortRef.current.abort();
            preloadAbortRef.current = null;
        }
    }, [packageName]);

    // Initial load
    useEffect(() => {
        loadVersionGraph(0);
    }, [loadVersionGraph]);

    // Handle play/pause animation
    useEffect(() => {
        if (!isPlaying) {
            if (playTimeoutRef.current) {
                clearTimeout(playTimeoutRef.current);
                playTimeoutRef.current = null;
            }
            return;
        }

        const scheduleNext = () => {
            playTimeoutRef.current = setTimeout(async () => {
                // Check refs instead of stale closure values
                const idx = currentIndexRef.current;
                if (!isPlayingRef.current || idx >= distilledVersions.length - 1) {
                    if (idx >= distilledVersions.length - 1) {
                        setIsPlaying(false);
                    }
                    return;
                }

                const nextIndex = idx + 1;
                setCurrentIndex(nextIndex);
                await loadVersionGraph(nextIndex);

                // Trigger preload for upcoming versions after advancing
                preloadVersions(nextIndex + 1);

                // Continue playing if still in play mode
                if (isPlayingRef.current) {
                    scheduleNext();
                }
            }, animationSpeedRef.current);
        };

        // Start playing
        scheduleNext();

        return () => {
            if (playTimeoutRef.current) {
                clearTimeout(playTimeoutRef.current);
                playTimeoutRef.current = null;
            }
        };
    // Only depend on isPlaying - use refs for other values to prevent effect restart
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isPlaying, loadVersionGraph]);

    // Handle seek
    const handleSeek = useCallback(async (index: number) => {
        // Pause when manually seeking
        setIsPlaying(false);

        // Reset previous state if going backwards (clear cache to recompute diffs)
        if (index < currentIndex) {
            previousStateRef.current = null;
            // Clear cache entries after this index since diff chain is broken
            const newCache = new Set(cachedIndices);
            for (let i = index + 1; i < distilledVersions.length; i++) {
                layoutCacheRef.current.delete(i);
                newCache.delete(i);
            }
            setCachedIndices(newCache);
        }

        setCurrentIndex(index);
        await loadVersionGraph(index);
        // Fit view after manually seeking to a version
        setFitViewSignal(s => s + 1);
    }, [currentIndex, loadVersionGraph, distilledVersions.length, cachedIndices]);

    const handlePlay = useCallback(() => {
        // If at the end, restart from beginning and clear cache
        if (currentIndex >= distilledVersions.length - 1) {
            setCurrentIndex(0);
            previousStateRef.current = null;
            layoutCacheRef.current.clear();
            setCachedIndices(new Set());
        }
        setIsPlaying(true);
    }, [currentIndex, distilledVersions.length]);

    const handlePause = useCallback(() => {
        setIsPlaying(false);
    }, []);

    const handleNodeClick = useCallback((nodeId: string | null) => {
        // Could show node details in a sidebar
        console.log('Timeline node clicked:', nodeId);
    }, []);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (preloadAbortRef.current) {
                preloadAbortRef.current.abort();
            }
        };
    }, []);

    // Sync cachedIndices with layoutCacheRef on mount (for already cached items)
    useEffect(() => {
        const indices = new Set(layoutCacheRef.current.keys());
        if (indices.size !== cachedIndices.size) {
            setCachedIndices(indices);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Background preloading of all versions (progressive, low priority)
    useEffect(() => {
        // Don't preload everything if there are too many versions (>20)
        if (distilledVersions.length > 20) return;

        // Progressive background loading of all versions
        const loadAll = async () => {
            for (let i = 0; i < distilledVersions.length; i++) {
                // Skip if already cached
                if (layoutCacheRef.current.has(i)) continue;

                // Small delay between loads to avoid overwhelming the system
                await new Promise(r => setTimeout(r, 200));

                // Load single version (don't use preloadVersions to avoid abort conflicts)
                try {
                    const version = distilledVersions[i];
                    const graph = await fetchGraphForVersion(version.version);

                    // Get previous version for diff if available
                    const prevGraph = i > 0 ? await fetchGraphForVersion(distilledVersions[i - 1].version) : null;

                    const diff = compareGraphs(
                        prevGraph ? { nodes: new Map(prevGraph.nodes), edges: prevGraph.edges, errors: [], cycles: [] } : null,
                        graph
                    );

                    const { nodes: flowNodes, edges: flowEdges } = convertToTimelineGraph(graph, diff, null);

                    const layout = await layoutGraph({
                        nodes: new Map(flowNodes.map(n => [n.id, n.data as GraphNodeData])),
                        edges: flowEdges.map(e => ({ source: e.source, target: e.target, type: (e.data?.type as 'dependency' | 'peer' | 'dev' | 'extra') || 'dependency' })),
                        errors: [],
                        cycles: []
                    });

                    const nodePositions = new Map<string, { x: number; y: number }>();
                    for (const layoutNode of layout.nodes) {
                        nodePositions.set(layoutNode.id, layoutNode.position);
                    }

                    const fullEdges = layout.edges.map(e => ({
                        id: e.id || `${e.source}->${e.target}`,
                        source: e.source,
                        target: e.target,
                        type: 'elk' as const,
                        animated: e.animated,
                        style: e.style,
                        data: e.data
                    }));

                    layoutCacheRef.current.set(i, { nodePositions, edges: fullEdges });
                    setCachedIndices(prev => new Set([...prev, i]));
                } catch (error) {
                    console.error(`Failed to background preload version ${i}:`, error);
                }
            }
        };

        // Start after initial load completes
        const timeout = setTimeout(loadAll, 2000);
        return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [distilledVersions.length, fetchGraphForVersion]);

    return (
        <div style={{
            width: '100%',
            height: '100%',
            position: 'relative'
        }}>
            {/* Header */}
            <div style={{
                position: 'absolute',
                top: '20px',
                left: '50%',
                transform: 'translateX(-50%)',
                zIndex: 50,
                display: 'flex',
                alignItems: 'center',
                gap: '16px',
                padding: '12px 24px',
                background: 'rgba(30, 41, 59, 0.9)',
                backdropFilter: 'blur(10px)',
                borderRadius: '12px',
                border: '1px solid var(--glass-border)'
            }}>
                <div>
                    <div style={{
                        fontSize: '14px',
                        fontWeight: 600,
                        color: 'var(--text-primary)'
                    }}>
                        {packageName}
                    </div>
                    <div style={{
                        fontSize: '11px',
                        color: 'var(--text-muted)'
                    }}>
                        Historical Timeline ({registry})
                        {preloadProgress.total > 0 && preloadProgress.loaded < preloadProgress.total && (
                            <span style={{ marginLeft: '8px', color: 'var(--accent-blue)' }}>
                                • Preloading {preloadProgress.loaded}/{preloadProgress.total}
                            </span>
                        )}
                    </div>
                </div>

                {/* Legend */}
                <div style={{
                    display: 'flex',
                    gap: '16px',
                    paddingLeft: '16px',
                    borderLeft: '1px solid var(--glass-border)'
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <div style={{ width: '12px', height: '12px', background: 'var(--accent-emerald)', borderRadius: '3px' }} />
                        <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Added</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <div style={{ width: '12px', height: '12px', background: 'var(--accent-amber)', borderRadius: '3px' }} />
                        <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Updated</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <div style={{ width: '12px', height: '12px', background: 'var(--accent-rose)', borderRadius: '3px' }} />
                        <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Removed</span>
                    </div>
                </div>

                <button
                    onClick={onClose}
                    style={{
                        padding: '6px 12px',
                        borderRadius: '6px',
                        background: 'var(--glass-bg)',
                        border: '1px solid var(--glass-border)',
                        color: 'var(--text-secondary)',
                        fontSize: '12px',
                        cursor: 'pointer',
                        marginLeft: '8px'
                    }}
                >
                    Exit Timeline
                </button>
            </div>

            {/* Graph view */}
            <GraphView
                nodes={nodes}
                edges={edges}
                onNodeClick={handleNodeClick}
                fitViewSignal={fitViewSignal}
            />

            {/* Loading overlay */}
            <LoadingOverlay
                isVisible={isLoading}
                label={loadingLabel}
                resolved={0}
                total={0}
            />

            {/* Timeline controls */}
            <TimelineControls
                versions={distilledVersions}
                currentIndex={currentIndex}
                isPlaying={isPlaying}
                onPlay={handlePlay}
                onPause={handlePause}
                onSeek={handleSeek}
                onSpeedChange={setAnimationSpeed}
                animationSpeed={animationSpeed}
                cachedIndices={cachedIndices}
            />
        </div>
    );
}
