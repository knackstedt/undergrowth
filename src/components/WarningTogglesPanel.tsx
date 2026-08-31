import { Info, Settings } from 'lucide-react';
import { useState } from 'react';

export interface WarningToggles {
    maxDependencies: { enabled: boolean; value: number };
    singleMaintainer: boolean;
    prerelease: boolean;
    esmOnly: boolean;
    cjsOnly: boolean;
    // New visual highlights
    noRecentUpdates: { enabled: boolean; months: number };
    hasAvailableUpdates: boolean;
    unstableVersion: boolean; // 0.x, prerelease versions
    suspiciousVersion: boolean; // Non-conforming version patterns
    nonOsiLicense: { enabled: boolean; licenses: string };
    staleTopLevel: boolean;
}

interface WarningTogglesPanelProps {
    toggles: WarningToggles;
    onToggleChange: (toggles: WarningToggles) => void;
    micropackageThreshold?: number;
    onMicropackageThresholdChange?: (bytes: number) => void;
}

export function WarningTogglesPanel({ toggles, onToggleChange, micropackageThreshold = 6144, onMicropackageThresholdChange }: WarningTogglesPanelProps) {
    const [isOpen, setIsOpen] = useState(false);

    const handleToggle = (key: keyof WarningToggles) => {
        if (key === 'maxDependencies') {
            onToggleChange({
                ...toggles,
                maxDependencies: {
                    ...toggles.maxDependencies,
                    enabled: !toggles.maxDependencies.enabled
                }
            });
        } else if (key === 'noRecentUpdates') {
            onToggleChange({
                ...toggles,
                noRecentUpdates: {
                    ...toggles.noRecentUpdates,
                    enabled: !toggles.noRecentUpdates.enabled
                }
            });
        } else if (key === 'nonOsiLicense') {
            onToggleChange({
                ...toggles,
                nonOsiLicense: {
                    ...toggles.nonOsiLicense,
                    enabled: !toggles.nonOsiLicense.enabled
                }
            });
        } else {
            onToggleChange({
                ...toggles,
                [key]: !toggles[key]
            });
        }
    };

    const handleMaxDepsChange = (value: number) => {
        onToggleChange({
            ...toggles,
            maxDependencies: {
                ...toggles.maxDependencies,
                value
            }
        });
    };

    const handleNoRecentUpdatesChange = (months: number) => {
        onToggleChange({
            ...toggles,
            noRecentUpdates: {
                ...toggles.noRecentUpdates,
                months
            }
        });
    };

    const handleNonOsiLicenseChange = (licenses: string) => {
        onToggleChange({
            ...toggles,
            nonOsiLicense: {
                ...toggles.nonOsiLicense,
                licenses
            }
        });
    };

    return (
        <div style={{
            position: 'absolute',
            top: '16px',
            left: '16px',
            zIndex: 100
        }}>
            <button
                onClick={() => setIsOpen(!isOpen)}
                className="glass-panel-interactive"
                style={{
                    padding: '12px',
                    borderRadius: '8px',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    border: '1px solid var(--border-color)',
                    background: 'var(--bg-panel)',
                    color: 'var(--text-primary)',
                    fontSize: '14px',
                    fontWeight: 500
                }}
            >
                <Settings size={18} />
                Visual Highlights
            </button>

            {isOpen && (
                <div
                    className="glass-panel"
                    style={{
                        marginTop: '8px',
                        padding: '16px',
                        borderRadius: '8px',
                        minWidth: '280px',
                        maxHeight: '70vh',
                        overflowY: 'auto'
                    }}
                >
                    <h3 style={{
                        fontSize: '14px',
                        fontWeight: 600,
                        marginBottom: '12px',
                        color: 'var(--text-primary)',
                        borderBottom: '1px solid var(--border-color)',
                        paddingBottom: '8px'
                    }}>
                        Visual Highlights
                    </h3>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '16px' }}>
                        Enabled highlights will mark matching nodes with a colored border
                    </div>

                    {/* Micropackage Threshold */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '8px' }}>
                        <label style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            fontSize: '13px',
                            color: 'var(--text-primary)',
                            fontWeight: 500
                        }}>
                            Micropackage threshold
                        </label>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <input
                                type="number"
                                value={Math.round(micropackageThreshold / 1024)}
                                onChange={(e) => {
                                    const kb = parseInt(e.target.value) || 0;
                                    onMicropackageThresholdChange?.(Math.max(1, kb) * 1024);
                                }}
                                min="1"
                                className="glass-input"
                                style={{
                                    width: '70px',
                                    padding: '6px 10px',
                                    fontSize: '12px'
                                }}
                            />
                            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>KB</span>
                        </div>
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                            Packages under this size get a subtle yellow highlight
                        </div>
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                        {/* Max Dependencies */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                            <label style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '8px',
                                cursor: 'pointer',
                                fontSize: '13px',
                                color: 'var(--text-primary)'
                            }}>
                                <input
                                    type="checkbox"
                                    checked={toggles.maxDependencies.enabled}
                                    onChange={() => handleToggle('maxDependencies')}
                                    style={{ cursor: 'pointer' }}
                                />
                                More than X dependencies
                            </label>
                            {toggles.maxDependencies.enabled && (
                                <input
                                    type="number"
                                    value={toggles.maxDependencies.value}
                                    onChange={(e) => handleMaxDepsChange(parseInt(e.target.value) || 0)}
                                    min="0"
                                    className="glass-input"
                                    style={{
                                        marginLeft: '24px',
                                        width: 'calc(100% - 24px)',
                                        padding: '6px 10px',
                                        fontSize: '12px'
                                    }}
                                />
                            )}
                        </div>

                        {/* Single Maintainer */}
                        <label style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            cursor: 'pointer',
                            fontSize: '13px',
                            color: 'var(--text-primary)'
                        }}>
                            <input
                                type="checkbox"
                                checked={toggles.singleMaintainer}
                                onChange={() => handleToggle('singleMaintainer')}
                                style={{ cursor: 'pointer' }}
                            />
                            Only 1 maintainer
                        </label>

                        {/* Prerelease */}
                        <label style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            cursor: 'pointer',
                            fontSize: '13px',
                            color: 'var(--text-primary)'
                        }}>
                            <input
                                type="checkbox"
                                checked={toggles.prerelease}
                                onChange={() => handleToggle('prerelease')}
                                style={{ cursor: 'pointer' }}
                            />
                            Prerelease/alpha version
                        </label>

                        {/* No Recent Updates */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                            <label style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '8px',
                                cursor: 'pointer',
                                fontSize: '13px',
                                color: 'var(--text-primary)'
                            }}>
                                <input
                                    type="checkbox"
                                    checked={toggles.noRecentUpdates.enabled}
                                    onChange={() => handleToggle('noRecentUpdates')}
                                    style={{ cursor: 'pointer' }}
                                />
                                No updates in last X months
                            </label>
                            {toggles.noRecentUpdates.enabled && (
                                <input
                                    type="number"
                                    value={toggles.noRecentUpdates.months}
                                    onChange={(e) => handleNoRecentUpdatesChange(parseInt(e.target.value) || 24)}
                                    min="1"
                                    max="120"
                                    className="glass-input"
                                    style={{
                                        marginLeft: '24px',
                                        width: 'calc(100% - 24px)',
                                        padding: '6px 10px',
                                        fontSize: '12px'
                                    }}
                                />
                            )}
                        </div>

                        {/* Has Available Updates */}
                        <label style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            cursor: 'pointer',
                            fontSize: '13px',
                            color: 'var(--text-primary)'
                        }}>
                            <input
                                type="checkbox"
                                checked={toggles.hasAvailableUpdates}
                                onChange={() => handleToggle('hasAvailableUpdates')}
                                style={{ cursor: 'pointer' }}
                            />
                            Has available updates
                        </label>

                        {/* Unstable Version (0.x, prerelease) */}
                        <label style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            cursor: 'pointer',
                            fontSize: '13px',
                            color: 'var(--text-primary)'
                        }}>
                            <input
                                type="checkbox"
                                checked={toggles.unstableVersion}
                                onChange={() => handleToggle('unstableVersion')}
                                style={{ cursor: 'pointer' }}
                            />
                            Unstable version (0.x, prerelease)
                        </label>

                        {/* Suspicious Version Format */}
                        <label style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            cursor: 'pointer',
                            fontSize: '13px',
                            color: 'var(--text-primary)'
                        }}>
                            <input
                                type="checkbox"
                                checked={toggles.suspiciousVersion}
                                onChange={() => handleToggle('suspiciousVersion')}
                                style={{ cursor: 'pointer' }}
                            />
                            Suspicious version format
                        </label>

                        {/* Non-OSI License */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                            <label style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '8px',
                                cursor: 'pointer',
                                fontSize: '13px',
                                color: 'var(--text-primary)'
                            }}>
                                <input
                                    type="checkbox"
                                    checked={toggles.nonOsiLicense.enabled}
                                    onChange={() => handleToggle('nonOsiLicense')}
                                    style={{ cursor: 'pointer' }}
                                />
                                Non open-source license
                                <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }} className="license-tooltip-wrapper">
                                    <Info size={14} color="var(--text-muted)" />
                                    <div className="license-tooltip" style={{
                                        left: '50%',
                                        bottom: '150%',
                                        transform: 'translateX(-50%)',
                                        width: '260px',
                                        padding: '10px 12px',
                                        background: 'var(--bg-panel)',
                                        backdropFilter: 'blur(10px)',
                                        border: '1px solid var(--border-color)',
                                        borderRadius: '6px',
                                        fontSize: '13px',
                                        color: 'var(--text-secondary)',
                                        zIndex: 10000,
                                        boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
                                        lineHeight: '1.4'
                                    }}>
                                        <strong style={{ color: 'var(--text-primary)' }}>Default OSI-approved licenses:</strong><br/>
                                        MIT, Apache-2.0, BSD (2/3/0-clause), ISC, GPL/LGPL/AGPL, MPL-2.0, CC0, EPL, Artistic, PostgreSQL, Python-PSF, and 100+ others.<br/><br/>
                                        Proprietary, commercial, unlicensed, and unrecognized licenses are flagged.
                                    </div>
                                </div>
                            </label>
                            {toggles.nonOsiLicense.enabled && (
                                <input
                                    type="text"
                                    value={toggles.nonOsiLicense.licenses}
                                    onChange={(e) => handleNonOsiLicenseChange(e.target.value)}
                                    placeholder="Allowed Licenses: e.g. MIT, ISC"
                                    className="glass-input"
                                    style={{
                                        marginLeft: '24px',
                                        width: 'calc(100% - 24px)',
                                        padding: '6px 10px',
                                        fontSize: '12px'
                                    }}
                                />
                            )}
                        </div>

                        {/* Stale Direct Dependencies */}
                        <label style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            cursor: 'pointer',
                            fontSize: '13px',
                            color: 'var(--text-primary)'
                        }}>
                            <input
                                type="checkbox"
                                checked={toggles.staleTopLevel}
                                onChange={() => handleToggle('staleTopLevel')}
                                style={{ cursor: 'pointer' }}
                            />
                            Stale direct deps (no updates + outdated)
                        </label>

                        {/* Untyped packages */}
                        {/* <label style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            cursor: 'pointer',
                            fontSize: '13px',
                            color: 'var(--text-primary)'
                        }}>
                            <input
                                type="checkbox"
                                checked={toggles.typedOnly}
                                onChange={() => handleToggle('typedOnly')}
                                style={{ cursor: 'pointer' }}
                            />
                            Untyped packages
                        </label> */}

                        {/* ESM Only */}
                        {/* <label style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            cursor: 'pointer',
                            fontSize: '13px',
                            color: 'var(--text-primary)'
                        }}>
                            <input
                                type="checkbox"
                                checked={toggles.esmOnly}
                                onChange={() => handleToggle('esmOnly')}
                                style={{ cursor: 'pointer' }}
                            />
                            ESM only
                        </label> */}

                        {/* CJS Only */}
                        {/* <label style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            cursor: 'pointer',
                            fontSize: '13px',
                            color: 'var(--text-primary)'
                        }}>
                            <input
                                type="checkbox"
                                checked={toggles.cjsOnly}
                                onChange={() => handleToggle('cjsOnly')}
                                style={{ cursor: 'pointer' }}
                            />
                            CJS only
                        </label> */}
                    </div>
                </div>
            )}
        </div>
    );
}
