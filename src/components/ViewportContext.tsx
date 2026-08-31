import { useStoreApi } from '@xyflow/react';
import { useEffect, useMemo, useRef } from 'react';
import type { ViewportContextValue, ViewportSnapshot } from './viewportContext';
import { ViewportContext } from './viewportContext';

export function ViewportProvider({ children }: { children: React.ReactNode }) {
    const store = useStoreApi();
    const vpRef = useRef<ViewportSnapshot>({ x: 0, y: 0, zoom: 1, width: 0, height: 0 });
    const subscribers = useRef<Set<() => void>>(new Set());
    const rafRef = useRef<number | undefined>(undefined);

    useEffect(() => {
        const unsubscribe = store.subscribe((state) => {
            vpRef.current = {
                x: state.transform[0],
                y: state.transform[1],
                zoom: state.transform[2],
                width: state.width,
                height: state.height,
            };

            rafRef.current ??= requestAnimationFrame(() => {
                rafRef.current = undefined;
                subscribers.current.forEach((cb) => cb());
            });
        });

        return () => {
            unsubscribe();
            if (rafRef.current !== undefined) {
                cancelAnimationFrame(rafRef.current);
            }
        };
    }, [store]);

    const contextValue = useMemo<ViewportContextValue>(() => ({
        getViewport: () => vpRef.current,
        subscribe: (cb: () => void) => {
            subscribers.current.add(cb);
            return () => subscribers.current.delete(cb);
        },
    }), []);

    return (
        <ViewportContext.Provider value={contextValue}>
            {children}
        </ViewportContext.Provider>
    );
}

