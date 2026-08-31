import { Archive, Download, ExternalLink, GitCommit, Link as LinkIcon, Users, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getDownloads } from '../api/npm';
import type { DependencySource, GraphNodeData } from '../graph/resolver';

import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';

function getDepsDevEcosystem(source?: DependencySource): string {
    switch (source) {
        case 'pypi': return 'pypi';
        case 'crates': return 'cargo';
        case 'nuget': return 'nuget';
        case 'go': return 'go';
        case 'npm':
        default: return 'npm';
    }
}

export interface SidebarInfoProps {
    nodeId: string | null;
    nodeData?: GraphNodeData | null;
    micropackageThreshold?: number;
    isOpen: boolean;
    onClose: () => void;
}

const MIN_SIDEBAR_WIDTH = 350;
const DEFAULT_SIDEBAR_WIDTH = 480;
const MAX_SIDEBAR_WIDTH = 800;

export function SidebarInfo({ nodeData, micropackageThreshold = 6144, isOpen, onClose }: SidebarInfoProps) {
    const [downloads, setDownloads] = useState<number | null>(null);
    const [width, setWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
    const isResizing = useRef(false);
    const startX = useRef(0);
    const startWidth = useRef(DEFAULT_SIDEBAR_WIDTH);

    useEffect(() => {
        if (isOpen && nodeData) {
            // Reset downloads when node changes - this is intentional and not a bug
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setDownloads(null);
            getDownloads(nodeData.pkgName).then((d: number | null) => setDownloads(d));
        }
    }, [isOpen, nodeData]);

    const handleResizeStart = useCallback((e: React.MouseEvent) => {
        isResizing.current = true;
        startX.current = e.clientX;
        startWidth.current = width;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
    }, [width]);

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (!isResizing.current) return;
            const delta = startX.current - e.clientX;
            const newWidth = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, startWidth.current + delta));
            setWidth(newWidth);
        };
        const handleMouseUp = () => {
            isResizing.current = false;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        };
        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        };
    }, []);

    if (!isOpen) {
        return (
            <div className={`app-sidebar glass-panel-interactive`}></div>
        );
    }

    const downloadsStr = downloads !== null
        ? new Intl.NumberFormat('en-US').format(downloads)
        : 'Loading...';

    const depsCount = Object.keys(nodeData?.dependencies || {}).length;

    function formatBytes(bytes: number): string {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }

    const sizeStr = nodeData?.size !== undefined ? formatBytes(nodeData.size) : 'Unknown';

    return (
        <div className={`app-sidebar glass-panel-interactive open`} style={{ width }}>
            {/* Resize handle */}
            <div
                onMouseDown={handleResizeStart}
                style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    bottom: 0,
                    width: '6px',
                    cursor: 'col-resize',
                    zIndex: 20,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center' }}
            >
                <div style={{
                    width: '2px',
                    height: '32px',
                    borderRadius: '2px',
                    background: 'var(--text-muted)',
                    opacity: 0.4 }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 16px 16px 22px', borderBottom: '1px solid var(--border-color)' }}>
                <h2 style={{ fontSize: '18px', margin: 0 }}>Package Details</h2>
                <button
                    onClick={onClose}
                    style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}
                >
                    <X size={20} />
                </button>
            </div>

            <div style={{ padding: '24px', flex: 1, overflowY: 'auto' }}>
                {nodeData ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
                        <div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                                <h3 className="gradient-text" style={{ fontSize: '24px', margin: 0 }}>{nodeData.pkgName}</h3>
                                <span style={{ padding: '2px 8px', background: 'rgba(59, 130, 246, 0.2)', color: 'var(--accent-blue)', borderRadius: '12px', fontSize: '12px', fontWeight: 600 }}>
                                    v{nodeData.version}
                                </span>
                            </div>

                            <div className="markdown-body" style={{ color: 'var(--text-secondary)', fontSize: '14px', lineHeight: 1.5, margin: 0 }}>
                                {nodeData.description ? (
                                    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
                                        {nodeData.description}
                                    </ReactMarkdown>
                                ) : (
                                    <p>No description provided.</p>
                                )}
                            </div>
                        </div>

                        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                            {nodeData.source === 'npm' && (
                                <>
                                    <a href={`https://npmjs.com/package/${nodeData.pkgName}`} target="_blank" rel="noreferrer" className="glass-panel" style={{ textDecoration: 'none', padding: '6px 12px', borderRadius: '4px', fontSize: '12px', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                        <ExternalLink size={14} /> npm
                                    </a>
                                    <a href={`https://bundlephobia.com/package/${nodeData.pkgName}@${nodeData.version}`} target="_blank" rel="noreferrer" className="glass-panel" style={{ textDecoration: 'none', padding: '6px 12px', borderRadius: '4px', fontSize: '12px', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                        <ExternalLink size={14} /> bundle
                                    </a>
                                </>
                            )}
                            <a href={`https://deps.dev/${getDepsDevEcosystem(nodeData.source)}/${nodeData.pkgName}/${nodeData.version}`} target="_blank" rel="noreferrer" className="glass-panel" style={{ textDecoration: 'none', padding: '6px 12px', borderRadius: '4px', fontSize: '12px', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                <ExternalLink size={14} /> deps.dev
                            </a>
                        </div>

                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                            <div className="glass-panel" style={{ padding: '12px', borderRadius: '8px' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--text-muted)', fontSize: '12px', marginBottom: '4px' }}>
                                    <Download size={14} /> Weekly DLs
                                </div>
                                <div style={{ color: 'white', fontWeight: 600, fontSize: '16px' }}>{downloadsStr}</div>
                            </div>
                            <div className="glass-panel" style={{ padding: '12px', borderRadius: '8px' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--text-muted)', fontSize: '12px', marginBottom: '4px' }}>
                                    <LinkIcon size={14} /> Dependencies
                                </div>
                                <div style={{ color: 'white', fontWeight: 600, fontSize: '16px' }}>{depsCount}</div>
                            </div>
                            <div className="glass-panel" style={{ padding: '12px', borderRadius: '8px' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--text-muted)', fontSize: '12px', marginBottom: '4px' }}>
                                    <Users size={14} /> Maintainers
                                </div>
                                <div style={{ color: 'white', fontWeight: 600, fontSize: '16px' }}>{nodeData.maintainers}</div>
                            </div>
                            <div className="glass-panel" style={{ padding: '12px', borderRadius: '8px' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--text-muted)', fontSize: '12px', marginBottom: '4px' }}>
                                    <GitCommit size={14} /> Last Update
                                </div>
                                <div style={{ color: 'white', fontWeight: 600, fontSize: '14px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                    {nodeData.lastPublish.split('T')[0]}
                                </div>
                            </div>
                            {nodeData.source !== 'nuget' && (
                                <div className="glass-panel" style={{ padding: '12px', borderRadius: '8px' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--text-muted)', fontSize: '12px', marginBottom: '4px' }}>
                                        <Archive size={14} /> Size
                                    </div>
                                    <div style={{ color: 'white', fontWeight: 600, fontSize: '16px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                        {sizeStr}
                                    </div>
                                    {nodeData.size !== undefined && nodeData.size > 0 && nodeData.size < micropackageThreshold && (
                                        <div style={{ fontSize: '10px', color: 'var(--accent-amber)', marginTop: '4px' }}>
                                            Micro-package
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>

                        {(nodeData.isOutdated || nodeData.isPrereleaseAvailable) && (
                            <div className="glass-panel" style={{ padding: '16px', borderRadius: '8px' }}>
                                <h4 style={{ margin: '0 0 12px 0', fontSize: '16px', color: 'var(--text-primary)', borderBottom: '1px solid var(--border-color)', paddingBottom: '8px' }}>Available Versions</h4>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                    {nodeData.latestVersion && (
                                        <div>
                                            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>Latest Stable</div>
                                            <span style={{ padding: '4px 8px', background: 'rgba(234, 179, 8, 0.2)', color: 'var(--accent-amber)', borderRadius: '4px', fontSize: '13px', fontWeight: 600 }}>
                                                v{nodeData.latestVersion}
                                            </span>
                                        </div>
                                    )}
                                    {nodeData.newerVersions && nodeData.newerVersions.length > 0 && (
                                        <div>
                                            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>Newer Versions</div>
                                            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                                                {nodeData.newerVersions.map((v, idx) => (
                                                    <span key={idx} style={{ padding: '3px 8px', background: 'rgba(59, 130, 246, 0.15)', color: 'var(--accent-blue)', borderRadius: '4px', fontSize: '12px' }}>
                                                        v{v}
                                                    </span>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                    {nodeData.prereleaseVersions && nodeData.prereleaseVersions.length > 0 && (
                                        <div>
                                            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>Prerelease Versions</div>
                                            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                                                {nodeData.prereleaseVersions.map((v, idx) => (
                                                    <span key={idx} style={{ padding: '3px 8px', background: 'rgba(139, 92, 246, 0.15)', color: 'var(--accent-violet)', borderRadius: '4px', fontSize: '12px' }}>
                                                        v{v}
                                                    </span>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}

                        {(nodeData.spdxLicenses || nodeData.depsDevAdvisories || nodeData.externalLinks) && (
                            <div className="glass-panel" style={{ padding: '16px', borderRadius: '8px' }}>
                                <h4 style={{ margin: '0 0 12px 0', fontSize: '16px', color: 'var(--text-primary)', borderBottom: '1px solid var(--border-color)', paddingBottom: '8px' }}>deps.dev Metadata</h4>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                                    {nodeData.spdxLicenses && nodeData.spdxLicenses.length > 0 && (
                                        <div>
                                            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>SPDX Licenses</div>
                                            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                                                {nodeData.spdxLicenses.map((license, idx) => (
                                                    <span key={idx} style={{ padding: '4px 8px', background: 'rgba(59, 130, 246, 0.2)', color: 'var(--accent-blue)', borderRadius: '4px', fontSize: '12px' }}>
                                                        {license}
                                                    </span>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                    {nodeData.depsDevAdvisories && nodeData.depsDevAdvisories.length > 0 && (
                                        <div>
                                            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>Security Advisories (deps.dev)</div>
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                                {nodeData.depsDevAdvisories.map((advisory, idx) => (
                                                    <a
                                                        key={idx}
                                                        href={`https://osv.dev/vulnerability/${advisory}`}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        style={{
                                                            padding: '6px 10px',
                                                            background: 'rgba(244, 63, 94, 0.1)',
                                                            border: '1px solid rgba(244, 63, 94, 0.3)',
                                                            borderRadius: '4px',
                                                            color: 'var(--accent-rose)',
                                                            fontSize: '12px',
                                                            textDecoration: 'none',
                                                            display: 'flex',
                                                            alignItems: 'center',
                                                            gap: '6px'
                                                        }}
                                                    >
                                                        <ExternalLink size={12} />
                                                        {advisory}
                                                    </a>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                    {nodeData.externalLinks && nodeData.externalLinks.length > 0 && (
                                        <div>
                                            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>External Links</div>
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                                {nodeData.externalLinks.map((link, idx) => (
                                                    <a
                                                        key={idx}
                                                        href={link.url}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        style={{
                                                            color: 'var(--accent-blue)',
                                                            fontSize: '13px',
                                                            textDecoration: 'none',
                                                            display: 'flex',
                                                            alignItems: 'center',
                                                            gap: '6px'
                                                        }}
                                                    >
                                                        <ExternalLink size={12} />
                                                        {link.label}
                                                    </a>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}

                        {nodeData.readme && (
                            <div className="glass-panel" style={{ padding: '16px', borderRadius: '8px' }}>
                                <h4 style={{ margin: '0 0 12px 0', fontSize: '16px', color: 'var(--text-primary)', borderBottom: '1px solid var(--border-color)', paddingBottom: '8px' }}>Readme</h4>
                                <div className="markdown-body" style={{ color: 'var(--text-secondary)', fontSize: '14px', lineHeight: 1.6, maxHeight: '500px', overflowY: 'auto' }}>
                                    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
                                        {nodeData.readme}
                                    </ReactMarkdown>
                                </div>
                            </div>
                        )}
                    </div>
                ) : (
                    <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '40px 0', fontSize: '14px' }}>
                        Select a node in the graph to view details.
                    </div>
                )}
            </div>
        </div>
    );
}
