/**
 * Persistent cache service using IndexedDB with TTL support.
 * - Registry data: 1 month TTL
 */

const DB_NAME = 'undergrowth-cache';
const DB_VERSION = 1;
const STORE_REGISTRY = 'registry';

// TTL constants in milliseconds
const REGISTRY_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

interface CacheEntry<T> {
    key: string;
    data: T;
    timestamp: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);

        request.onupgradeneeded = (event) => {
            const db = (event.target as IDBOpenDBRequest).result;
            if (!db.objectStoreNames.contains(STORE_REGISTRY)) {
                db.createObjectStore(STORE_REGISTRY, { keyPath: 'key' });
            }
        };
    });

    return dbPromise;
}

async function get<T>(storeName: string, key: string, ttl: number): Promise<T | null> {
    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(storeName, 'readonly');
            const store = transaction.objectStore(storeName);
            const request = store.get(key);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const entry: CacheEntry<T> | undefined = request.result;
                if (!entry) {
                    resolve(null);
                    return;
                }

                const age = Date.now() - entry.timestamp;
                if (age > ttl) {
                    // Entry expired, delete it
                    deleteEntry(storeName, key);
                    resolve(null);
                    return;
                }

                resolve(entry.data);
            };
        });
    } catch (err) {
        console.warn(`Cache get failed for ${key}:`, err);
        return null;
    }
}

async function set<T>(storeName: string, key: string, data: T): Promise<void> {
    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(storeName, 'readwrite');
            const store = transaction.objectStore(storeName);
            const entry: CacheEntry<T> = {
                key,
                data,
                timestamp: Date.now()
            };
            const request = store.put(entry);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve();
        });
    } catch (err) {
        console.warn(`Cache set failed for ${key}:`, err);
    }
}

async function deleteEntry(storeName: string, key: string): Promise<void> {
    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(storeName, 'readwrite');
            const store = transaction.objectStore(storeName);
            const request = store.delete(key);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve();
        });
    } catch (err) {
        console.warn(`Cache delete failed for ${key}:`, err);
    }
}

/**
 * In-memory cache for promises to prevent duplicate in-flight requests
 */
const inFlightRegistry = new Map<string, Promise<unknown>>();

export const PersistentCache = {
    /**
     * Get registry data from cache
     */
    async getRegistry<T>(key: string): Promise<T | null> {
        const data = await get<T>(STORE_REGISTRY, key, REGISTRY_TTL);
        if (data) {
            // DEBUG: Check if license data is in cached data
            const pkgName = key.replace('npm:', '');
            const versions = (data as { versions?: Record<string, { license?: string }> })?.versions || {};
            const firstVersion = Object.values(versions)[0];
            console.log(`[Cache Get] ${pkgName} from IndexedDB has license:`, JSON.stringify(firstVersion?.license));
        }
        return data;
    },

    /**
     * Set registry data in cache
     */
    async setRegistry<T>(key: string, data: T): Promise<void> {
        // DEBUG: Verify license is in data being stored
        const pkgName = key.replace('npm:', '');
        const versions = (data as { versions?: Record<string, { license?: string }> })?.versions || {};
        const firstVersion = Object.values(versions)[0];
        console.log(`[Cache Set] ${pkgName} storing to IndexedDB with license:`, JSON.stringify(firstVersion?.license));
        return set<T>(STORE_REGISTRY, key, data);
    },



    /**
     * Get or compute registry data with deduplication
     */
    async getOrComputeRegistry<T>(key: string, compute: () => Promise<T>): Promise<T> {
        // Check persistent cache first
        const cached = await this.getRegistry(key) as T | null;
        if (cached !== null) {
            return cached;
        }

        // Check in-flight requests
        const existing = inFlightRegistry.get(key);
        if (existing) {
            return existing as Promise<T>;
        }

        // Execute computation
        const promise = compute().then(async (result) => {
            await this.setRegistry(key, result);
            inFlightRegistry.delete(key);
            return result;
        }).catch((err) => {
            inFlightRegistry.delete(key);
            throw err;
        });

        inFlightRegistry.set(key, promise);
        return promise;
    },


    /**
     * Clear all cache data
     */
    async clear(): Promise<void> {
        inFlightRegistry.clear();

        try {
            const db = await openDB();
            await new Promise<void>((resolve, reject) => {
                const tx = db.transaction(STORE_REGISTRY, 'readwrite');
                const store = tx.objectStore(STORE_REGISTRY);
                const req = store.clear();
                req.onerror = () => reject(req.error);
                req.onsuccess = () => resolve();
            });
        } catch (err) {
            console.warn('Cache clear failed:', err);
        }
    },

    /**
     * Get cache statistics
     */
    async getStats(): Promise<{ registry: number }> {
        try {
            const db = await openDB();
            const registryCount = await new Promise<number>((resolve, reject) => {
                const tx = db.transaction(STORE_REGISTRY, 'readonly');
                const store = tx.objectStore(STORE_REGISTRY);
                const req = store.count();
                req.onerror = () => reject(req.error);
                req.onsuccess = () => resolve(req.result);
            });
            return { registry: registryCount };
        } catch (err) {
            console.warn('Cache stats failed:', err);
            return { registry: 0 };
        }
    }
};
