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

    public simulateExit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
        this.markExited(code);
        this.emit('exit', code, signal);
    }

    public simulateError(err: Error): void {
        this.markExited();
        this.emit('error', err);
    }

    public markExited(code: number | null = 0): void {
        if (this.exitCode === null) {
            this.exitCode = code ?? 0;
        }
    }
}

function flush(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

class FakePetServer {
    public readonly connection: rpc.MessageConnection;
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
                return new Promise<{ duration: number }>(() => {
                    /* never resolves */
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
    let attachServers = false;
    let finder: NativePythonFinderImpl | undefined;

    setup(() => {
        children = [];
        servers = [];
        attachServers = false;
        sinon.stub(childProcessApis, 'spawnProcess').callsFake(() => {
            const child = new FakeChild();
            children.push(child);
            if (attachServers) {
                servers.push(new FakePetServer(child));
            }
            return child as unknown as ReturnType<typeof childProcessApis.spawnProcess>;
        });
        sinon.stub(NativePythonFinderImpl.prototype as unknown as { kickoffInfoFetch: () => void }, 'kickoffInfoFetch');
    });

    teardown(() => {
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
        const rejection = assert.rejects(pending, 'request should reject exactly once');
        await flush();

        child.simulateExit(2, null);
        child.simulateError(new Error('post-exit error'));
        await flush();

        await rejection;
        const state = getState(f);
        assert.strictEqual(state.processExited, true);
        assert.strictEqual(state.processExitReason, 'process_exit:2:none');
    });

    test('stale old-child exit cannot close a replacement connection', async () => {
        const f = createFinder();
        const oldConnection = getConnection(f);
        const oldChild = children[0];

        const newConnection = (f as unknown as { start(): rpc.MessageConnection }).start();
        (f as unknown as { connection: rpc.MessageConnection }).connection = newConnection;
        const newChild = children[1];
        assert.notStrictEqual(newConnection, oldConnection, 'sanity: replacement connection is distinct');

        const pendingNew = newConnection.sendRequest('resolve', { executable: 'x' });
        let newSettled = false;
        pendingNew.then(
            () => (newSettled = true),
            () => (newSettled = true),
        );
        await flush();

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

        newChild.simulateExit(1, null);
        await assert.rejects(pendingNew, 'replacement request should reject when its own child exits');
    });

    test('restart produces a usable connection and resets exit state', async () => {
        const f = createFinder();
        const oldConnection = getConnection(f);

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
        servers[0].refreshMode = 'hang';

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

            await flush();
            children[0].simulateExit(1, null);

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
        const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            const f = createFinder();
            sinon.stub(f as unknown as { configure: () => Promise<void> }, 'configure').resolves();

            const pending = f.resolve('x');
            const rejection = assert.rejects(
                pending,
                isPendingResponseRejected('dispose must reject the in-flight resolve with PendingResponseRejected'),
            );
            await flush();
            assert.strictEqual(children.length, 1, 'sanity: exactly one child spawned');

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
        sinon.stub(f as unknown as { killProcess: () => void }, 'killProcess');
        const attemptStub = sinon
            .stub(f as unknown as { doRefreshAttempt: () => Promise<unknown> }, 'doRefreshAttempt')
            .rejects(new rpc.ResponseError(rpc.ErrorCodes.PendingResponseRejected, 'crash'));

        await assert.rejects(
            (f as unknown as { doRefresh(o?: unknown): Promise<unknown> }).doRefresh(undefined),
            isPendingResponseRejected('a persistent connection loss should propagate after the retry limit'),
        );
        assert.strictEqual(attemptStub.callCount, 2, 'connection-loss errors must retry exactly to the refresh limit');
    });

    test('buffered stdout after exit does not raise a late write error or affect a replacement', async () => {
        const f = createFinder();
        const child = children[0];
        const connection = getConnection(f);

        assert.strictEqual(child.stdout.listenerCount('data'), 1, 'stdout should be piped before exit');

        const pending = connection.sendRequest('resolve', { executable: 'x' });
        const rejection = assert.rejects(pending, isPendingResponseRejected('request should reject on exit'));
        await flush();

        child.simulateExit(1, null);
        await flush();

        assert.strictEqual(child.stdout.listenerCount('data'), 0, 'stdout must be unpiped from the ended readable');

        child.stdout.write(Buffer.from('{"jsonrpc":"2.0","method":"log"}\r\n'));
        child.stdout.write(Buffer.from('more late bytes'));
        await flush();
        await rejection;

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
