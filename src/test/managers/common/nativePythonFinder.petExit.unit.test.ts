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
 * Minimal server side of the PET JSON-RPC protocol, wired to a {@link FakeChild}'s stdio so a
 * refresh can actually round-trip against the REAL vscode-jsonrpc connection the finder drives.
 * The finder writes requests to `stdin` (server reads them) and reads responses from `stdout`
 * (server writes them). Used by the end-to-end crash/retry tests; the connection-level teardown
 * tests below drive raw requests and need no server.
 */
class FakePetServer {
    public readonly connection: rpc.MessageConnection;
    /** When 'hang', the server accepts a `refresh` request but never answers it (simulates a child
     * that is about to crash mid-request). When 'answer', it emits one `manager` env then responds. */
    public refreshMode: 'answer' | 'hang' = 'answer';

    constructor(child: FakeChild) {
        this.connection = rpc.createMessageConnection(
            new rpc.StreamMessageReader(child.stdin),
            new rpc.StreamMessageWriter(child.stdout),
        );
        this.connection.onRequest('configure', () => null);
        this.connection.onRequest('resolve', (p: { executable: string }) => ({
            executable: p.executable,
            version: '3.11.0',
            prefix: '/env',
        }));
        this.connection.onRequest('refresh', () => {
            if (this.refreshMode === 'hang') {
                // Never settles; the finder's side is released when its connection is disposed on
                // the child's crash. Left pending on the server until the server is disposed.
                return new Promise<{ duration: number }>(() => {
                    /* intentionally never resolves */
                });
            }
            this.connection.sendNotification('manager', { tool: 'venv', executable: '/usr/bin/python3' });
            return { duration: 0 };
        });
        this.connection.listen();
    }

    public dispose(): void {
        try {
            this.connection.dispose();
        } catch {
            /* ignore */
        }
    }
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
    let servers: FakePetServer[] = [];
    // When true, every spawned fake child gets a FakePetServer attached so refresh requests can
    // round-trip. Off by default so the raw-request teardown tests below aren't answered early.
    let attachServers = false;
    let finder: NativePythonFinderImpl | undefined;

    setup(() => {
        children = [];
        servers = [];
        attachServers = false;
        // Return a fresh fake child for each spawn (constructor start(), restart(), extra start()).
        sinon.stub(childProcessApis, 'spawnProcess').callsFake(() => {
            const child = new FakeChild();
            children.push(child);
            if (attachServers) {
                servers.push(new FakePetServer(child));
            }
            return child as unknown as ReturnType<typeof childProcessApis.spawnProcess>;
        });
        // The `info` fetch is orthogonal to teardown and otherwise leaves a real 2s timeout timer
        // (sendRequestWithTimeout does not clear the timer on success). Stub it out for determinism.
        sinon.stub(NativePythonFinderImpl.prototype as unknown as { kickoffInfoFetch: () => void }, 'kickoffInfoFetch');
    });

    teardown(() => {
        // Mark children exited so dispose() doesn't schedule 500ms graceful-kill timers.
        children.forEach((c) => c.markExited());
        servers.forEach((s) => s.dispose());
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

    // --- Issue 1: recovery/telemetry must treat the dispose-driven PendingResponseRejected
    // rejection as a recoverable connection loss (not a non-retryable rpc_error), while still
    // ignoring intentional disposal. ---

    /** Stubs the settings/api-touching refresh helpers so ONLY the `refresh` request hits the wire. */
    function stubRefreshWireDeps(f: NativePythonFinderImpl): void {
        const anyF = f as unknown as {
            buildConfigurationOptions: () => Promise<unknown>;
            configure: () => Promise<void>;
            getRefreshOptions: () => unknown;
        };
        sinon
            .stub(anyF, 'buildConfigurationOptions')
            .resolves({ workspaceDirectories: [], environmentDirectories: [] });
        sinon.stub(anyF, 'configure').resolves();
        sinon.stub(anyF, 'getRefreshOptions').returns({});
    }

    test('a current-child crash during refresh promptly restarts and the retry succeeds', async () => {
        attachServers = true;
        const f = createFinder();
        stubRefreshWireDeps(f);
        const oldConnection = getConnection(f);
        // The first child accepts the refresh but never answers it — we crash it mid-request.
        servers[0].refreshMode = 'hang';

        // Fake only setTimeout so the restart backoff advances deterministically while stream + RPC
        // delivery (microtasks / setImmediate) keep running in real time.
        const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            const refreshPromise = (f as unknown as { doRefresh(o?: unknown): Promise<unknown> }).doRefresh(undefined);
            let settled = false;
            let result: unknown;
            let error: unknown;
            refreshPromise.then(
                (r) => {
                    settled = true;
                    result = r;
                },
                (e) => {
                    settled = true;
                    error = e;
                },
            );

            // Let attempt 0 send `refresh` to the (hanging) first child, then crash that child.
            await flush();
            children[0].simulateExit(1, null);

            // Drive reject → retry → restart(backoff) → retried refresh. Alternate real async drains
            // with fake-timer advances until the retried refresh settles (well under the 30s refresh
            // timeout, so that fake timer never fires).
            for (let i = 0; i < 15 && !settled; i++) {
                await flush();
                await clock.tickAsync(1000);
            }

            assert.ok(settled, 'refresh should settle after the retry');
            assert.strictEqual(error, undefined, `refresh should not reject: ${error}`);
            assert.ok(Array.isArray(result), 'refresh should resolve with an environment array');
            assert.strictEqual((result as unknown[]).length, 1, 'retry should return the healthy child manager info');
            assert.strictEqual(getState(f).processExited, false, 'finder should be healthy after the restart');
            assert.notStrictEqual(getConnection(f), oldConnection, 'connection should be the post-restart replacement');
            assert.strictEqual(children.length, 2, 'exactly one restart should have spawned one replacement child');
            assert.strictEqual(
                (f as unknown as { restartAttempts: number }).restartAttempts,
                0,
                'a successful retry should reset restartAttempts',
            );
        } finally {
            clock.restore();
        }
    });

    test('a connection loss during disposal is NOT treated as a recoverable crash', async () => {
        // Fake setTimeout so the resolve request-timeout timer is a discarded fake, not a real 30s
        // leak (the mock CancellationToken does not clear it on rejection).
        const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            const f = createFinder();
            // configure() touches settings/api we don't mock here; stub it so resolve() goes straight
            // to the (unanswered, hence pending) `resolve` request.
            sinon.stub(f as unknown as { configure: () => Promise<void> }, 'configure').resolves();

            const pending = f.resolve('x');
            // Attach synchronously so it is never unhandled; validate the specific dispose-driven
            // PendingResponseRejected shape for parity with the other teardown tests.
            const rejection = assert.rejects(
                pending,
                isPendingResponseRejected('dispose must reject the in-flight resolve with PendingResponseRejected'),
            );
            await flush();
            assert.strictEqual(children.length, 1, 'sanity: exactly one child spawned');

            // Mark exited only to avoid the graceful-kill path; disposal (not a child exit) is what
            // rejects the in-flight resolve with PendingResponseRejected.
            children[0].markExited();
            f.dispose();
            await rejection;

            assert.strictEqual(children.length, 1, 'dispose must not spawn a replacement child');
            assert.strictEqual(
                (f as unknown as { restartAttempts: number }).restartAttempts,
                0,
                'dispose must not trigger a restart',
            );
            assert.strictEqual(
                (
                    f as unknown as { isRecoverableConnectionLoss(ex: unknown): boolean }
                ).isRecoverableConnectionLoss(new rpc.ResponseError(rpc.ErrorCodes.PendingResponseRejected, 'disposed')),
                false,
                'a PendingResponseRejected after dispose must be classified non-recoverable',
            );
        } finally {
            clock.restore();
        }
    });

