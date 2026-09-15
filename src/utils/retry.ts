/**
 * Thrown when the error is permanent and should not be retried (e.g. 404 Not Found).
 */
export class PermanentError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PermanentError';
    }
}

/**
 * Thrown when the caller aborts the operation. Propagates without retrying.
 */
export class AbortedError extends Error {
    constructor() {
        super('Aborted');
        this.name = 'AbortedError';
    }
}

export function isAbortError(err: unknown): boolean {
    return err instanceof AbortedError
        || (err instanceof DOMException && err.name === 'AbortError')
        || (err instanceof Error && err.message === 'Aborted');
}

/**
 * Retries a function with exponential backoff on transient errors.
 * Throws immediately (without retrying) if a PermanentError is thrown or the
 * provided AbortSignal fires.
 */
export async function withRetry<T>(
    fn: () => Promise<T>,
    maxRetries: number = 5,
    initialDelay: number = 2500,
    signal?: AbortSignal
): Promise<T> {
    let lastError: unknown;

    for (let i = 0; i < maxRetries; i++) {
        if (signal?.aborted) throw new AbortedError();
        try {
            return await fn();
        } catch (err: unknown) {
            // Don't retry permanent failures (e.g. 404 Not Found) or aborts
            if (err instanceof PermanentError || isAbortError(err) || signal?.aborted) {
                throw isAbortError(err) || signal?.aborted ? new AbortedError() : err;
            }

            lastError = err;

            // Don't wait on the last attempt
            if (i < maxRetries - 1) {
                const delay = initialDelay * Math.pow(2, i);
                const errorMsg = err instanceof Error ? err.message : String(err);
                console.warn(`Attempt ${i + 1} failed: ${errorMsg}. Retrying in ${delay}ms...`);
                await new Promise<void>((resolve, reject) => {
                    const timer = setTimeout(() => {
                        signal?.removeEventListener('abort', onAbort);
                        resolve();
                    }, delay);
                    const onAbort = () => {
                        clearTimeout(timer);
                        reject(new AbortedError());
                    };
                    signal?.addEventListener('abort', onAbort, { once: true });
                });
            }
        }
    }

    throw lastError || new Error('Max retries reached');
}
