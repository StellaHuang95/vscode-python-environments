import { CancellationError } from 'vscode';
import * as rpc from 'vscode-jsonrpc/node';
import { RpcTimeoutError } from '../../managers/common/nativePythonFinder';
import { BaseError } from '../errors/types';

export type DiscoveryErrorType =
    | 'spawn_timeout'
    | 'spawn_enoent'
    | 'permission_denied'
    | 'canceled'
    | 'parse_error'
    | 'tool_not_found'
    | 'command_failed'
    | 'connection_error'
    | 'rpc_error'
    | 'rpc_timeout'
    | 'rpc_configure_timeout'
    | 'rpc_refresh_timeout'
    | 'rpc_resolve_timeout'
    | 'process_crash'
    | 'already_registered'
    | 'unknown';

/** Returns true for spawn and JSON-RPC timeout telemetry categories. */
export function isTimeoutErrorType(errorType: DiscoveryErrorType): boolean {
    return errorType === 'spawn_timeout' || errorType === 'rpc_timeout' ||
        (errorType.startsWith('rpc_') && errorType.endsWith('_timeout'));
}

/**
 * Returns true when `ex` indicates the PET JSON-RPC connection was lost mid-request. This is the
 * single source of truth for "PET connection loss" and covers BOTH shapes it can take:
 *  - {@link rpc.ConnectionError}: the transport itself failed.
 *  - {@link rpc.ResponseError} with {@link rpc.ErrorCodes.PendingResponseRejected}: an in-flight
 *    request was rejected because the connection was disposed. Ending a dead child's streams
 *    disposes its connection, so a crash now surfaces as this rejection rather than a
 *    ConnectionError — recovery and telemetry must treat the two identically.
 *
 * NOTE: This is a pure classifier and cannot tell an *intentional* disposal (extension shutdown or
 * an in-progress restart) apart from a crash. Callers that decide whether to restart/retry (as
 * opposed to merely categorizing for telemetry) MUST additionally gate on their own lifecycle
 * state so a self-inflicted disposal is not mistaken for a recoverable crash.
 */
export function isPetConnectionLostError(ex: unknown): boolean {
    return (
        ex instanceof rpc.ConnectionError ||
        (ex instanceof rpc.ResponseError && ex.code === rpc.ErrorCodes.PendingResponseRejected)
    );
}

/**
 * Classifies an error into a telemetry-safe category for the `errorType` property.
 * Does NOT include raw error messages — only the category.
 */
export function classifyError(ex: unknown): DiscoveryErrorType {
    if (ex instanceof CancellationError) {
        return 'canceled';
    }

    if (ex instanceof RpcTimeoutError) {
        switch (ex.method) {
            case 'configure':
                return 'rpc_configure_timeout';
            case 'refresh':
                return 'rpc_refresh_timeout';
            case 'resolve':
                return 'rpc_resolve_timeout';
            default:
                return 'rpc_timeout';
        }
    }

    // JSON-RPC connection loss: the PET process died mid-request (ConnectionError) or an in-flight
    // request was rejected because the connection was disposed during teardown (ResponseError with
    // PendingResponseRejected). Both mean the same thing for telemetry, so classify them together —
    // and BEFORE the generic ResponseError branch below, otherwise a dispose-driven rejection would
    // be mislabeled as a plain rpc_error.
    if (isPetConnectionLostError(ex)) {
        return 'connection_error';
    }

    // JSON-RPC response errors (PET returned an error response, e.g., internal error)
    if (ex instanceof rpc.ResponseError) {
        return 'rpc_error';
    }

    // BaseError subclasses: EnvironmentManagerAlreadyRegisteredError, PackageManagerAlreadyRegisteredError
    if (ex instanceof BaseError) {
        return 'already_registered';
    }

    if (!(ex instanceof Error)) {
        return 'unknown';
    }

    // Check error code for spawn failures (Node.js sets `code` on spawn errors)
    const code = (ex as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
        return 'spawn_enoent';
    }
    if (code === 'EACCES' || code === 'EPERM') {
        return 'permission_denied';
    }

    // Check message patterns (order matters — more specific patterns first)
    const msg = ex.message.toLowerCase();
    if (msg.includes('timed out') || msg.includes('timeout')) {
        return 'spawn_timeout';
    }

    // CLI command execution failures — checked before parse_error because command args
    // may contain words like "json" (e.g., 'Failed to run "conda info --envs --json"')
    if (msg.includes('failed to run') || msg.includes('error spawning')) {
        return 'command_failed';
    }

    if (msg.includes('parse') || msg.includes('unexpected token') || msg.includes('json')) {
        return 'parse_error';
    }

    // Tool/executable not found — e.g., "Conda not found", "Python extension not found",
    // "Poetry executable not found"
    if (msg.includes('not found')) {
        return 'tool_not_found';
    }

    // PET process crash/hang recovery failures — e.g., "PET is currently restarting",
    // "failed after 3 restart attempts", "Failed to create stdio streams for PET process"
    if (msg.includes('restart') || msg.includes('stdio stream')) {
        return 'process_crash';
    }

    // Check error name for cancellation variants
    if (ex.name === 'CancellationError' || ex.name === 'AbortError') {
        return 'canceled';
    }

    return 'unknown';
}
