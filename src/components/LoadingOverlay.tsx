import { Package } from 'lucide-react';

interface LoadingOverlayProps {
    isVisible: boolean;
    resolved: number;
    total: number;
    label: string;
}

export function LoadingOverlay({ isVisible, resolved, total, label }: LoadingOverlayProps) {
    if (!isVisible) return null;

    const pct = total > 0 ? Math.min(100, Math.round((resolved / total) * 100)) : 0;
    const indeterminate = total === 0;

    return (
        <div style={{
            position: 'absolute', inset: 0, zIndex: 100,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(15, 17, 21, 0.7)',
            backdropFilter: 'blur(6px)',
            WebkitBackdropFilter: 'blur(6px)',
        }}>
            <div className="glass-panel" style={{
                padding: '32px 40px',
                borderRadius: '16px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '20px',
                minWidth: '320px',
            }}>
                <div style={{ position: 'relative', width: 48, height: 48 }}>
                    <div className="spinner" />
                    <Package
                        size={20}
                        color="var(--accent-blue)"
                        style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }}
                    />
                </div>

                <div style={{ textAlign: 'center' }}>
                    <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '15px', marginBottom: '4px' }}>
                        {label}
                    </div>
                    <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                        {indeterminate ? 'Starting…' : `${resolved} / ${total} packages`}
                    </div>
                </div>

                <div style={{ width: '100%', height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                    <div style={{
                        height: '100%',
                        borderRadius: 3,
                        background: 'linear-gradient(90deg, var(--accent-blue), var(--accent-purple))',
                        width: indeterminate ? '40%' : `${pct}%`,
                        transition: indeterminate ? 'none' : 'width 120ms ease-out',
                        animation: indeterminate ? 'indeterminate-bar 1.4s ease-in-out infinite' : 'none',
                    }} />
                </div>

                {!indeterminate && (
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                        {pct}% complete
                    </div>
                )}
            </div>
        </div>
    );
}