    test('refresh retry limit is preserved for connection-loss errors', async () => {
        const f = createFinder();
        // killProcess() would schedule a real 500ms kill timer against the live child; stub it (the
        // explicit processExited flag in doRefresh's retry path is set independently).
        sinon.stub(f as unknown as { killProcess: () => void }, 'killProcess');
        // Every attempt fails with the dispose-driven connection-loss rejection.
        const attemptStub = sinon
            .stub(f as unknown as { doRefreshAttempt: () => Promise<unknown> }, 'doRefreshAttempt')
            .rejects(new rpc.ResponseError(rpc.ErrorCodes.PendingResponseRejected, 'crash'));

        await assert.rejects(
            (f as unknown as { doRefresh(o?: unknown): Promise<unknown> }).doRefresh(undefined),
            isPendingResponseRejected('a persistent connection loss should propagate after the retry limit'),
        );
        // MAX_REFRESH_RETRIES = 1 → exactly 2 attempts (initial + one retry), same as for a timeout.
        assert.strictEqual(attemptStub.callCount, 2, 'connection-loss errors must retry exactly to the refresh limit');
    });

    // --- Issue 2: `exit` can fire before stdout drains; ending `readable` while the child's stdout
    // is still piped would raise ERR_STREAM_WRITE_AFTER_END on late data. ---

    test('buffered stdout after exit does not raise a late write error or affect a replacement', async () => {
        const f = createFinder();
        const child = children[0];
        const connection = getConnection(f);

        // Sanity: the child's stdout is piped into the finder's internal readable (one `data`
        // listener installed by stream.pipe()).
        assert.strictEqual(child.stdout.listenerCount('data'), 1, 'stdout should be piped before exit');

        const pending = connection.sendRequest('resolve', { executable: 'x' });
        const rejection = assert.rejects(pending, isPendingResponseRejected('request should reject on exit'));
        await flush();

        // `exit` fires while stdout may still hold buffered data.
        child.simulateExit(1, null);
        await flush();

        // The fix unpipes stdout from the (now ended) readable, so there is no destination for late
        // bytes to be written to — no ERR_STREAM_WRITE_AFTER_END.
        assert.strictEqual(child.stdout.listenerCount('data'), 0, 'stdout must be unpiped from the ended readable');

        // Emit late/buffered stdout AFTER exit + teardown; with the pipe severed this is harmless.
        child.stdout.write(Buffer.from('{"jsonrpc":"2.0","method":"log"}\r\n'));
        child.stdout.write(Buffer.from('more late bytes'));
        await flush();
        await rejection;

        // A replacement connection is unaffected by the dead child's late output.
        const newConnection = (f as unknown as { start(): rpc.MessageConnection }).start();
        (f as unknown as { connection: rpc.MessageConnection }).connection = newConnection;
        const newChild = children[children.length - 1];
        const pendingNew = newConnection.sendRequest('resolve', { executable: 'y' });
        let newSettled = false;
        pendingNew.then(
            () => (newSettled = true),
            () => (newSettled = true),
        );
        child.stdout.write(Buffer.from('still more bytes from the dead child'));
        await flush();
        assert.strictEqual(newSettled, false, 'replacement request must be unaffected by the old child output');

        newChild.simulateExit(1, null);
        await assert.rejects(pendingNew, 'replacement request should reject when its own child exits');
    });
});
