import { Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { TimelineVersion } from '../graph/timeline';

interface TimelineControlsProps {
    versions: TimelineVersion[];
    currentIndex: number;
    isPlaying: boolean;
    onPlay: () => void;
    onPause: () => void;
    onSeek: (index: number) => void;
    onSpeedChange: (speed: number) => void;
    animationSpeed: number;
    cachedIndices?: Set<number>;
}

export function TimelineControls({
    versions,
    currentIndex,
    isPlaying,
    onPlay,
    onPause,
    onSeek,
    onSpeedChange,
    animationSpeed,
    cachedIndices = new Set()
}: TimelineControlsProps) {
    const [inputValue, setInputValue] = useState('');
    const [isDragging, setIsDragging] = useState(false);
    const trackRef = useRef<HTMLDivElement>(null);
    const inputKey = useRef(0);

    // Reset input when version changes externally (via play/seek)
    const currentVersion = versions[currentIndex]?.version ?? '';
    useEffect(() => {
        setInputValue(currentVersion);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentVersion, inputKey.current]);

    const handleInputSubmit = useCallback((e: React.FormEvent) => {
        e.preventDefault();

        // Find closest version matching input
        const input = inputValue.trim().toLowerCase();
        if (!input) return;

        // Try exact match first
        let index = versions.findIndex(v => v.version.toLowerCase() === input);

        // Try prefix match
        if (index === -1) {
            index = versions.findIndex(v => v.version.toLowerCase().startsWith(input));
        }

        // Try contains match
        if (index === -1) {
            index = versions.findIndex(v => v.version.toLowerCase().includes(input));
        }

        if (index !== -1) {
            onSeek(index);
        }
    }, [inputValue, versions, onSeek]);

    const handleTrackClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        if (!trackRef.current || versions.length === 0) return;

        const rect = trackRef.current.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const percentage = Math.max(0, Math.min(1, x / rect.width));
        const index = Math.round(percentage * (versions.length - 1));

        onSeek(index);
    }, [versions.length, onSeek]);

    const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        setIsDragging(true);
        handleTrackClick(e);
    }, [handleTrackClick]);

    const handleMouseMove = useCallback((e: MouseEvent) => {
        if (!isDragging || !trackRef.current || versions.length === 0) return;

        const rect = trackRef.current.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const percentage = Math.max(0, Math.min(1, x / rect.width));
        const index = Math.round(percentage * (versions.length - 1));

        onSeek(index);
    }, [isDragging, versions.length, onSeek]);

    const handleMouseUp = useCallback(() => {
        setIsDragging(false);
    }, []);

    useEffect(() => {
        if (isDragging) {
            window.addEventListener('mousemove', handleMouseMove);
            window.addEventListener('mouseup', handleMouseUp);
            return () => {
                window.removeEventListener('mousemove', handleMouseMove);
                window.removeEventListener('mouseup', handleMouseUp);
            };
        }
    }, [isDragging, handleMouseMove, handleMouseUp]);

    const handlePrevious = useCallback(() => {
        if (currentIndex > 0) {
            onSeek(currentIndex - 1);
        }
    }, [currentIndex, onSeek]);

    const handleNext = useCallback(() => {
        if (currentIndex < versions.length - 1) {
            onSeek(currentIndex + 1);
        }
    }, [currentIndex, versions.length, onSeek]);

    const progressPercentage = versions.length > 1
        ? (currentIndex / (versions.length - 1)) * 100
        : 0;

    // Generate tick marks (show every Nth version based on count)
    const getTickInterval = () => {
        if (versions.length <= 10) return 1;
        if (versions.length <= 30) return 2;
        if (versions.length <= 50) return 5;
        return Math.ceil(versions.length / 20);
    };

    const tickInterval = getTickInterval();
    const ticks = versions.filter((_, i) => i % tickInterval === 0);

    return (
        <div style={{
            position: 'absolute',
            bottom: '20px',
            left: '50%',
            transform: 'translateX(-50%)',
            width: 'min(800px, 90vw)',
            background: 'rgba(30, 41, 59, 0.9)',
            backdropFilter: 'blur(10px)',
            borderRadius: '12px',
            padding: '16px 20px',
            border: '1px solid var(--glass-border)',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
            zIndex: 50
        }}>
            {/* Top row: version info and controls */}
            <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '16px'
            }}>
                {/* Version display */}
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    minWidth: '140px'
                }}>
                    <div style={{
                        fontSize: '18px',
                        fontWeight: 700,
                        color: 'var(--accent-blue)'
                    }}>
                        {versions[currentIndex]?.version || '—'}
                    </div>
                    <div style={{
                        fontSize: '11px',
                        color: 'var(--text-muted)'
                    }}>
                        {versions[currentIndex]?.date
                            ? new Date(versions[currentIndex].date).toLocaleDateString()
                            : ''}
                    </div>
                </div>

                {/* Playback controls */}
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px'
                }}>
                    <button
                        onClick={handlePrevious}
                        disabled={currentIndex === 0}
                        style={{
                            padding: '8px',
                            borderRadius: '6px',
                            background: 'var(--glass-bg)',
                            border: '1px solid var(--glass-border)',
                            color: currentIndex === 0 ? 'var(--text-muted)' : 'var(--text-primary)',
                            cursor: currentIndex === 0 ? 'not-allowed' : 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center'
                        }}
                    >
                        <SkipBack size={18} />
                    </button>

                    <button
                        onClick={isPlaying ? onPause : onPlay}
                        style={{
                            padding: '10px 20px',
                            borderRadius: '6px',
                            background: isPlaying ? 'var(--accent-amber)' : 'var(--accent-emerald)',
                            border: 'none',
                            color: 'white',
                            fontWeight: 600,
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '6px'
                        }}
                    >
                        {isPlaying ? (
                            <><Pause size={18} /> Pause</>
                        ) : (
                            <><Play size={18} /> Play</>
                        )}
                    </button>

                    <button
                        onClick={handleNext}
                        disabled={currentIndex >= versions.length - 1}
                        style={{
                            padding: '8px',
                            borderRadius: '6px',
                            background: 'var(--glass-bg)',
                            border: '1px solid var(--glass-border)',
                            color: currentIndex >= versions.length - 1 ? 'var(--text-muted)' : 'var(--text-primary)',
                            cursor: currentIndex >= versions.length - 1 ? 'not-allowed' : 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center'
                        }}
                    >
                        <SkipForward size={18} />
                    </button>
                </div>

                {/* Speed control and version input */}
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px'
                }}>
                    {/* Version jump input */}
                    <form onSubmit={handleInputSubmit} style={{ display: 'flex', gap: '4px' }}>
                        <input
                            key={`input-${inputKey.current}`}
                            type="text"
                            defaultValue={currentVersion}
                            onChange={(e) => setInputValue(e.target.value)}
                            placeholder="Jump to version..."
                            style={{
                                padding: '6px 10px',
                                borderRadius: '6px',
                                background: 'var(--glass-bg)',
                                border: '1px solid var(--glass-border)',
                                color: 'var(--text-primary)',
                                fontSize: '12px',
                                width: '130px'
                            }}
                        />
                        <button
                            type="submit"
                            style={{
                                padding: '6px 10px',
                                borderRadius: '6px',
                                background: 'var(--accent-blue)',
                                border: 'none',
                                color: 'white',
                                fontSize: '12px',
                                cursor: 'pointer'
                            }}
                        >
                            Go
                        </button>
                    </form>

                    {/* Speed control */}
                    <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        fontSize: '12px',
                        color: 'var(--text-secondary)'
                    }}>
                        <span>Speed:</span>
                        <select
                            value={animationSpeed}
                            onChange={(e) => onSpeedChange(Number(e.target.value))}
                            style={{
                                padding: '6px 8px',
                                borderRadius: '6px',
                                background: 'var(--glass-bg)',
                                border: '1px solid var(--glass-border)',
                                color: 'var(--text-primary)',
                                fontSize: '12px',
                                cursor: 'pointer'
                            }}
                        >
                            <option value={500}>0.5s</option>
                            <option value={1000}>1s</option>
                            <option value={1500}>1.5s</option>
                            <option value={2000}>2s</option>
                            <option value={3000}>3s</option>
                            <option value={5000}>5s</option>
                        </select>
                    </div>
                </div>
            </div>

            {/* Timeline track */}
            <div
                ref={trackRef}
                onClick={handleTrackClick}
                onMouseDown={handleMouseDown}
                style={{
                    position: 'relative',
                    height: '32px',
                    background: 'rgba(0,0,0,0.3)',
                    borderRadius: '6px',
                    cursor: isDragging ? 'grabbing' : 'pointer',
                    overflow: 'hidden'
                }}
            >
                {/* Buffered/cached regions - like YouTube's buffered progress */}
                {Array.from(cachedIndices).map(index => {
                    const startPct = (index / (versions.length - 1)) * 100;
                    const widthPct = versions.length > 1 ? (1 / (versions.length - 1)) * 100 : 100;
                    return (
                        <div
                            key={`cached-${index}`}
                            style={{
                                position: 'absolute',
                                left: `${startPct}%`,
                                top: 0,
                                bottom: 0,
                                width: `${Math.max(widthPct, 0.5)}%`,
                                background: 'rgba(255,255,255,0.15)',
                                borderRadius: '2px'
                            }}
                        />
                    );
                })}

                {/* Progress bar */}
                <div style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    bottom: 0,
                    width: `${progressPercentage}%`,
                    background: 'linear-gradient(90deg, var(--accent-blue), var(--accent-purple))',
                    borderRadius: '6px',
                    transition: isDragging ? 'none' : 'width 0.3s ease'
                }} />

                {/* Tick marks */}
                {ticks.map((version, i) => {
                    const position = (i * tickInterval / (versions.length - 1)) * 100;
                    return (
                        <div
                            key={version.version}
                            style={{
                                position: 'absolute',
                                left: `${position}%`,
                                top: 0,
                                bottom: 0,
                                width: '2px',
                                background: 'rgba(255,255,255,0.2)',
                                transform: 'translateX(-50%)'
                            }}
                        />
                    );
                })}

                {/* Handle */}
                <div style={{
                    position: 'absolute',
                    left: `${progressPercentage}%`,
                    top: '50%',
                    transform: 'translate(-50%, -50%)',
                    width: '16px',
                    height: '16px',
                    background: 'white',
                    borderRadius: '50%',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
                    transition: isDragging ? 'none' : 'left 0.3s ease',
                    pointerEvents: 'none'
                }} />

                {/* Version labels (show every few) */}
                {versions.length <= 15 && versions.map((version, i) => {
                    const position = (i / (versions.length - 1)) * 100;
                    return (
                        <div
                            key={version.version}
                            style={{
                                position: 'absolute',
                                left: `${position}%`,
                                bottom: '2px',
                                transform: 'translateX(-50%)',
                                fontSize: '9px',
                                color: i === currentIndex ? 'white' : 'var(--text-muted)',
                                fontWeight: i === currentIndex ? 600 : 400,
                                whiteSpace: 'nowrap',
                                pointerEvents: 'none'
                            }}
                        >
                            {version.version}
                        </div>
                    );
                })}
            </div>

            {/* Counter */}
            <div style={{
                display: 'flex',
                justifyContent: 'center',
                fontSize: '12px',
                color: 'var(--text-muted)'
            }}>
                {currentIndex + 1} of {versions.length} versions
            </div>
        </div>
    );
}
