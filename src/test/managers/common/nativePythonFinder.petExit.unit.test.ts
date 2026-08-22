// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as sinon from 'sinon';
import * as rpc from 'vscode-jsonrpc/node';
import { PythonProjectApi } from '../../../api';
import * as childProcessApis from '../../../common/childProcess.apis';
import { NativePythonFinderImpl } from '../../../managers/common/nativePythonFinder';

/**
 * Minimal fake of a spawned PET server child process. Uses real {@link PassThrough} streams so
 * the production code drives a REAL vscode-jsonrpc connection (StreamMessageReader/Writer) — only
 * the child is faked. Termination is driven explicitly via {@link simulateExit}/{@link simulateError}
 * so tests are fully deterministic (no real process, no real timers on the hot path).
 */
class FakeChild extends EventEmitter {
    public readonly stdout = new PassThrough();
    public readonly stderr = new PassThrough();
    public readonly stdin = new PassThrough();
    public exitCode: number | null = null;
    public killed = false;

    public kill(_signal?: NodeJS.Signals | number): boolean {
        this.killed = true;
        return true;
    }

    /** Simulate the OS `exit` event for this child. */
    public simulateExit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
        this.markExited(code);
        this.emit('exit', code, signal);
    }

    /** Simulate the `error` event (e.g. ENOENT / spawn failure) for this child. */
    public simulateError(err: Error): void {
        // An errored child is effectively gone; mark it terminated so disposal doesn't schedule a
        // real 500ms graceful-kill timer (which would otherwise linger past the test).
        this.markExited();
        this.emit('error', err);
    }

    /** Mark the process as no longer running so disposal doesn't schedule kill timers. */
    public markExited(code: number | null = 0): void {
        if (this.exitCode === null) {
            this.exitCode = code ?? 0;
        }
    }
}

