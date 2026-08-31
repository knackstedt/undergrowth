import { createContext } from 'react';

export const VIEWPORT_BUFFER = 200;

export interface ViewportSnapshot {
    x: number;
    y: number;
    zoom: number;
    width: number;
    height: number;
}

export interface ViewportContextValue {
    getViewport: () => ViewportSnapshot;
    subscribe: (cb: () => void) => () => void;
}

export const ViewportContext = createContext<ViewportContextValue | null>(null);
