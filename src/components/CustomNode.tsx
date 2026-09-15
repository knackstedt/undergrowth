import { Handle, Position } from '@xyflow/react';
import clsx from 'classnames';
import { flip, FloatingPortal, offset, safePolygon, shift, size, useFloating, useHover, useInteractions } from '@floating-ui/react';
import { AlertTriangle, CircleAlert, ExternalLink, GitBranch, Github, Gitlab, Loader2, Package } from 'lucide-react';
import { memo, useCallback, useState } from 'react';
import type { DependencySource, GraphNodeData } from '../graph/resolver';
import { MICROPACKAGE_SIZE_THRESHOLD } from '../graph/resolver';
import { formatBytes } from '../utils/format';
import { useNodeVisibility } from './useNodeVisibility';
import { collectWarningHighlights, matchesWarningToggles } from './nodeWarnings';
import type { WarningToggles } from './WarningTogglesPanel';

const NODE_WIDTH = 280;
const NODE_HEIGHT = 120;

const SourceIcon = ({ source, size = 16, color }: { source?: DependencySource, size?: number, color?: string }) => {
    switch (source) {
        case 'github':
            return <Github size={size} color={color} />;
        case 'gitlab':
            return <Gitlab size={size} color={color} />;
        case 'bitbucket':
            return <GitBranch size={size} color={color} />;
        case 'external':
            return <ExternalLink size={size} color={color} />;
        case 'other':
            return <CircleAlert size={size} color="var(--accent-rose)" />;
        case 'pypi':
            return (
                <div style={{
                    width: size,
                    height: size,
                    borderRadius: '4px',
                    background: color || 'var(--accent-cyan)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: `${size * 0.6}px`,
                    fontWeight: 'bold',
                    color: 'white'
                }}>Py</div>
            );
        case 'crates':
            return (
                <div style={{
                    width: size,
                    height: size,
                    borderRadius: '4px',
                    background: color || 'var(--accent-amber)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: `${size * 0.55}px`,
                    fontWeight: 'bold',
                    color: 'white'
                }}>Rs</div>
            );
        case 'npm':
        default:
            return <Package size={size} color={color} />;
    }
};

interface CustomNodeProps {
    data: GraphNodeData & {
        relationship?: 'selected' | 'upstream' | 'downstream' | 'dedicated' | 'both' | 'dimmed';
        warningToggles?: WarningToggles;
        micropackageThreshold?: number;
        comparisonStatus?: 'new' | 'removed' | 'updated' | 'unchanged';
        timelineStatus?: 'added' | 'updated' | 'removed' | 'unchanged' | 'pending-removal';
        previousVersion?: string;
        searchMatch?: boolean;
    };
    selected?: boolean;
    positionAbsoluteX?: number;
    positionAbsoluteY?: number;
    style?: React.CSSProperties;
}

const hiddenHandleStyle = { opacity: 0, pointerEvents: 'none' as const };

