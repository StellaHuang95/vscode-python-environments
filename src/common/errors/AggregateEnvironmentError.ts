/**
 * Minimal, dependency-free stand-in for the native `AggregateError`.
 *
 * The extension targets the ES2020 lib, which does not ship `AggregateError` typings, so a broad
 * `tsconfig` lib bump would be required to use the native type. This local class keeps the same
 * observable shape (a `message` plus an `errors` array of the underlying reasons) without touching
 * the compiler configuration.
 */
export class AggregateEnvironmentError extends Error {
    /**
     * The individual reasons that were aggregated, in the original manager order.
     */
    public readonly errors: unknown[];

    /**
     * @param message Human readable summary of the aggregated failure.
     * @param errors The underlying rejection reasons, preserved in manager order.
     */
    constructor(message: string, errors: unknown[]) {
        super(message);
        this.name = 'AggregateEnvironmentError';
        this.errors = [...errors];
    }
}
