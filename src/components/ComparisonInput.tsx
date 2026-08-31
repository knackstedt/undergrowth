import { ArrowRightLeft, FileUp, Package, X } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { parsePackageVersion } from '../utils/urlState';

export interface ComparisonSpec {
    type: 'package' | 'file';
    source: 'npm' | 'pypi' | 'crates' | 'go' | 'nuget';
    name?: string;
    version?: string;
    file?: File;
    fileContent?: string;
}

export interface ComparisonInputProps {
    left: ComparisonSpec | null;
    right: ComparisonSpec | null;
    onLeftChange: (spec: ComparisonSpec | null) => void;
    onRightChange: (spec: ComparisonSpec | null) => void;
    onCompare: () => void;
    isLoading: boolean;
}

interface DragState {
    isDragging: boolean;
    side: 'left' | 'right' | null;
}

export function ComparisonInput({
    left,
    right,
    onLeftChange,
    onRightChange,
    onCompare,
    isLoading
}: ComparisonInputProps) {
    const [dragState, setDragState] = useState<DragState>({ isDragging: false, side: null });
    const [leftInput, setLeftInput] = useState('');
    const [rightInput, setRightInput] = useState('');
    const [leftRegistry, setLeftRegistry] = useState<'npm' | 'pypi' | 'crates' | 'go' | 'nuget'>('npm');
    const [rightRegistry, setRightRegistry] = useState<'npm' | 'pypi' | 'crates' | 'go' | 'nuget'>('npm');
    const leftInputRef = useRef<HTMLInputElement>(null);
    const rightInputRef = useRef<HTMLInputElement>(null);

    const handleDragOver = useCallback((e: DragEvent, side: 'left' | 'right') => {
        e.preventDefault();
        if (e.dataTransfer?.types.includes('Files')) {
            setDragState({ isDragging: true, side });
        }
    }, []);

    const handleDragLeave = useCallback((e: DragEvent) => {
        if (e.relatedTarget === null) {
            setDragState({ isDragging: false, side: null });
        }
    }, []);

    const processFile = async (file: File): Promise<ComparisonSpec | null> => {
        const content = await file.text();

        if (file.name === 'package.json') {
            try {
                const pkg = JSON.parse(content);
                return {
                    type: 'file',
                    source: 'npm',
                    name: pkg.name,
                    version: pkg.version,
                    file,
                    fileContent: content
                };
            } catch {
                return null;
            }
        } else if (file.name === 'requirements.txt' || file.name.endsWith('.txt')) {
            return {
                type: 'file',
                source: 'pypi',
                name: file.name.replace('.txt', ''),
                version: 'local',
                file,
                fileContent: content
            };
        } else if (file.name === 'go.mod') {
            const moduleMatch = content.match(/^module\s+(\S+)/m);
            const moduleName = moduleMatch ? moduleMatch[1] : file.name.replace('.mod', '');
            return {
                type: 'file',
                source: 'go',
                name: moduleName,
                version: 'local',
                file,
                fileContent: content
            };
        } else if (file.name === 'Cargo.toml') {
            try {
                // Basic TOML parsing for name
                const nameMatch = content.match(/name\s*=\s*"([^"]+)"/);
                const versionMatch = content.match(/version\s*=\s*"([^"]+)"/);
                return {
                    type: 'file',
                    source: 'crates',
                    name: nameMatch?.[1] || file.name.replace('.toml', ''),
                    version: versionMatch?.[1] || 'local',
                    file,
                    fileContent: content
                };
            } catch {
                return null;
            }
        } else if (file.name.endsWith('.csproj')) {
            try {
                const parser = new DOMParser();
                const doc = parser.parseFromString(content, 'application/xml');
                const packageId = doc.querySelector('PackageId')?.textContent;
                const version = doc.querySelector('Version')?.textContent;
                return {
                    type: 'file',
                    source: 'nuget',
                    name: packageId || file.name.replace('.csproj', ''),
                    version: version || 'local',
                    file,
                    fileContent: content
                };
            } catch {
                return null;
            }
        }

        return null;
    };

    const handleDrop = useCallback(async (e: DragEvent, side: 'left' | 'right') => {
        e.preventDefault();
        setDragState({ isDragging: false, side: null });

        const file = e.dataTransfer?.files?.[0];
        if (!file) return;

        const spec = await processFile(file);
        if (spec) {
            if (side === 'left') {
                onLeftChange(spec);
            } else {
                onRightChange(spec);
            }
        }
    }, [onLeftChange, onRightChange]);

    const handleLeftSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!leftInput.trim()) return;

        const { name, version } = parsePackageVersion(leftInput.trim());
        onLeftChange({
            type: 'package',
            source: leftRegistry,
            name,
            version
        });
    };

    const handleRightSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!rightInput.trim()) return;

        const { name, version } = parsePackageVersion(rightInput.trim());
        onRightChange({
            type: 'package',
            source: rightRegistry,
            name,
            version
        });
    };

    const clearSide = (side: 'left' | 'right') => {
        if (side === 'left') {
            onLeftChange(null);
            setLeftInput('');
        } else {
            onRightChange(null);
            setRightInput('');
        }
    };

    const swapSides = () => {
        const tempLeft = left;
        const tempRight = right;
        const tempLeftInput = leftInput;
        const tempRightInput = rightInput;
        const tempLeftRegistry = leftRegistry;
        const tempRightRegistry = rightRegistry;

        onLeftChange(tempRight);
        onRightChange(tempLeft);
        setLeftInput(tempRightInput);
        setRightInput(tempLeftInput);
        setLeftRegistry(tempRightRegistry);
        setRightRegistry(tempLeftRegistry);
    };

    // When left ecosystem is set, enforce it for right side
    const effectiveLeftRegistry = leftRegistry;
    const effectiveRightRegistry = left?.source || rightRegistry;

    const renderSide = (side: 'left' | 'right', spec: ComparisonSpec | null) => {
        const isActive = dragState.isDragging && dragState.side === side;
        const isLeft = side === 'left';
        const inputValue = isLeft ? leftInput : rightInput;
        const setInput = isLeft ? setLeftInput : setRightInput;
        // For right side, use left's ecosystem if left is set
        const registry = isLeft ? effectiveLeftRegistry : effectiveRightRegistry;
        const setRegistry = isLeft ? setLeftRegistry : setRightRegistry;
        const handleSubmit = isLeft ? handleLeftSubmit : handleRightSubmit;
        const inputRef = isLeft ? leftInputRef : rightInputRef;
        // Disable registry selector for right side if left is set (must match ecosystem)
        const isRegistryDisabled = !isLeft && left !== null;

        return (
            <div
                onDragOver={(e) => handleDragOver(e.nativeEvent, side)}
                onDragLeave={(e) => handleDragLeave(e.nativeEvent)}
                onDrop={(e) => handleDrop(e.nativeEvent, side)}
                style={{
                    flex: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '12px',
                    padding: '20px',
                    borderRadius: '12px',
                    border: `2px dashed ${isActive ? 'var(--accent-blue)' : spec ? 'var(--accent-emerald)' : 'var(--border-color)'}`,
                    background: isActive ? 'rgba(59, 130, 246, 0.1)' : spec ? 'rgba(16, 185, 129, 0.05)' : 'var(--glass-bg)',
                    transition: 'all 0.2s ease',
                    position: 'relative',
                    minHeight: '200px'
                }}
            >
                {spec && (
                    <button
                        onClick={() => clearSide(side)}
                        style={{
                            position: 'absolute',
                            top: '12px',
                            right: '12px',
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                            color: 'var(--text-muted)',
                            padding: '4px',
                            display: 'flex'
                        }}
                    >
                        <X size={18} />
                    </button>
                )}

                <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)' }}>
                    {isLeft ? 'Previous Version' : 'New Version'}
                </div>

                {spec ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            {spec.type === 'file' ? <FileUp size={20} color="var(--accent-blue)" /> : <Package size={20} color="var(--accent-blue)" />}
                            <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                                {spec.name}
                            </span>
                        </div>
                        {spec.version && (
                            <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginLeft: '28px' }}>
                                Version: {spec.version}
                            </div>
                        )}
                        {spec.type === 'file' && spec.file && (
                            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginLeft: '28px' }}>
                                File: {spec.file.name}
                            </div>
                        )}
                        <div style={{ fontSize: '12px', color: 'var(--accent-amber)', marginLeft: '28px', textTransform: 'uppercase' }}>
                            {spec.source}
                        </div>
                    </div>
                ) : (
                    <>
                        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                            <div style={{ display: 'flex', gap: '8px' }}>
                                <select
                                    value={registry}
                                    onChange={e => {
                                        setRegistry(e.target.value as typeof registry);
                                        // When left ecosystem changes, reset right side to match
                                        if (isLeft) {
                                            setRightRegistry(e.target.value as typeof registry);
                                        }
                                    }}
                                    disabled={isRegistryDisabled}
                                    style={{
                                        background: 'var(--glass-bg)',
                                        border: '1px solid var(--glass-border)',
                                        borderRadius: '6px',
                                        padding: '6px 10px',
                                        color: 'var(--text-primary)',
                                        fontSize: '12px',
                                        cursor: isRegistryDisabled ? 'not-allowed' : 'pointer',
                                        opacity: isRegistryDisabled ? 0.5 : 1
                                    }}
                                >
                                    <option value="npm">npm</option>
                                    <option value="pypi">PyPI</option>
                                    <option value="crates">Rust</option>
                                    <option value="go">Go</option>
                                    <option value="nuget">NuGet</option>
                                </select>
                                <input
                                    ref={inputRef}
                                    type="text"
                                    value={inputValue}
                                    onChange={e => setInput(e.target.value)}
                                    onBlur={handleSubmit}
                                    placeholder="package@version"
                                    className="glass-input"
                                    style={{ flex: 1, fontSize: '13px', padding: '6px 10px' }}
                                />
                            </div>
                            {!isLeft && left && (
                                <div style={{
                                    fontSize: '11px',
                                    color: 'var(--text-muted)',
                                    textAlign: 'center'
                                }}>
                                    Must match left side ecosystem ({left.source})
                                </div>
                            )}
                        </form>

                        <div style={{
                            textAlign: 'center',
                            fontSize: '12px',
                            color: 'var(--text-muted)',
                            padding: '16px 0',
                            borderTop: '1px solid var(--border-color)',
                            marginTop: '8px'
                        }}>
                            — or drop a manifest file —
                        </div>

                        <div style={{
                            fontSize: '11px',
                            color: 'var(--text-muted)',
                            textAlign: 'center'
                        }}>
                            package.json, requirements.txt, go.mod, Cargo.toml, .csproj
                        </div>
                    </>
                )}
            </div>
        );
    };

    const canCompare = left !== null && right !== null;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', height: '100%' }}>
            <div style={{ display: 'flex', gap: '16px', alignItems: 'stretch' }}>
                {renderSide('left', left)}

                <button
                    onClick={swapSides}
                    disabled={!left && !right}
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        padding: '12px',
                        background: 'var(--glass-bg)',
                        border: '1px solid var(--glass-border)',
                        borderRadius: '8px',
                        cursor: (!left && !right) ? 'not-allowed' : 'pointer',
                        color: (!left && !right) ? 'var(--text-muted)' : 'var(--text-primary)',
                        transition: 'all 0.15s ease'
                    }}
                    title="Swap sides"
                >
                    <ArrowRightLeft size={20} />
                </button>

                {renderSide('right', right)}
            </div>

            <button
                onClick={onCompare}
                disabled={!canCompare || isLoading}
                className="primary"
                style={{
                    width: '100%',
                    padding: '12px 24px',
                    fontSize: '14px',
                    fontWeight: 600,
                    opacity: canCompare ? 1 : 0.5,
                    cursor: canCompare ? 'pointer' : 'not-allowed'
                }}
            >
                {isLoading ? 'Comparing...' : 'Compare Versions'}
            </button>
        </div>
    );
}
