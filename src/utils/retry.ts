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
 * Retries a function with exponential backoff on transient errors.
 * Throws immediately (without retrying) if a PermanentError is thrown.
 */
export async function withRetry<T>(
    fn: () => Promise<T>,
    maxRetries: number = 5,
    initialDelay: number = 2500
): Promise<T> {
    let lastError: unknown;

    for (let i = 0; i < maxRetries; i++) {
        try {
            return await fn();
        } catch (err: unknown) {
            // Don't retry permanent failures (e.g. 404 Not Found)
            if (err instanceof PermanentError) {
                throw err;
            }

            lastError = err;

            // Don't wait on the last attempt
            if (i < maxRetries - 1) {
                const delay = initialDelay * Math.pow(2, i);
                const errorMsg = err instanceof Error ? err.message : String(err);
                console.warn(`Attempt ${i + 1} failed: ${errorMsg}. Retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    throw lastError || new Error('Max retries reached');
}