/** Resolves after pending microtasks + one macrotask so stream writes/RPC registration flush. */
function flush(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Validator for {@link assert.rejects} asserting the rejection is the specific dispose-driven
 * rejection the fix targets (`ResponseError` with code `PendingResponseRejected`), not some other
 * incidental error — proving the pending request was rejected by the connection being disposed.
 */
function isPendingResponseRejected(message: string): (err: unknown) => boolean {
    return (err: unknown): boolean => {
        assert.ok(err instanceof rpc.ResponseError, `${message}: expected a ResponseError`);
        assert.strictEqual(
            (err as rpc.ResponseError<unknown>).code,
            rpc.ErrorCodes.PendingResponseRejected,
            `${message}: expected the connection-dispose rejection`,
        );
        return true;
    };
}

function makeOutputChannel(): unknown {
    const noop = (): void => {
        /* no-op */
    };
    return {
        info: noop,
        warn: noop,
        error: noop,
        debug: noop,
        trace: noop,
        append: noop,
        appendLine: noop,
        show: noop,
        clear: noop,
        dispose: noop,
    };
}

suite('NativePythonFinder PET-exit RPC teardown', () => {
    let children: FakeChild[] = [];
    let finder: NativePythonFinderImpl | undefined;

    setup(() => {
        children = [];
        // Return a fresh fake child for each spawn (constructor start(), restart(), extra start()).
        sinon.stub(childProcessApis, 'spawnProcess').callsFake(() => {
            const child = new FakeChild();
            children.push(child);
            return child as unknown as ReturnType<typeof childProcessApis.spawnProcess>;
        });
        // The `info` fetch is orthogonal to teardown and otherwise leaves a real 2s timeout timer
        // (sendRequestWithTimeout does not clear the timer on success). Stub it out for determinism.
        sinon.stub(NativePythonFinderImpl.prototype as unknown as { kickoffInfoFetch: () => void }, 'kickoffInfoFetch');
    });

    teardown(() => {
        // Mark children exited so dispose() doesn't schedule 500ms graceful-kill timers.
        children.forEach((c) => c.markExited());
        try {
            finder?.dispose();
        } catch {
            /* ignore */
        }
        finder = undefined;
        sinon.restore();
    });

    function createFinder(): NativePythonFinderImpl {
        finder = new NativePythonFinderImpl(
            makeOutputChannel() as never,
            'fake-pet-tool',
            {} as unknown as PythonProjectApi,
            undefined,
        );
        return finder;
    }

    function getConnection(f: NativePythonFinderImpl): rpc.MessageConnection {
        return (f as unknown as { connection: rpc.MessageConnection }).connection;
    }

    function getState(f: NativePythonFinderImpl): { processExited: boolean; processExitReason: string | undefined } {
        return f as unknown as { processExited: boolean; processExitReason: string | undefined };
    }

    test('pending request rejects promptly when PET process exits', async () => {
        const f = createFinder();
        const child = children[0];
        const connection = getConnection(f);

        const pending = connection.sendRequest('resolve', { executable: 'x' });
        await flush();

        child.simulateExit(1, null);

        await assert.rejects(pending, isPendingResponseRejected('pending request should reject when PET exits'));
        assert.strictEqual(getState(f).processExited, true, 'processExited should be set on exit');
    });

    test('pending request rejects promptly when PET process errors', async () => {
        const f = createFinder();
        const child = children[0];
        const connection = getConnection(f);

        const pending = connection.sendRequest('refresh', {});
        await flush();

        child.simulateError(new Error('spawn ENOENT'));

        await assert.rejects(pending, isPendingResponseRejected('pending request should reject when PET errors'));
        assert.strictEqual(getState(f).processExited, true, 'processExited should be set on error');
    });

    test('duplicate error + exit is harmless (idempotent teardown)', async () => {
        const f = createFinder();
        const child = children[0];
        const connection = getConnection(f);

        const pending = connection.sendRequest('resolve', { executable: 'x' });
        // Attach the rejection handler synchronously (before any teardown tick) so the rejection is
        // never momentarily unhandled during the flush below.
        const rejection = assert.rejects(pending, 'request should reject exactly once');
        await flush();

        // Both events fire (order: exit then error). Must not throw or double-tear-down.
        child.simulateExit(2, null);
        child.simulateError(new Error('post-exit error'));
        await flush();

        await rejection;
        const state = getState(f);
        assert.strictEqual(state.processExited, true);
        // The first termination reason wins; the later event must not overwrite it.
        assert.strictEqual(state.processExitReason, 'process_exit:2:none');
    });

    test('stale old-child exit cannot close a replacement connection', async () => {
        const f = createFinder();
        const oldConnection = getConnection(f);
        const oldChild = children[0];

        // Simulate what restart() does at the wiring level: a fresh start() creates a new child,
        // connection and disposables, and becomes the active one — without disposing the old child.
        const newConnection = (f as unknown as { start(): rpc.MessageConnection }).start();
        (f as unknown as { connection: rpc.MessageConnection }).connection = newConnection;
        const newChild = children[1];
        assert.notStrictEqual(newConnection, oldConnection, 'sanity: replacement connection is distinct');

        // A request in flight on the NEW connection.
        const pendingNew = newConnection.sendRequest('resolve', { executable: 'x' });
        let newSettled = false;
        pendingNew.then(
            () => (newSettled = true),
            () => (newSettled = true),
        );
        await flush();

        // The stale OLD child now exits. This must only tear down the old connection.
        oldChild.simulateExit(1, null);
        await flush();
        await flush();

        assert.strictEqual(newSettled, false, 'replacement request must not be rejected by a stale child exit');
        assert.strictEqual(
            getState(f).processExited,
            false,
            'a stale child exit must not flip processExited on the live replacement',
        );
        assert.strictEqual(getConnection(f), newConnection, 'active connection must remain the replacement');

        // The replacement is still fully usable: killing ITS child rejects its request.
        newChild.simulateExit(1, null);
        await assert.rejects(pendingNew, 'replacement request should reject when its own child exits');
    });

    test('restart produces a usable connection and resets exit state', async () => {
        const f = createFinder();
        const oldConnection = getConnection(f);

        // Fake only setTimeout so the restart backoff + kill timers advance deterministically,
        // while microtasks / setImmediate (stream + RPC delivery) keep running in real time.
        const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            const restartPromise = (f as unknown as { restart(): Promise<void> }).restart();
            await clock.tickAsync(5000); // advance past backoff (1s) and any 500ms kill timers
            await restartPromise;
        } finally {
            clock.restore();
        }

        const newConnection = getConnection(f);
        assert.notStrictEqual(newConnection, oldConnection, 'restart should create a new connection');
        const state = getState(f);
        assert.strictEqual(state.processExited, false, 'processExited should be reset after restart');

        // The restarted connection is usable: a pending request stays pending until its child dies.
        const newChild = children[children.length - 1];
        const pending = newConnection.sendRequest('resolve', { executable: 'x' });
        let settled = false;
        pending.then(
            () => (settled = true),
            () => (settled = true),
        );
        await flush();
        assert.strictEqual(settled, false, 'request on restarted connection should stay pending until child exits');

        newChild.simulateExit(1, null);
        await assert.rejects(pending, 'request should reject once the restarted child exits');
    });
});
