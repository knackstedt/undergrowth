import type { Edge, Node } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GraphNodeData } from '../graph/resolver';
import { GraphView } from './GraphView';
import { LoadingOverlay } from './LoadingOverlay';

type NodeRelationship = 'selected' | 'upstream' | 'downstream' | 'dedicated' | 'both' | 'dimmed';
type ComparisonStatus = 'new' | 'removed' | 'updated' | 'unchanged';
type AppGraphNode = Node<Record<string, unknown> & GraphNodeData & { relationship?: NodeRelationship; comparisonStatus?: ComparisonStatus; }>;
type AppGraphEdge = Edge;

export interface ComparisonSide {
    title: string;
    subtitle?: string;
    nodes: AppGraphNode[];
    edges: AppGraphEdge[];
    isLoading: boolean;
    progress: { resolved: number; total: number };
    loadingLabel: string;
    error: string | null;
}

export interface ComparisonViewProps {
    left: ComparisonSide;
    right: ComparisonSide;
    onNodeClick: (side: 'left' | 'right', nodeId: string | null) => void;
    fitViewSignalLeft?: number;
    fitViewSignalRight?: number;
}

export function ComparisonView({ left, right, onNodeClick, fitViewSignalLeft, fitViewSignalRight }: ComparisonViewProps) {
    const [dividerPosition, setDividerPosition] = useState(50);
    const containerRef = useRef<HTMLDivElement>(null);
    const isDraggingRef = useRef(false);

    const handleMouseDown = useCallback(() => {
        isDraggingRef.current = true;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
    }, []);

    const handleMouseUp = useCallback(() => {
        isDraggingRef.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
    }, []);

    const handleMouseMove = useCallback((e: MouseEvent) => {
        if (!isDraggingRef.current || !containerRef.current) return;

        const rect = containerRef.current.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const percentage = (x / rect.width) * 100;

        // Clamp between 20% and 80%
        setDividerPosition(Math.max(20, Math.min(80, percentage)));
    }, []);

    useEffect(() => {
        const onMouseUp = () => handleMouseUp();
        const onMouseMove = (e: MouseEvent) => handleMouseMove(e);

        window.addEventListener('mouseup', onMouseUp);
        window.addEventListener('mousemove', onMouseMove);

        return () => {
            window.removeEventListener('mouseup', onMouseUp);
            window.removeEventListener('mousemove', onMouseMove);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        };
    }, [handleMouseUp, handleMouseMove]);

    const handleLeftNodeClick = useCallback((nodeId: string | null) => {
        onNodeClick('left', nodeId);
    }, [onNodeClick]);

    const handleRightNodeClick = useCallback((nodeId: string | null) => {
        onNodeClick('right', nodeId);
    }, [onNodeClick]);

    // Calculate diff between left and right dependency trees
    const { leftNodesWithDiff, rightNodesWithDiff } = useMemo(() => {
        if (!left.nodes.length || !right.nodes.length) {
            return { leftNodesWithDiff: left.nodes, rightNodesWithDiff: right.nodes };
        }

        // Build maps of package name -> Set of versions for both sides
        // A package may appear multiple times with different versions in the tree
        const leftPkgMap = new Map<string, Set<string>>();
        const rightPkgMap = new Map<string, Set<string>>();

        for (const node of left.nodes) {
            const data = node.data as GraphNodeData;
            if (!leftPkgMap.has(data.pkgName)) {
                leftPkgMap.set(data.pkgName, new Set());
            }
            leftPkgMap.get(data.pkgName)!.add(data.version);
        }

        for (const node of right.nodes) {
            const data = node.data as GraphNodeData;
            if (!rightPkgMap.has(data.pkgName)) {
                rightPkgMap.set(data.pkgName, new Set());
            }
            rightPkgMap.get(data.pkgName)!.add(data.version);
        }

        // Pre-compute which packages have overlapping versions between sides
        // This helps distinguish "updated" (disjoint sets) from "removed"/"new" (specific version missing)
        const packageOverlapInfo = new Map<string, { hasOverlap: boolean; leftOnlyVersions: Set<string>; rightOnlyVersions: Set<string> }>();
        
        const allPkgNames = new Set([...leftPkgMap.keys(), ...rightPkgMap.keys()]);
        for (const pkgName of allPkgNames) {
            const leftVersions = leftPkgMap.get(pkgName) || new Set<string>();
            const rightVersions = rightPkgMap.get(pkgName) || new Set<string>();
            
            // Find overlapping versions
            const overlap = new Set([...leftVersions].filter(v => rightVersions.has(v)));
            const leftOnly = new Set([...leftVersions].filter(v => !rightVersions.has(v)));
            const rightOnly = new Set([...rightVersions].filter(v => !leftVersions.has(v)));
            
            packageOverlapInfo.set(pkgName, {
                hasOverlap: overlap.size > 0,
                leftOnlyVersions: leftOnly,
                rightOnlyVersions: rightOnly
            });
        }

        // Process nodes to determine comparison status
        const processNodes = (nodes: AppGraphNode[], otherPkgMap: Map<string, Set<string>>, isRightSide: boolean): AppGraphNode[] => {
            return nodes.map(node => {
                const data = node.data as { pkgName: string; version: string };
                const otherVersions = otherPkgMap.get(data.pkgName);
                const overlapInfo = packageOverlapInfo.get(data.pkgName);
                let status: ComparisonStatus;

                if (isRightSide) {
                    // Right side: check against left
                    if (otherVersions === undefined) {
                        status = 'new';
                    } else if (otherVersions.has(data.version)) {
                        status = 'unchanged';
                    } else if (overlapInfo?.hasOverlap) {
                        // Package exists on both sides with some overlap
                        // This specific version is new to the right side
                        status = 'new';
                    } else {
                        // Package exists on both sides but no version overlap at all
                        status = 'updated';
                    }
                } else {
                    // Left side: check against right
                    if (otherVersions === undefined) {
                        status = 'removed';
                    } else if (otherVersions.has(data.version)) {
                        status = 'unchanged';
                    } else if (overlapInfo?.hasOverlap) {
                        // Package exists on both sides with some overlap
                        // This specific version was removed from the left side
                        status = 'removed';
                    } else {
                        // Package exists on both sides but no version overlap at all
                        status = 'updated';
                    }
                }

                // DEBUG: Log computed status
                if (status !== 'unchanged') {
                    // console.log(`[ComparisonView] ${data.pkgName}@${data.version} is ${status}`);
                }

                // Apply styles based on status
                let borderColor: string | undefined;
                let backgroundColor: string | undefined;
                let opacity = 1;

                switch (status) {
                    case 'new':
                        borderColor = 'var(--accent-emerald)';
                        backgroundColor = 'rgba(16, 185, 129, 0.15)';
                        break;
                    case 'removed':
                        borderColor = 'var(--accent-rose)';
                        backgroundColor = 'rgba(244, 63, 94, 0.15)';
                        break;
                    case 'updated':
                        borderColor = 'var(--accent-amber)';
                        backgroundColor = 'rgba(245, 158, 11, 0.15)';
                        break;
                    case 'unchanged':
                    default:
                        // Boring - no special styling
                        borderColor = 'var(--node-border)';
                        opacity = 0.7;
                        break;
                }

                const nodeStyle: React.CSSProperties = {
                    ...(node.style || {})
                };

                // Apply diff styles based on status
                if (borderColor && status !== 'unchanged') {
                    nodeStyle.border = `2px solid ${borderColor}`;
                }
                if (backgroundColor) {
                    nodeStyle.background = backgroundColor;
                }
                if (status === 'unchanged') {
                    nodeStyle.opacity = opacity;
                }

                return {
                    ...node,
                    data: {
                        ...node.data,
                        comparisonStatus: status
                    },
                    style: nodeStyle
                };
            });
        };

        // DEBUG: Log map contents
        // console.log('[ComparisonView] leftPkgMap keys:', [...leftPkgMap.keys()].slice(0, 5), 'total:', leftPkgMap.size);
        // console.log('[ComparisonView] rightPkgMap keys:', [...rightPkgMap.keys()].slice(0, 5), 'total:', rightPkgMap.size);

        const leftResult = processNodes(left.nodes, rightPkgMap, false);
        const rightResult = processNodes(right.nodes, leftPkgMap, true);

        // DEBUG: Log results
        const leftUpdated = leftResult.filter(n => n.data.comparisonStatus === 'updated').map(n => `${n.data.pkgName}@${n.data.version}`);
        const rightUpdated = rightResult.filter(n => n.data.comparisonStatus === 'updated').map(n => `${n.data.pkgName}@${n.data.version}`);
        const leftOnly = leftUpdated.filter(id => !rightUpdated.includes(id));
        const rightOnly = rightUpdated.filter(id => !leftUpdated.includes(id));
        console.log(`[ComparisonView] Updated counts - left: ${leftUpdated.length}, right: ${rightUpdated.length}`);
        
        // Check ms versions
        const leftMs = leftPkgMap.get('ms');
        const rightMs = rightPkgMap.get('ms');
        console.log('[ComparisonView] ms on left:', leftMs ? [...leftMs] : 'undefined');
        console.log('[ComparisonView] ms on right:', rightMs ? [...rightMs] : 'undefined');
        
        if (leftOnly.length > 0) console.log('[ComparisonView] Only on left updated:', leftOnly.slice(0, 10));
        if (rightOnly.length > 0) console.log('[ComparisonView] Only on right updated:', rightOnly.slice(0, 10));

        return {
            leftNodesWithDiff: leftResult,
            rightNodesWithDiff: rightResult
        };
    }, [left.nodes, right.nodes]);

    // Legend data
    const diffStats = useMemo(() => {
        const leftStats = { new: 0, removed: 0, updated: 0, unchanged: 0 };
        const rightStats = { new: 0, removed: 0, updated: 0, unchanged: 0 };

        for (const node of leftNodesWithDiff) {
            const status = node.data.comparisonStatus;
            if (status) leftStats[status]++;
        }
        for (const node of rightNodesWithDiff) {
            const status = node.data.comparisonStatus;
            if (status) rightStats[status]++;
        }

        return { left: leftStats, right: rightStats };
    }, [leftNodesWithDiff, rightNodesWithDiff]);

    return (
        <div
            ref={containerRef}
            style={{
                display: 'flex',
                width: '100%',
                height: '100%',
                position: 'relative',
                overflow: 'hidden'
            }}
        >
            {/* Left Panel */}
            <div
                style={{
                    width: `${dividerPosition}%`,
                    height: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                    borderRight: '1px solid var(--border-color)',
                    position: 'relative'
                }}
            >
                <div
                    style={{
                        padding: '8px 12px',
                        background: 'var(--glass-bg)',
                        borderBottom: '1px solid var(--border-color)',
                        fontSize: '13px',
                        fontWeight: 600,
                        color: 'var(--text-primary)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between'
                    }}
                >
                    <div>
                        <span style={{ color: 'var(--accent-blue)' }}>Previous:</span> {left.title}
                        {left.subtitle && (
                            <span style={{ color: 'var(--text-muted)', marginLeft: '8px', fontWeight: 400 }}>
                                {left.subtitle}
                            </span>
                        )}
                    </div>
                    <div style={{ display: 'flex', gap: '12px', fontSize: '11px', fontWeight: 400 }}>
                        {diffStats.left.removed > 0 && (
                            <span style={{ color: 'var(--accent-rose)' }}>{diffStats.left.removed} removed</span>
                        )}
                        {diffStats.left.updated > 0 && (
                            <span style={{ color: 'var(--accent-amber)' }}>{diffStats.left.updated} updated</span>
                        )}
                    </div>
                </div>
                <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
                    <GraphView
                        nodes={leftNodesWithDiff}
                        edges={left.edges}
                        onNodeClick={handleLeftNodeClick}
                        fitViewSignal={fitViewSignalLeft}
                    />
                    <LoadingOverlay
                        isVisible={left.isLoading}
                        resolved={left.progress.resolved}
                        total={left.progress.total}
                        label={left.loadingLabel}
                    />
                </div>
            </div>

            {/* Resizable Divider */}
            <div
                onMouseDown={handleMouseDown}
                style={{
                    position: 'absolute',
                    left: `${dividerPosition}%`,
                    top: 0,
                    bottom: 0,
                    width: '8px',
                    transform: 'translateX(-50%)',
                    cursor: 'col-resize',
                    background: 'transparent',
                    zIndex: 10,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                }}
            >
                <div
                    style={{
                        width: '4px',
                        height: '40px',
                        background: 'var(--border-color)',
                        borderRadius: '2px',
                        transition: 'background 0.15s'
                    }}
                    className="divider-handle"
                />
            </div>

            {/* Right Panel */}
            <div
                style={{
                    width: `${100 - dividerPosition}%`,
                    height: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                    position: 'relative'
                }}
            >
                <div
                    style={{
                        padding: '8px 12px',
                        background: 'var(--glass-bg)',
                        borderBottom: '1px solid var(--border-color)',
                        fontSize: '13px',
                        fontWeight: 600,
                        color: 'var(--text-primary)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between'
                    }}
                >
                    <div>
                        <span style={{ color: 'var(--accent-emerald)' }}>New:</span> {right.title}
                        {right.subtitle && (
                            <span style={{ color: 'var(--text-muted)', marginLeft: '8px', fontWeight: 400 }}>
                                {right.subtitle}
                            </span>
                        )}
                    </div>
                    <div style={{ display: 'flex', gap: '12px', fontSize: '11px', fontWeight: 400 }}>
                        {diffStats.right.new > 0 && (
                            <span style={{ color: 'var(--accent-emerald)' }}>{diffStats.right.new} new</span>
                        )}
                        {diffStats.right.updated > 0 && (
                            <span style={{ color: 'var(--accent-amber)' }}>{diffStats.right.updated} updated</span>
                        )}
                    </div>
                </div>
                <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
                    <GraphView
                        nodes={rightNodesWithDiff}
                        edges={right.edges}
                        onNodeClick={handleRightNodeClick}
                        fitViewSignal={fitViewSignalRight}
                    />
                    <LoadingOverlay
                        isVisible={right.isLoading}
                        resolved={right.progress.resolved}
                        total={right.progress.total}
                        label={right.loadingLabel}
                    />
                </div>
            </div>

            {/* Diff Legend */}
            {left.nodes.length > 0 && right.nodes.length > 0 && (
                <div className="diff-legend">
                    <div className="diff-legend-item">
                        <div className="diff-legend-dot new"></div>
                        <span>New</span>
                    </div>
                    <div className="diff-legend-item">
                        <div className="diff-legend-dot removed"></div>
                        <span>Removed</span>
                    </div>
                    <div className="diff-legend-item">
                        <div className="diff-legend-dot updated"></div>
                        <span>Updated</span>
                    </div>
                    <div className="diff-legend-item">
                        <div className="diff-legend-dot unchanged"></div>
                        <span>Unchanged</span>
                    </div>
                </div>
            )}
        </div>
    );
}
