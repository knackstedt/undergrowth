import { CircleAlert, ExternalLink, GitBranch, Github, Gitlab, Info, Package, X } from 'lucide-react';
import { useState } from 'react';

export function Legend() {
    const [isOpen, setIsOpen] = useState(false);

    if (!isOpen) {
        return (
            <button
                className="glass-panel"
                style={{
                    position: 'absolute',
                    top: '24px',
                    right: '24px',
                    padding: '12px',
                    borderRadius: '50%',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    border: '1px solid var(--border-color)',
                    background: 'var(--bg-panel)',
                    color: 'var(--text-primary)',
                    zIndex: 50,
                    transition: 'all 0.2s ease' }}
                onClick={() => setIsOpen(true)}
                title="Show Graph Legend"
            >
                <Info size={24} />
            </button>
        );
    }

    return (
        <div 
            className="glass-panel"
            style={{
                position: 'absolute',
                top: '24px',
                right: '24px',
                padding: '20px',
                borderRadius: '12px',
                width: '320px',
                maxHeight: 'calc(100vh - 60px)',
                overflowY: 'auto',
                zIndex: 60,
                display: 'flex',
                flexDirection: 'column',
                gap: '16px',
                background: 'var(--bg-panel)',
                backdropFilter: 'var(--glass-backdrop)' }}
        >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ fontSize: '16px', margin: 0, color: 'var(--text-primary)' }}>Legend</h3>
                <button 
                    onClick={() => setIsOpen(false)}
                    style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex' }}
                >
                    <X size={18} />
                </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '13px' }}>
                <div style={{ fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '4px' }}>Status Border Overrides</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div style={{ width: '12px', height: '12px', borderRadius: '50%', background: 'var(--accent-rose)' }}></div>
                    <span style={{ color: 'var(--text-primary)' }}>Warning Filter Match</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div style={{ width: '12px', height: '12px', borderRadius: '50%', background: '#fbbf24' }}></div>
                    <span style={{ color: 'var(--text-primary)' }}>Search Match</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div style={{ width: '12px', height: '12px', borderRadius: '50%', background: '#f59e0b' }}></div>
                    <span style={{ color: 'var(--text-primary)' }}>Micro-package</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div style={{ width: '12px', height: '12px', borderRadius: '50%', background: 'var(--accent-blue)' }}></div>
                    <span style={{ color: 'var(--text-primary)' }}>Update Available</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div style={{ width: '12px', height: '12px', borderRadius: '50%', background: 'rgb(139, 92, 246)' }}></div>
                    <span style={{ color: 'var(--text-primary)' }}>Prerelease Available</span>
                </div>

                <div style={{ fontWeight: 600, color: 'var(--text-secondary)', marginTop: '8px', marginBottom: '4px' }}>Contextual Relationships (Fill)</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div style={{ width: '12px', height: '12px', borderRadius: '4px', background: 'var(--accent-emerald)' }}></div>
                    <span style={{ color: 'var(--text-primary)' }}>Root / Upstream</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div style={{ width: '12px', height: '12px', borderRadius: '4px', background: 'var(--accent-blue)' }}></div>
                    <span style={{ color: 'var(--text-primary)' }}>Downstream / Selected</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div style={{ width: '12px', height: '12px', borderRadius: '4px', background: 'var(--accent-amber)' }}></div>
                    <span style={{ color: 'var(--text-primary)' }}>Both (Circular/Bidirectional)</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div style={{ width: '12px', height: '12px', borderRadius: '4px', background: '#9575cd' }}></div>
                    <span style={{ color: 'var(--text-primary)' }}>Dedicated (Exclusive)</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div style={{ width: '12px', height: '12px', borderRadius: '4px', background: 'var(--accent-cyan)', border: '1px solid rgba(255,255,255,0.4)' }}></div>
                    <span style={{ color: 'var(--text-primary)' }}>Python Root</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div style={{ width: '12px', height: '12px', borderRadius: '4px', background: 'rgba(100, 116, 139, 0.35)' }}></div>
                    <span style={{ color: 'var(--text-primary)' }}>Default / Neutral</span>
                </div>

                <div style={{ fontWeight: 600, color: 'var(--text-secondary)', marginTop: '8px', marginBottom: '4px' }}>Special Border Styles</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div style={{ width: '20px', height: '12px', border: '2px dashed #c084fc', borderRadius: '2px' }}></div>
                    <span style={{ color: 'var(--text-primary)' }}>Peer Dependency</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div style={{ width: '20px', height: '12px', border: '2px dotted var(--accent-cyan)', borderRadius: '2px', background: 'rgba(6, 182, 212, 0.12)' }}></div>
                    <span style={{ color: 'var(--text-primary)' }}>Python Root Package</span>
                </div>
                <div style={{ fontWeight: 600, color: 'var(--text-secondary)', marginTop: '8px', marginBottom: '4px' }}>Package Status (Background Patterns)</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div style={{
                        width: '20px',
                        height: '12px',
                        borderRadius: '2px',
                        background: 'repeating-linear-gradient(45deg, rgba(251, 146, 60, 0.3), rgba(251, 146, 60, 0.3) 4px, rgba(251, 146, 60, 0.1) 4px, rgba(251, 146, 60, 0.1) 8px)'
                    }}></div>
                    <span style={{ color: 'var(--text-primary)' }}>Deprecated</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div style={{
                        width: '20px',
                        height: '12px',
                        borderRadius: '2px',
                        background: 'repeating-linear-gradient(45deg, rgba(234, 179, 8, 0.3), rgba(234, 179, 8, 0.3) 4px, rgba(234, 179, 8, 0.1) 4px, rgba(234, 179, 8, 0.1) 8px)'
                    }}></div>
                    <span style={{ color: 'var(--text-primary)' }}>Outdated</span>
                </div>

                <div style={{ fontWeight: 600, color: 'var(--text-secondary)', marginTop: '8px', marginBottom: '4px' }}>Dependency Types (Edges)</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div style={{ width: '20px', height: '2px', background: 'var(--text-muted)' }}></div>
                    <span style={{ color: 'var(--text-primary)' }}>Standard Dependency</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div style={{ width: '20px', height: '0', borderTop: '2px dashed #c084fc' }}></div>
                    <span style={{ color: 'var(--text-primary)' }}>Peer Dependency</span>
                </div>

                <div style={{ fontWeight: 600, color: 'var(--text-secondary)', marginTop: '8px', marginBottom: '4px' }}>Dependency Sources (Icons)</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <Package size={14} color="var(--text-secondary)" />
                    <span style={{ color: 'var(--text-primary)' }}>npm (Default)</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div style={{
                        width: '14px',
                        height: '14px',
                        borderRadius: '3px',
                        background: 'var(--accent-cyan)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '9px',
                        fontWeight: 'bold',
                        color: 'white'
                    }}>Py</div>
                    <span style={{ color: 'var(--text-primary)' }}>PyPI (Python)</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <Github size={14} color="var(--text-secondary)" />
                    <span style={{ color: 'var(--text-primary)' }}>GitHub</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <Gitlab size={14} color="var(--text-secondary)" />
                    <span style={{ color: 'var(--text-primary)' }}>GitLab</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <GitBranch size={14} color="var(--text-secondary)" />
                    <span style={{ color: 'var(--text-primary)' }}>Bitbucket</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <ExternalLink size={14} color="var(--text-secondary)" />
                    <span style={{ color: 'var(--text-primary)' }}>External/Direct Link</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <CircleAlert size={14} color="var(--accent-rose)" />
                    <span style={{ color: 'var(--text-primary)' }}>Unrecognized Source</span>
                </div>
            </div>
        </div>
    );
}
