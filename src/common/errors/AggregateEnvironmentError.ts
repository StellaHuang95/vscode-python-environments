// Minimal stand-in for `AggregateError` (absent from the ES2020 lib the extension targets); carries
// the aggregated `errors` without requiring a tsconfig lib bump.
export class AggregateEnvironmentError extends Error {
    public readonly errors: unknown[];

    constructor(message: string, errors: unknown[]) {
        super(message);
        this.name = 'AggregateEnvironmentError';
        this.errors = [...errors];
    }
}