export const CustomNode = memo(function CustomNode({ data, selected, positionAbsoluteX = 0, positionAbsoluteY = 0, style }: CustomNodeProps) {
    const [isHovered, setIsHovered] = useState(false);

    const { isOutsideViewport, isLOD, isNameLOD, zoom } = useNodeVisibility(positionAbsoluteX, positionAbsoluteY, NODE_WIDTH, NODE_HEIGHT);

    // Floating UI tooltip
    const [isTooltipOpen, setIsTooltipOpen] = useState(false);

    const { refs: floatingUi, floatingStyles, context } = useFloating({
        open: isTooltipOpen,
        onOpenChange: setIsTooltipOpen,
        placement: 'top',
        middleware: [
            offset(16),
            flip({ padding: 16 }),
            shift({ padding: 16 }),
            size({ padding: 16 }),
        ] });
    // floating-ui's setters are callback refs; wrapping them keeps the
    // react-hooks/refs rule from treating them as ref reads during render
    const setReference = useCallback((el: HTMLDivElement | null) => floatingUi.setReference(el), [floatingUi]);
    const setFloating = useCallback((el: HTMLDivElement | null) => floatingUi.setFloating(el), [floatingUi]);

    const hover = useHover(context, { delay: { open: 300, close: 100 }, handleClose: safePolygon() });
    const { getReferenceProps, getFloatingProps } = useInteractions([hover]);

    const relationship = data.relationship;
    const isDedicated = relationship === 'dedicated';
    const isPeer = data.isPeer;
    const isPythonRoot = data.isPythonRoot;
    const micropackageThreshold = (data.micropackageThreshold as number | undefined) ?? MICROPACKAGE_SIZE_THRESHOLD;
    const isMicropackage = data.size !== undefined && data.size > 0 && data.size < micropackageThreshold;

    // Comparison diff status
    const comparisonStatus = data.comparisonStatus;
    const isDiffNew = comparisonStatus === 'new';
    const isDiffRemoved = comparisonStatus === 'removed';
    const isDiffUpdated = comparisonStatus === 'updated';
    const isDiffUnchanged = comparisonStatus === 'unchanged';
    const hasDiffStatus = !!comparisonStatus;

    // Timeline status (for historical timeline view)
    const timelineStatus = data.timelineStatus;
    const isTimelineAdded = timelineStatus === 'added';
    const isTimelineUpdated = timelineStatus === 'updated';
    const isTimelineRemoved = timelineStatus === 'removed';
    const isTimelinePendingRemoval = timelineStatus === 'pending-removal';
    const hasTimelineStatus = !!timelineStatus;

    // Search match highlight
    const isSearchMatch = data.searchMatch;

    // Check for updates available (blue highlight)
    const hasUpdateAvailable = data.warningToggles?.hasAvailableUpdates && data.isOutdated;

    // Check for prerelease available (violet highlight)
    const hasPrereleaseAvailable = data.warningToggles?.hasAvailableUpdates && data.isPrereleaseAvailable;

    // Check if node matches any active warning filters (red highlight)
    const hasWarning = matchesWarningToggles(data);

    // Background fill: relationships from legend (neutral when none active)
    let bgColor = 'rgba(100, 116, 139, 0.35)';
    if (data.isRoot) bgColor = 'var(--accent-emerald)';
    if (data.isPythonRoot) bgColor = 'var(--accent-cyan)';

    if (relationship === 'upstream') bgColor = 'var(--accent-emerald)';
    if (relationship === 'downstream') bgColor = 'var(--accent-blue)';
    if (relationship === 'dedicated') bgColor = '#9575cd';
    if (relationship === 'both') bgColor = 'var(--accent-amber)';
    if (relationship === 'selected') bgColor = 'var(--accent-blue)';

    // Border color: follows bgColor (relationship), overridden by module type & status
    let borderColor = bgColor;
    if (data.moduleType === 'cjs') borderColor = 'rgb(59, 130, 246)'; // blue
    if (data.moduleType === 'esm') borderColor = 'rgb(34, 197, 94)'; // green
    if (data.moduleType === 'both') borderColor = 'rgb(6, 182, 212)'; // cyan

    // Updates available uses blue
    if (hasUpdateAvailable) borderColor = 'var(--accent-blue)';

    // Prerelease available uses violet
    if (hasPrereleaseAvailable) borderColor = 'rgb(139, 92, 246)';

    // Warning filters override border color with red
    if (hasWarning) borderColor = 'var(--accent-rose)';

    // Search match gets bright golden border (highest priority for visibility)
    if (isSearchMatch) borderColor = '#fbbf24'; // amber-400

    // Selected-node ring color (used in boxShadow, not border)
    const selectedRingColor = 'var(--accent-blue)';

    // Comparison diff styles override everything
    let diffBorderColor: string | undefined;
    let diffBackgroundColor: string | undefined;
    let diffOpacity = 1;

    if (isDiffNew) {
        diffBorderColor = 'var(--accent-emerald)';
        diffBackgroundColor = 'rgba(16, 185, 129, 0.2)';
    } else if (isDiffRemoved) {
        diffBorderColor = 'var(--accent-rose)';
        diffBackgroundColor = 'rgba(244, 63, 94, 0.2)';
    } else if (isDiffUpdated) {
        diffBorderColor = 'var(--accent-amber)';
        diffBackgroundColor = 'rgba(245, 158, 11, 0.2)';
    } else if (isDiffUnchanged) {
        diffOpacity = 0.6;
    }

    // Timeline status styles (similar to comparison, but animated)
    if (hasTimelineStatus && !hasDiffStatus) {
        if (isTimelineAdded) {
            diffBorderColor = 'var(--accent-emerald)';
            diffBackgroundColor = 'rgba(16, 185, 129, 0.25)';
        } else if (isTimelineUpdated) {
            diffBorderColor = 'var(--accent-amber)';
            diffBackgroundColor = 'rgba(245, 158, 11, 0.25)';
        } else if (isTimelineRemoved) {
            diffBorderColor = 'var(--accent-rose)';
            diffBackgroundColor = 'rgba(244, 63, 94, 0.25)';
            diffOpacity = 0.7;
        } else if (isTimelinePendingRemoval) {
            diffBorderColor = 'var(--accent-rose)';
            diffBackgroundColor = 'rgba(244, 63, 94, 0.15)';
            diffOpacity = 0.5;
        }
    }

    // Peer dependencies get a dashed border or distinct style

    if (isOutsideViewport) {
        return (
            <div style={{ width: NODE_WIDTH, height: NODE_HEIGHT, pointerEvents: 'none' }}>
                <Handle type="target" position={Position.Left} style={hiddenHandleStyle} />
                <Handle type="source" position={Position.Right} style={hiddenHandleStyle} />
            </div>
        );
    }

    const borderScale = (isLOD || isNameLOD) ? Math.min(Math.max(1 / zoom, 1), 10) : 1;
    // Special border styles: peer/python root/dedicated + warning/search
    const hasSpecialBorder = isPeer || isDedicated || isPythonRoot || hasWarning || isSearchMatch;
    const borderStyle = isPythonRoot ? 'dotted' : (isPeer ? 'dashed' : 'solid');
    const thickness = 2;

    // Search-match glow (independent of border type)
    const searchGlow = isSearchMatch
        ? `0 0 ${8 * borderScale}px rgba(251, 191, 36, 0.5), 0 0 ${16 * borderScale}px rgba(251, 191, 36, 0.25)`
        : undefined;

    let nodeBorderStyles: React.CSSProperties = {};
    // Diff status gets thick borders at all LODs
    const shouldShowDiffBorder = (hasDiffStatus && !isDiffUnchanged) ||
        (hasTimelineStatus && (isTimelineAdded || isTimelineUpdated || isTimelineRemoved || isTimelinePendingRemoval));
    if (shouldShowDiffBorder) {
        const diffBorderStr = `${Math.max(thickness * borderScale, isLOD || isNameLOD ? 3 : 4)}px solid ${diffBorderColor}`;
        nodeBorderStyles = {
            borderLeft: diffBorderStr,
            borderTop: diffBorderStr,
            borderRight: diffBorderStr,
            borderBottom: diffBorderStr,
            boxShadow: selected
                ? `0 0 0 ${2 * borderScale}px ${selectedRingColor}${searchGlow ? ', ' + searchGlow : ''}`
                : searchGlow,
            boxSizing: 'border-box'
        };
    } else if (hasSpecialBorder) {
        const borderStr = `${thickness * borderScale}px ${borderStyle} ${borderColor}`;
        nodeBorderStyles = {
            borderLeft: borderStr,
            borderTop: borderStr,
            borderRight: borderStr,
            borderBottom: borderStr,
            boxShadow: selected
                ? `0 0 0 ${2 * borderScale}px ${selectedRingColor}${searchGlow ? ', ' + searchGlow : ''}`
                : searchGlow,
            boxSizing: 'border-box'
        };
    } else {
        const showBorder = !(isLOD || isNameLOD);
        nodeBorderStyles = {
            borderLeftWidth: showBorder ? '4px' : undefined,
            borderLeftStyle: showBorder ? 'solid' : undefined,
            borderColor: showBorder ? borderColor : undefined,
            boxShadow: selected
                ? `0 0 0 ${2 * borderScale}px ${selectedRingColor}${searchGlow ? ', ' + searchGlow : ''}`
                : searchGlow,
            boxSizing: 'border-box'
        };
    }

    // In LOD modes, a special bordered node should NOT use the solid background
    // because dashed/dotted borders placed over the same color background become invisible.
    let lodBackground: string | undefined = bgColor;
    let lodClassName = '';
    
    // Diff/timeline styles take precedence over other special borders in LOD
    if (hasDiffStatus || hasTimelineStatus) {
        if (isDiffNew || isTimelineAdded) {
            lodBackground = diffBackgroundColor || 'rgba(16, 185, 129, 0.3)';
        } else if (isDiffRemoved || isTimelineRemoved) {
            lodBackground = diffBackgroundColor || 'rgba(244, 63, 94, 0.3)';
        } else if (isDiffUpdated || isTimelineUpdated) {
            lodBackground = diffBackgroundColor || 'rgba(245, 158, 11, 0.3)';
        } else if (isDiffUnchanged) {
            lodBackground = 'rgba(100, 116, 139, 0.1)'; // muted gray for unchanged
        } else if (isTimelinePendingRemoval) {
            lodBackground = diffBackgroundColor || 'rgba(244, 63, 94, 0.2)';
        }
    } else if (isDedicated) {
        lodBackground = 'rgba(149, 117, 205, 0.25)';
    } else if (isPythonRoot) {
        lodBackground = 'rgba(6, 182, 212, 0.15)';
    } else if (isPeer) {
        lodBackground = 'rgba(139, 92, 246, 0.08)';
        // Deprecated packages get orange diagonal stripes (larger in LOD)
        lodClassName = 'lod-deprecated';
    } else if (data.isOutdated) {
        // Outdated packages get yellow diagonal stripes (larger in LOD)
        lodClassName = 'lod-outdated';
    } else if (isSearchMatch) {
        lodBackground = 'rgba(251, 191, 36, 0.25)';
    } else if (hasWarning) {
        lodBackground = 'rgba(244, 63, 94, 0.15)';
    } else if (isMicropackage) {
        lodBackground = 'rgba(250, 204, 21, 0.12)';
    } else if (data.isPrereleaseAvailable) {
        // Prerelease available packages get violet diagonal stripes (larger in LOD)
        lodClassName = 'lod-prerelease';
    }

    // Build tooltip content for all nodes
    const renderTooltip = () => {
        if (!isTooltipOpen) return null;

        const statuses: string[] = [];
        const highlights: string[] = [];

        // Core package states
        if (data.deprecated) statuses.push('⚠️ Deprecated');
        if (data.isOutdated) statuses.push('📦 Outdated');
        if (data.isPrereleaseAvailable) statuses.push('🧪 Prerelease available');
        if (isMicropackage) statuses.push('📎 Micro-package');
        if (isPeer) statuses.push('🔗 Peer Dependency');
        if (isPythonRoot) statuses.push('🐍 Python Root Package');
        if (isSearchMatch) statuses.push('🔍 Search match');

        // Active warning highlights
        if (hasWarning) {
            highlights.push(...collectWarningHighlights(data));
        }

        // Update available highlight
        if (hasUpdateAvailable) {
            highlights.push('Update available');
        }
        if (hasPrereleaseAvailable) {
            highlights.push('Prerelease available');
        }

        const sizeStr = data.size !== undefined ? formatBytes(data.size) : undefined;
        const depsCount = Object.keys(data.dependencies || {}).length;
        const hasBodyContent = statuses.length > 0 || highlights.length > 0 || isMicropackage;

        return (
            <FloatingPortal>
                <div
                    ref={setFloating}
                    style={{
                        ...floatingStyles,
                        background: 'rgba(15, 17, 21, 0.98)',
                        color: 'white',
                        borderRadius: '10px',
                        fontSize: '12px',
                        maxWidth: '440px',
                        minWidth: '280px',
                        zIndex: 99999,
                        pointerEvents: 'auto',
                        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)',
                        border: '1px solid rgba(255, 255, 255, 0.12)' }}
                    onClick={(e) => e.stopPropagation()}
                    {...getFloatingProps()}
                >
                    {/* Titlebar */}
                    <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '10px',
                        padding: '12px 14px',
                        borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
                        background: 'rgba(255, 255, 255, 0.03)' }}>
                        <SourceIcon source={data.source} size={18} color={bgColor} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: 700, fontSize: '14px', color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {data.pkgName}
                            </div>
                            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
                                v{data.version}
                                {data.license && <span> · {data.license}</span>}
                            </div>
                        </div>
                        <span style={{
                            padding: '3px 8px',
                            background: 'rgba(59, 130, 246, 0.15)',
                            color: 'var(--accent-blue)',
                            borderRadius: '12px',
                            fontSize: '12px',
                            fontWeight: 600,
                            whiteSpace: 'nowrap' }}>
                            {depsCount} dep{depsCount !== 1 ? 's' : ''}
                        </span>
                    </div>

                    {/* Security Advisories */}

                    {/* Quick stats row */}
                    <div style={{
                        display: 'flex',
                        gap: '16px',
                        padding: '8px 14px',
                        borderBottom: hasBodyContent ? '1px solid rgba(255, 255, 255, 0.06)' : undefined,
                        background: 'rgba(255, 255, 255, 0.02)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', color: 'var(--text-muted)' }}>
                            <span style={{ color: 'var(--text-secondary)' }}>{data.maintainers}</span> maintainer{data.maintainers !== 1 ? 's' : ''}
                        </div>
                        {sizeStr && data.source !== 'nuget' && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', color: 'var(--text-muted)' }}>
                                <span style={{ color: 'var(--text-secondary)' }}>{sizeStr}</span>
                            </div>
                        )}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', color: 'var(--text-muted)' }}>
                            Updated <span style={{ color: 'var(--text-secondary)' }}>{data.lastPublish.split('T')[0]}</span>
                        </div>
                    </div>

                    {/* Body */}
                    {hasBodyContent && (
                        <div style={{ padding: '10px 14px' }}>
                            {statuses.length > 0 && (
                                <div style={{ marginBottom: highlights.length > 0 || isMicropackage ? '8px' : 0 }}>
                                    {statuses.map((status, i) => (
                                        <div key={i} style={{ lineHeight: '1.5', fontSize: '12px' }}>{status}</div>
                                    ))}
                                </div>
                            )}
                            {(data.isOutdated || data.isPrereleaseAvailable) && (
                                <div style={{ borderTop: statuses.length > 0 ? '1px solid rgba(255, 255, 255, 0.1)' : undefined, paddingTop: statuses.length > 0 ? '8px' : 0, marginBottom: (highlights.length > 0 || isMicropackage) ? '8px' : 0 }}>
                                    <div style={{ fontSize: '11px', color: 'rgba(255, 255, 255, 0.5)', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Updates Available</div>
                                    <div style={{ position: 'relative', paddingLeft: '14px' }}>
                                        {/* vertical trunk line */}
                                        <div style={{ position: 'absolute', left: '5px', top: '10px', bottom: '10px', width: '2px', background: 'rgba(255,255,255,0.12)' }} />

                                        {/* current version root */}
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', position: 'relative', marginBottom: '6px' }}>
                                            <div style={{ position: 'absolute', left: '-12px', top: '50%', transform: 'translateY(-50%)', width: '8px', height: '8px', borderRadius: '50%', background: 'var(--text-muted)', border: '2px solid rgba(15,17,21,0.98)' }} />
                                            <span style={{ padding: '2px 8px', background: 'rgba(100, 116, 139, 0.25)', color: 'var(--text-muted)', borderRadius: '6px', fontSize: '11px', fontWeight: 500 }}>v{data.version}</span>
                                            <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.35)' }}>current</span>
                                        </div>

                                        {/* stable branch */}
                                        {data.newerVersions && data.newerVersions.length > 0 && data.newerVersions.map((v, i) => {
                                            const isLast = i === data.newerVersions!.length - 1;
                                            return (
                                                <div key={v} style={{ display: 'flex', alignItems: 'center', gap: '8px', position: 'relative', marginBottom: isLast && data.prereleaseVersions && data.prereleaseVersions.length > 0 ? '6px' : '4px' }}>
                                                    <div style={{ position: 'absolute', left: '-12px', top: '50%', transform: 'translateY(-50%)', width: '8px', height: '8px', borderRadius: '50%', background: 'var(--accent-emerald)', border: '2px solid rgba(15,17,21,0.98)' }} />
                                                    <span style={{ padding: '2px 8px', background: 'rgba(16, 185, 129, 0.2)', color: 'var(--accent-emerald)', borderRadius: '6px', fontSize: '11px', fontWeight: 600 }}>v{v}</span>
                                                    {isLast && <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.35)' }}>latest</span>}
                                                </div>
                                            );
                                        })}

                                        {/* prerelease branch */}
                                        {data.prereleaseVersions && data.prereleaseVersions.length > 0 && (
                                            <div style={{ position: 'relative', marginLeft: '20px', marginTop: '2px' }}>
                                                {/* branch connector */}
                                                <div style={{ position: 'absolute', left: '-26px', top: '-6px', width: '14px', height: '2px', background: 'rgba(139, 92, 246, 0.35)' }} />
                                                <div style={{ position: 'absolute', left: '-26px', top: '-6px', width: '2px', height: '16px', background: 'rgba(139, 92, 246, 0.35)' }} />
                                                {data.prereleaseVersions.map((v, i) => {
                                                    const isLast = i === data.prereleaseVersions!.length - 1;
                                                    return (
                                                        <div key={v} style={{ display: 'flex', alignItems: 'center', gap: '8px', position: 'relative', marginBottom: isLast ? 0 : '4px' }}>
                                                            <div style={{ position: 'absolute', left: '-28px', top: '50%', transform: 'translateY(-50%)', width: '8px', height: '8px', borderRadius: '50%', background: 'rgb(139, 92, 246)', border: '2px solid rgba(15,17,21,0.98)' }} />
                                                            <span style={{ padding: '2px 8px', background: 'rgba(139, 92, 246, 0.2)', color: 'rgb(167, 139, 250)', borderRadius: '6px', fontSize: '11px', fontWeight: 600 }}>v{v}</span>
                                                            {isLast && <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.35)' }}>prerelease</span>}
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}
                            {highlights.length > 0 && (
                                <div style={{ borderTop: (statuses.length > 0 || data.isOutdated || data.isPrereleaseAvailable) ? '1px solid rgba(255, 255, 255, 0.1)' : undefined, paddingTop: (statuses.length > 0 || data.isOutdated || data.isPrereleaseAvailable) ? '8px' : 0, marginBottom: isMicropackage ? '8px' : 0 }}>
                                    <div style={{ fontSize: '11px', color: 'rgba(255, 255, 255, 0.5)', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Active Highlights</div>
                                    {highlights.map((highlight, i) => (
                                        <div key={i} style={{ fontSize: '12px', lineHeight: '1.5', color: 'var(--accent-amber)' }}>• {highlight}</div>
                                    ))}
                                </div>
                            )}
                            {isMicropackage && (
                                <div style={{ borderTop: (statuses.length > 0 || highlights.length > 0) ? '1px solid rgba(255, 255, 255, 0.1)' : undefined, paddingTop: (statuses.length > 0 || highlights.length > 0) ? '8px' : 0 }}>
                                    <div style={{ fontSize: '12px', lineHeight: '1.6', color: 'rgba(255, 255, 255, 0.85)' }}>
                                        <div style={{ fontWeight: 600, marginBottom: '4px', color: '#facc15' }}>Micro-package</div>
                                        <div style={{ marginBottom: '6px' }}>
                                            This package has a small footprint and narrow scope. Tiny dependencies are common sources of scanner noise — security findings here are worth reviewing carefully before treating them as actionable.
                                        </div>
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', color: 'rgba(255, 255, 255, 0.7)', fontSize: '11.5px' }}>
                                            <div>• Often provide utility functions that may already exist in your standard library or framework</div>
                                            <div>• Low maintainer count increases abandonment</div>
                                            <div>• Each additional dependency expands the attack surface and install time</div>
                                            <div>• Consider whether the functionality is worth the transitive dependency cost</div>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </FloatingPortal>
        );
    };

    if (isLOD) {
        // Calculate opacity based on various status conditions
        let opacity = 0.85;
        if (relationship === 'dimmed') opacity = 0.3;
        else if (isDiffUnchanged || isTimelinePendingRemoval) opacity = 0.5;
        else if (hasDiffStatus || hasTimelineStatus) opacity = 0.95;

        return (
            <div
                ref={setReference}
                className={lodClassName}
                {...getReferenceProps()}
                style={{
                    width: NODE_WIDTH,
                    height: NODE_HEIGHT,
                    background: lodClassName ? undefined : lodBackground,
                    borderRadius: '12px',
                    opacity,
                    position: 'relative',
                    ...nodeBorderStyles,
                    ...style
                }}
            >
                <Handle type="target" position={Position.Left} style={hiddenHandleStyle} />
                <Handle type="source" position={Position.Right} style={hiddenHandleStyle} />
                {renderTooltip()}
            </div>
        );
    }

    if (isNameLOD) {
        // Target ~30px on screen; nodes are scaled by zoom, so CSS px = target / zoom.
        // Clamp between 16px (very zoomed in, near the threshold) and 120px (very zoomed out).
        const nameFontSize = Math.min(Math.max(16 / zoom, 16), 120);

        // Calculate opacity for name LOD mode
        let nameLODOpacity = 0.85;
        if (relationship === 'dimmed') nameLODOpacity = 0.3;
        else if (isDiffUnchanged || isTimelinePendingRemoval) nameLODOpacity = 0.5;
        else if (hasDiffStatus || hasTimelineStatus) nameLODOpacity = 0.95;

        return (
            <div
                ref={setReference}
                className={lodClassName}
                {...getReferenceProps()}
                style={{
                    width: NODE_WIDTH,
                    height: NODE_HEIGHT,
                    background: lodClassName ? undefined : lodBackground,
                    borderRadius: '12px',
                    opacity: nameLODOpacity,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '8px 12px',
                    position: 'relative',
                    ...nodeBorderStyles,
                    ...style
                }}
            >
                <Handle type="target" position={Position.Left} style={hiddenHandleStyle} />
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    maxWidth: '100%',
                    justifyContent: 'center'
                }}>
                    <div style={{
                        fontWeight: 700,
                        fontSize: `${nameFontSize}px`,
                        color: 'rgba(255,255,255,0.95)',
                        textAlign: 'center',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'clip',
                        textShadow: '0 1px 3px rgba(0,0,0,0.4)',
                        letterSpacing: '-0.3px' }}>
                        {data.pkgName}
                    </div>
                </div>
                <Handle type="source" position={Position.Right} style={hiddenHandleStyle} />
                {renderTooltip()}
            </div>
        );
    }

    const isNotFound = !!data.isNotFound;
    const depsCount = Object.keys(data.dependencies || {}).length;
    const isPending = data.status === 'pending';

    // Determine background color for full detail view
    let nodeBackground: string | undefined;
    // Diff/timeline status backgrounds take precedence
    if (hasDiffStatus || hasTimelineStatus) {
        nodeBackground = diffBackgroundColor;
    } else if (isSearchMatch) {
        nodeBackground = 'rgba(251, 191, 36, 0.06)';
    } else if (hasWarning) {
        nodeBackground = 'rgba(244, 63, 94, 0.04)';
    } else if (isMicropackage) {
        nodeBackground = 'rgba(250, 204, 21, 0.04)';
    } else if (isPeer) {
        nodeBackground = 'rgba(139, 92, 246, 0.05)';
    } else if (isPythonRoot) {
        nodeBackground = 'rgba(6, 182, 212, 0.08)';
    }

    if (isNotFound) {
        return (
            <div
                className={clsx('glass-panel-interactive', selected && 'selected')}
                onMouseEnter={() => setIsHovered(true)}
                onMouseLeave={() => setIsHovered(false)}
                style={{
                    padding: '16px',
                    borderRadius: '12px',
                    minWidth: '280px',
                    maxWidth: '280px',
                    borderLeft: '4px dashed var(--accent-rose)',
                    opacity: relationship === 'dimmed' ? (isHovered ? 1 : 0.5) : 1,
                    background: 'rgba(244, 63, 94, 0.04)',
                    ...style
                }}
            >
                <Handle type="target" position={Position.Left} style={{ background: 'var(--text-muted)', border: 'none' }} />
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                    <AlertTriangle size={16} color="var(--accent-rose)" />
                    <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '15px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {data.pkgName}
                    </div>
                </div>
                <div style={{ fontSize: '12px', color: 'var(--accent-rose)', marginBottom: '12px' }}>
                    Not found on registry
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', borderTop: '1px solid var(--border-color)', paddingTop: '8px' }}>
                    Required: {data.version}
                </div>
                <Handle type="source" position={Position.Right} style={{ background: 'var(--text-muted)', border: 'none' }} />
            </div>
        );
    }

    return (
        <div className={clsx(
            'glass-panel-interactive',
            selected && 'selected',
            data.deprecated && 'node-deprecated',
            !data.deprecated && data.isOutdated && 'node-outdated',
            !data.deprecated && !data.isOutdated && data.isPrereleaseAvailable && 'node-prerelease',
            isPending && 'node-pending'
        )}
            ref={setReference}
            {...getReferenceProps()}
            style={{
                padding: '16px',
                borderRadius: '12px',
                minWidth: '280px',
                maxWidth: '280px',
                ...nodeBorderStyles,
                opacity: relationship === 'dimmed'
                    ? (isHovered ? 1 : 0.5)
                    : ((hasDiffStatus || hasTimelineStatus) ? diffOpacity : 1),
                ...(nodeBackground && { background: nodeBackground }),
                ...style
            }}
        >
            <Handle type="target" position={Position.Left} style={{ background: 'var(--text-muted)', border: 'none' }} />

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                {isPending ? (
                    <Loader2 size={16} color={bgColor} style={{ animation: 'spin 1s linear infinite' }} />
                ) : (
                    <SourceIcon source={data.source} size={16} color={bgColor} />
                )}
                <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '15px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>
                    {data.pkgName}
                </div>
            </div>

            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                v{data.version} &bull; {data.lastPublish.split('T')[0]}
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-around', borderTop: '1px solid var(--border-color)', paddingTop: '8px' }}>
                <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Deps</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 500 }}>{depsCount}</div>
                </div>
                <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Maint</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-primary)', fontWeight: 500 }}>{data.maintainers}</div>
                </div>
                {data.source !== 'nuget' && (
                    <div style={{ textAlign: 'center' }}>
                        <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Size</div>
                        <div style={{ fontSize: '12px', color: 'var(--text-primary)', fontWeight: 500 }}>{data.size !== undefined ? formatBytes(data.size) : '—'}</div>
                    </div>
                )}
            </div>

            <Handle type="source" position={Position.Right} style={{ background: 'var(--text-muted)', border: 'none' }} />
            {renderTooltip()}
        </div>
    );
});
