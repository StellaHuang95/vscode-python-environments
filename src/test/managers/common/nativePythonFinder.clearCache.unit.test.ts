import assert from 'node:assert';
import * as os from 'node:os';
import * as path from 'node:path';
import fsExtra from 'fs-extra';
import * as sinon from 'sinon';
import { ExtensionContext, LogOutputChannel, Uri } from 'vscode';
import * as logging from '../../../common/logging';
import * as telemetrySender from '../../../common/telemetry/sender';
import { PythonProjectApi } from '../../../api';
import {
    ConfigurationOptions,
    clearCacheDirectory,
    NativeInfo,
    NativePythonFinderImpl,
    RefreshResult,
} from '../../../managers/common/nativePythonFinder';

/** A fake JSON-RPC connection whose `sendRequest` behavior the test controls. */
interface FakeConnection {
    sendRequest: sinon.SinonStub;
    dispose: sinon.SinonStub;
}

// A no-op logger that satisfies the subset of LogOutputChannel used by the finder.
function makeOutputChannel(): LogOutputChannel {
    const noop = sinon.stub();
    return {
        info: noop,
        warn: noop,
        error: noop,
        debug: noop,
        trace: noop,
        append: noop,
        appendLine: noop,
        replace: noop,
        clear: noop,
        show: noop,
        hide: noop,
        dispose: noop,
        name: 'test',
        logLevel: 0,
        onDidChangeLogLevel: noop,
    } as unknown as LogOutputChannel;
}

function makeApi(): PythonProjectApi {
    return { getPythonProjects: () => [] } as unknown as PythonProjectApi;
}

/**
 * Stubs `NativePythonFinderImpl.prototype.start` so construction spawns no PET process. The stub
 * installs a live-looking process and a fake connection whose `sendRequest` resolves `null`.
 */
function installStartStub(): sinon.SinonStub {
    return sinon
        .stub(NativePythonFinderImpl.prototype as unknown as { start: () => unknown }, 'start')
        .callsFake(function (this: Record<string, unknown>) {
            this.proc = { exitCode: null, kill: sinon.stub() };
            const connection: FakeConnection = { sendRequest: sinon.stub().resolves(null), dispose: sinon.stub() };
            return connection;
        });
}

function connectionOf(finder: NativePythonFinderImpl): FakeConnection {
    return (finder as unknown as { connection: FakeConnection }).connection;
}

function disposeAll(finders: NativePythonFinderImpl[]): void {
    while (finders.length > 0) {
        const finder = finders.pop();
        try {
            finder?.dispose();
        } catch {
            // ignore disposal errors in teardown
        }
    }
}

suite('NativePythonFinderImpl.clearCache', () => {
    let startStub: sinon.SinonStub;
    let emptyDirStub: sinon.SinonStub;
    let outputChannel: LogOutputChannel;
    const finders: NativePythonFinderImpl[] = [];

    /**
     * Constructs a finder with `start()` stubbed so no PET process is spawned. The stub installs a
     * live-looking process and a fake connection whose `sendRequest` resolves `null` by default.
     */
    function createFinder(cacheDirectory: Uri | undefined): NativePythonFinderImpl {
        const finder = new NativePythonFinderImpl(outputChannel, path.join('tool', 'pet'), makeApi(), cacheDirectory);
        finders.push(finder);
        return finder;
    }

    setup(() => {
        outputChannel = makeOutputChannel();
        emptyDirStub = sinon.stub(fsExtra, 'emptyDir').resolves();
        startStub = installStartStub();
    });

    teardown(() => {
        disposeAll(finders);
        sinon.restore();
    });

    test('sends the `clear` RPC and also empties the on-disk cache directory when a live server is available', async () => {
        const cacheDir = Uri.file(path.join(os.tmpdir(), 'pet-clear-live'));
        const finder = createFinder(cacheDir);
        const sendRequest = connectionOf(finder).sendRequest;

        await finder.clearCache();

        assert.strictEqual(sendRequest.callCount, 1, 'clear RPC should be sent once');
        assert.strictEqual(sendRequest.firstCall.args[0], 'clear');
        assert.deepStrictEqual(sendRequest.firstCall.args[1], {});
        // The on-disk clear is an unconditional additional layer: PET may not yet know our cache
        // directory (learned via `configure`), so we always empty it ourselves.
        assert.strictEqual(emptyDirStub.callCount, 1);
        assert.strictEqual(emptyDirStub.firstCall.args[0], cacheDir.fsPath);
    });

    test('advances the cache generation and resets lastConfiguration', async () => {
        const finder = createFinder(Uri.file(path.join(os.tmpdir(), 'pet-clear-gen')));
        const asAny = finder as unknown as { cache: { generation: number }; lastConfiguration?: unknown };
        asAny.lastConfiguration = { workspaceDirectories: [] };
        const generationBefore = asAny.cache.generation;

        await finder.clearCache();

        assert.strictEqual(asAny.cache.generation, generationBefore + 1);
        assert.strictEqual(asAny.lastConfiguration, undefined);
    });

    test('empties the on-disk cache directory when no live server is available', async () => {
        const cacheDir = Uri.file(path.join(os.tmpdir(), 'pet-clear-nolive'));
        const finder = createFinder(cacheDir);
        // Simulate a server that never started / has exited.
        (finder as unknown as { processExited: boolean }).processExited = true;
        const sendRequest = connectionOf(finder).sendRequest;

        await finder.clearCache();

        assert.strictEqual(sendRequest.called, false, 'no RPC should be sent without a live server');
        assert.strictEqual(emptyDirStub.callCount, 1);
        // Cross-platform: compare against the fsPath, not a raw POSIX string.
        assert.strictEqual(emptyDirStub.firstCall.args[0], cacheDir.fsPath);
    });

    test('resets the live server and still empties the on-disk cache directory when the live `clear` RPC fails', async () => {
        const cacheDir = Uri.file(path.join(os.tmpdir(), 'pet-clear-rpcfail'));
        const finder = createFinder(cacheDir);
        connectionOf(finder).sendRequest.rejects(new Error('rpc boom'));
        const internals = finder as unknown as {
            proc?: { kill: sinon.SinonStub };
            processExited: boolean;
            restartAttempts: number;
        };
        const killStub = internals.proc!.kill;
        internals.restartAttempts = 2; // pretend earlier crash-restarts happened

        await finder.clearCache();

        // A failed live clear leaves PET's in-memory cache intact, and emptying the on-disk directory
        // cannot evict it. So we terminate the process and mark it for restart; the next discovery
        // spawns a fresh (empty) server. All discovery/resolve paths call ensureProcessRunning() first,
        // so none can read the stale in-memory cache before that restart.
        assert.strictEqual(killStub.called, true, 'the stale PET process should be terminated');
        assert.strictEqual(internals.processExited, true, 'the server should be marked for restart');
        assert.strictEqual(internals.proc, undefined, 'killProcess clears the process handle');
        assert.strictEqual(internals.restartAttempts, 0, 'an intentional reset must not consume the restart budget');
        // The on-disk sweep is the PRIMARY disk clear here (the live clear did not succeed).
        assert.strictEqual(emptyDirStub.callCount, 1, 'disk clear should run even after RPC failure');
        assert.strictEqual(emptyDirStub.firstCall.args[0], cacheDir.fsPath);
    });

    test('propagates on-disk clear failures instead of swallowing them', async () => {
        const cacheDir = Uri.file(path.join(os.tmpdir(), 'pet-clear-diskfail'));
        const finder = createFinder(cacheDir);
        (finder as unknown as { processExited: boolean }).processExited = true;
        emptyDirStub.rejects(new Error('disk boom'));

        await assert.rejects(() => finder.clearCache(), /disk boom/);
    });

    test('propagates the on-disk clear failure even after a successful live clear (fail-closed)', async () => {
        // The live `clear` reporting success does NOT prove PET evicted OUR directory: before the
        // first `configure`, PET clears its default location, not ours. So a failed on-disk sweep may
        // leave a previous session's cache reachable and must surface rather than report false success.
        const cacheDir = Uri.file(path.join(os.tmpdir(), 'pet-clear-redundant-fail'));
        const finder = createFinder(cacheDir);
        emptyDirStub.rejects(new Error('redundant disk boom'));

        await assert.rejects(() => finder.clearCache(), /redundant disk boom/);

        assert.strictEqual(connectionOf(finder).sendRequest.callCount, 1, 'live clear should have run');
        assert.strictEqual(emptyDirStub.callCount, 1, 'on-disk sweep should have been attempted');
    });

    test('warns and does not throw when there is no live server and no cache directory', async () => {
        const finder = createFinder(undefined);
        (finder as unknown as { processExited: boolean }).processExited = true;

        await finder.clearCache();

        assert.strictEqual(emptyDirStub.called, false);
    });

    test('killProcess escalates to SIGKILL when the process ignores SIGTERM, even after this.proc is cleared', () => {
        const finder = createFinder(Uri.file(path.join(os.tmpdir(), 'pet-kill-escalate')));
        const internals = finder as unknown as {
            proc: { exitCode: number | null; kill: sinon.SinonStub };
            killProcess: () => void;
        };
        const proc = internals.proc; // capture before killProcess() nulls this.proc
        const clock = sinon.useFakeTimers();
        try {
            internals.killProcess();

            assert.ok(proc.kill.calledWith('SIGTERM'), 'SIGTERM should be sent immediately');
            assert.strictEqual(
                (finder as unknown as { proc: unknown }).proc,
                undefined,
                'this.proc should be cleared synchronously',
            );
            assert.strictEqual(proc.kill.calledWith('SIGKILL'), false, 'SIGKILL must wait for the grace period');

            // The process ignored SIGTERM (exitCode stays null); advancing past the grace period must
            // still escalate to SIGKILL on the CAPTURED process, not the already-cleared this.proc.
            clock.tick(600);
            assert.ok(
                proc.kill.calledWith('SIGKILL'),
                'SIGKILL should escalate for a process that ignores SIGTERM',
            );
        } finally {
            clock.restore();
        }
    });

    suite('start-time bookkeeping', () => {
        test('start() is invoked exactly once per finder construction', () => {
            createFinder(Uri.file(path.join(os.tmpdir(), 'pet-clear-count')));
            assert.strictEqual(startStub.callCount, 1);
        });
    });
});

suite('NativePythonFinderImpl hard-refresh coalescing vs clearCache', () => {
    let outputChannel: LogOutputChannel;
    const finders: NativePythonFinderImpl[] = [];

    function makeConfig(): ConfigurationOptions {
        return {
            workspaceDirectories: [Uri.file(path.join('work', 'a')).fsPath],
            environmentDirectories: [],
            condaExecutable: undefined,
            pipenvExecutable: undefined,
            poetryExecutable: undefined,
        };
    }

    function makeResult(): RefreshResult {
        return { results: [], configuration: makeConfig() };
    }

    function createFinder(): NativePythonFinderImpl {
        const finder = new NativePythonFinderImpl(
            outputChannel,
            path.join('tool', 'pet'),
            makeApi(),
            Uri.file(path.join(os.tmpdir(), 'pet-coalesce')),
        );
        finders.push(finder);
        return finder;
    }

    setup(() => {
        outputChannel = makeOutputChannel();
        sinon.stub(fsExtra, 'emptyDir').resolves();
        sinon.stub(telemetrySender, 'sendTelemetryEvent');
        installStartStub();
    });

    teardown(() => {
        disposeAll(finders);
        sinon.restore();
    });

    // Replaces the pool's addToQueue so the test controls when each hard scan resolves, without
    // spawning PET. Keeps the real pool object so dispose()'s pool.stop() still works.
    function stubQueue(finder: NativePythonFinderImpl): sinon.SinonStub {
        const pool = (finder as unknown as { pool: { addToQueue: unknown } }).pool;
        return sinon.stub(pool as { addToQueue: () => Promise<RefreshResult> }, 'addToQueue');
    }

    function inFlightMap(finder: NativePythonFinderImpl): Map<string, unknown> {
        return (finder as unknown as { inFlightRefreshes: Map<string, unknown> }).inFlightRefreshes;
    }

    // Stubs buildConfigurationOptions so the effective config is deterministic (coalescing now
    // depends on it). Configuration is built via an await, so callers must flush() before the
    // in-flight slot / addToQueue call is observable.
    function stubConfig(finder: NativePythonFinderImpl): sinon.SinonStub {
        return sinon.stub(
            finder as unknown as { buildConfigurationOptions: () => Promise<ConfigurationOptions> },
            'buildConfigurationOptions',
        );
    }

    // Flushes pending microtasks (and one macrotask) so an async config build + registration completes.
    const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

    test('coalesces concurrent hard refreshes for the same key within one generation', async () => {
        const finder = createFinder();
        stubConfig(finder).resolves(makeConfig());
        const addToQueue = stubQueue(finder);
        let resolve1!: (v: RefreshResult) => void;
        addToQueue.onCall(0).returns(new Promise<RefreshResult>((r) => (resolve1 = r)));

        const p1 = finder.refresh(true);
        const p2 = finder.refresh(true); // same key ('all'), same generation, same config → coalesced
        await flush();

        assert.strictEqual(addToQueue.callCount, 1, 'the second concurrent refresh should coalesce');

        resolve1(makeResult());
        await Promise.all([p1, p2]);
    });

    test('a refresh under a CHANGED configuration does NOT coalesce onto an in-flight scan built with the old config', async () => {
        const finder = createFinder();
        const configA = makeConfig();
        const configB: ConfigurationOptions = { ...makeConfig(), condaExecutable: path.join('new', 'conda') };
        const buildConfig = stubConfig(finder);
        buildConfig.onCall(0).resolves(configA);
        buildConfig.onCall(1).resolves(configB);
        const addToQueue = stubQueue(finder);
        let resolve1!: (v: RefreshResult) => void;
        let resolve2!: (v: RefreshResult) => void;
        addToQueue.onCall(0).returns(new Promise<RefreshResult>((r) => (resolve1 = r)));
        addToQueue.onCall(1).returns(new Promise<RefreshResult>((r) => (resolve2 = r)));

        const p1 = finder.refresh(true); // builds configA → in-flight scan tagged configA
        await flush();
        assert.strictEqual(addToQueue.callCount, 1);

        // A settings change does NOT advance the generation (only clearCache does). The in-flight
        // slot has the same key and generation, so ONLY the configuration comparison can stop this
        // caller from coalescing onto the stale scan that was started under configA.
        const p2 = finder.refresh(true); // builds configB
        await flush();
        assert.strictEqual(
            addToQueue.callCount,
            2,
            'a configuration change must force a fresh scan rather than reuse the old-config in-flight scan',
        );

        resolve1({ results: [], configuration: configA });
        resolve2({ results: [], configuration: configB });
        await Promise.all([p1, p2]);
    });

    test('refresh(false) returns a same-config soft hit and queues a fresh scan when the config changed', async () => {
        const finder = createFinder();
        const configA = makeConfig();
        const configB: ConfigurationOptions = { ...makeConfig(), poetryExecutable: path.join('new', 'poetry') };
        const buildConfig = stubConfig(finder);
        const addToQueue = stubQueue(finder);

        // Seed the soft cache for the 'all' key, tagged with configA at the current generation.
        const cache = (
            finder as unknown as {
                cache: {
                    set: (k: string, c: ConfigurationOptions, r: NativeInfo[], g: number) => boolean;
                    generation: number;
                };
            }
        ).cache;
        const cachedResults = [{ executable: path.join('env', 'python') } as unknown as NativeInfo];
        cache.set('all', configA, cachedResults, cache.generation);

        // Same config → soft HIT: the cached results are returned and NO scan is queued. This exercises
        // the real handleSoftRefresh → getValid wiring, not just the DiscoveryResultCache unit.
        buildConfig.onCall(0).resolves(configA);
        const hit = await finder.refresh(false);
        assert.strictEqual(hit, cachedResults, 'a same-config soft refresh must return the exact cached results array');
        assert.strictEqual(addToQueue.callCount, 0, 'a soft hit must not queue a scan');

        // Changed config → soft MISS: handleSoftRefresh must thread the rebuilt config into a fresh
        // hard scan rather than serve the now-stale cached entry.
        buildConfig.onCall(1).resolves(configB);
        let resolveScan!: (v: RefreshResult) => void;
        addToQueue.onCall(0).returns(new Promise<RefreshResult>((r) => (resolveScan = r)));
        const missPromise = finder.refresh(false);
        await flush();
        assert.strictEqual(addToQueue.callCount, 1, 'a changed-config soft refresh must queue a fresh scan');

        resolveScan({ results: [], configuration: configB });
        await missPromise;
    });

    test('a clearCache() that lands DURING a hard refresh config build does not repopulate the cleared cache', async () => {
        const finder = createFinder();
        // Route clearCache() to the disk path (no live server) so it only advances the generation and
        // sweeps the (stubbed) directory — no RPC, no process interaction.
        (finder as unknown as { processExited: boolean }).processExited = true;

        const config = makeConfig();
        // Suspend the hard refresh mid config-build so a clear can land while it is still awaiting.
        let resolveConfig!: (c: ConfigurationOptions) => void;
        stubConfig(finder).returns(new Promise<ConfigurationOptions>((r) => (resolveConfig = r)));
        const addToQueue = stubQueue(finder);
        let resolveScan!: (v: RefreshResult) => void;
        addToQueue.onCall(0).returns(new Promise<RefreshResult>((r) => (resolveScan = r)));

        const cache = (
            finder as unknown as {
                cache: { getValid: (k: string, c: ConfigurationOptions) => NativeInfo[] | undefined };
            }
        ).cache;

        // handleHardRefresh samples generationAtStart SYNCHRONOUSLY, then suspends on the config build.
        const p = finder.refresh(true);
        await flush();
        assert.strictEqual(addToQueue.callCount, 0, 'the scan must not be queued until the config build resolves');

        // The clear lands while the refresh is still building its config → the generation advances.
        await finder.clearCache();

        // Let the straddling refresh finish: its config resolves, the scan is queued and returns data.
        resolveConfig(config);
        await flush();
        assert.strictEqual(addToQueue.callCount, 1, 'the straddling refresh still runs its own scan');
        resolveScan({
            results: [{ executable: path.join('env', 'python') } as unknown as NativeInfo],
            configuration: config,
        });
        await p;

        // Because generationAtStart was captured BEFORE the config-build await, the store is rejected by
        // the generation guard and the just-cleared cache stays empty. A post-await capture would have
        // observed the post-clear generation and wrongly repopulated the cache.
        assert.strictEqual(
            cache.getValid('all', config),
            undefined,
            'a refresh that began before the clear must not repopulate the freshly-cleared cache',
        );
    });

    test('a clearCache() during a SOFT refresh config build does not repopulate via the miss-triggered scan', async () => {
        const finder = createFinder();
        (finder as unknown as { processExited: boolean }).processExited = true;

        const config = makeConfig();
        // Suspend the soft refresh mid config-build (before its getValid + miss-triggered hard scan).
        let resolveConfig!: (c: ConfigurationOptions) => void;
        stubConfig(finder).returns(new Promise<ConfigurationOptions>((r) => (resolveConfig = r)));
        const addToQueue = stubQueue(finder);
        let resolveScan!: (v: RefreshResult) => void;
        addToQueue.onCall(0).returns(new Promise<RefreshResult>((r) => (resolveScan = r)));

        const cache = (
            finder as unknown as {
                cache: { getValid: (k: string, c: ConfigurationOptions) => NativeInfo[] | undefined };
            }
        ).cache;

        // handleSoftRefresh samples the generation SYNCHRONOUSLY, then suspends on the config build.
        const p = finder.refresh(false);
        await flush();
        assert.strictEqual(addToQueue.callCount, 0, 'no scan until the soft config build resolves');

        await finder.clearCache(); // advances the generation mid soft-build

        // Build resolves → getValid misses → hard scan is queued with the soft-sampled generation.
        resolveConfig(config);
        await flush();
        assert.strictEqual(addToQueue.callCount, 1, 'the soft miss still queues a scan');
        resolveScan({
            results: [{ executable: path.join('env', 'python') } as unknown as NativeInfo],
            configuration: config,
        });
        await p;

        // The soft path threads its start generation into the hard refresh, so the store is rejected —
        // matching the direct hard path (uniform "began before clear cannot repopulate" guarantee).
        assert.strictEqual(
            cache.getValid('all', config),
            undefined,
            'a soft refresh that began before the clear must not repopulate the cache on miss',
        );
    });

    test('a post-clear refresh does NOT coalesce onto a pre-clear in-flight scan', async () => {
        const finder = createFinder();
        stubConfig(finder).resolves(makeConfig());
        const addToQueue = stubQueue(finder);
        let resolve1!: (v: RefreshResult) => void;
        let resolve2!: (v: RefreshResult) => void;
        addToQueue.onCall(0).returns(new Promise<RefreshResult>((r) => (resolve1 = r)));
        addToQueue.onCall(1).returns(new Promise<RefreshResult>((r) => (resolve2 = r)));

        const p1 = finder.refresh(true); // generation 0, in flight
        await flush(); // let it register as a gen-0 scan BEFORE the clear bumps the generation
        assert.strictEqual(addToQueue.callCount, 1);

        await finder.clearCache(); // advances the generation

        const p2 = finder.refresh(true); // generation 1 ≠ in-flight generation 0 → fresh scan
        await flush();
        assert.strictEqual(
            addToQueue.callCount,
            2,
            'a caller arriving after a clear must trigger a fresh scan, not reuse the stale one',
        );

        // The pre-clear scan resolving late must not repopulate the freshly cleared cache: its
        // captured generation (0) no longer matches, so the tagging set() is a no-op.
        resolve1(makeResult());
        await p1;
        const cache = (
            finder as unknown as { cache: { getValid: (k: string, c: ConfigurationOptions) => unknown } }
        ).cache;
        assert.strictEqual(
            cache.getValid('all', makeConfig()),
            undefined,
            'the stale pre-clear scan must not repopulate the cleared cache',
        );

        resolve2(makeResult());
        await p2;
    });

    test('a settling pre-clear scan does not evict a newer request registered under the same key', async () => {
        const finder = createFinder();
        stubConfig(finder).resolves(makeConfig());
        const addToQueue = stubQueue(finder);
        let resolve1!: (v: RefreshResult) => void;
        let resolve2!: (v: RefreshResult) => void;
        addToQueue.onCall(0).returns(new Promise<RefreshResult>((r) => (resolve1 = r)));
        addToQueue.onCall(1).returns(new Promise<RefreshResult>((r) => (resolve2 = r)));

        const p1 = finder.refresh(true); // entry1 (generation 0)
        await flush(); // ensure entry1 is registered before the clear
        await finder.clearCache(); // generation → 1
        const p2 = finder.refresh(true); // entry2 (generation 1), overwrites the map slot
        await flush();
        const entry2 = inFlightMap(finder).get('all');
        assert.ok(entry2, 'the new refresh should be registered');

        // The old pre-clear scan settles AFTER the new one registered. Its identity-safe cleanup must
        // leave the newer slot intact.
        resolve1(makeResult());
        await p1;
        assert.strictEqual(inFlightMap(finder).get('all'), entry2, 'the newer in-flight slot must survive');

        // A third caller should coalesce onto the still-registered new scan, not spawn a third one.
        const p3 = finder.refresh(true);
        await flush();
        assert.strictEqual(addToQueue.callCount, 2, 'the third caller should coalesce onto the newer scan');

        resolve2(makeResult());
        await Promise.all([p2, p3]);
    });

    test('a settling pre-clear scan that REJECTS still does not evict a newer request', async () => {
        const finder = createFinder();
        stubConfig(finder).resolves(makeConfig());
        const addToQueue = stubQueue(finder);
        let reject1!: (e: unknown) => void;
        let resolve2!: (v: RefreshResult) => void;
        addToQueue.onCall(0).returns(new Promise<RefreshResult>((_resolve, reject) => (reject1 = reject)));
        addToQueue.onCall(1).returns(new Promise<RefreshResult>((r) => (resolve2 = r)));

        const p1 = finder.refresh(true); // entry1 (generation 0)
        p1.catch(() => undefined); // the pre-clear scan is expected to reject
        await flush(); // ensure entry1 is registered before the clear
        await finder.clearCache(); // generation → 1
        const p2 = finder.refresh(true); // entry2 (generation 1), overwrites the map slot
        await flush();
        const entry2 = inFlightMap(finder).get('all');
        assert.ok(entry2, 'the new refresh should be registered');

        // The old pre-clear scan REJECTS after the new one registered. Identity-safe cleanup runs in
        // `.finally` on the rejection path too, so it must still leave the newer slot intact.
        reject1(new Error('pre-clear scan failed'));
        await p1.catch(() => undefined);
        assert.strictEqual(
            inFlightMap(finder).get('all'),
            entry2,
            'a rejected pre-clear scan must not evict the newer in-flight slot',
        );

        resolve2(makeResult());
        await p2;
    });
});

suite('NativePythonFinderImpl.configure clear-race guard', () => {
    let outputChannel: LogOutputChannel;
    const finders: NativePythonFinderImpl[] = [];

    function makeConfig(): ConfigurationOptions {
        return {
            workspaceDirectories: [Uri.file('/work/a').fsPath],
            environmentDirectories: [],
            condaExecutable: undefined,
            pipenvExecutable: undefined,
            poetryExecutable: undefined,
        };
    }

    function createFinder(): NativePythonFinderImpl {
        const finder = new NativePythonFinderImpl(
            outputChannel,
            path.join('tool', 'pet'),
            makeApi(),
            Uri.file(path.join(os.tmpdir(), 'pet-configure-race')),
        );
        finders.push(finder);
        return finder;
    }

    setup(() => {
        outputChannel = makeOutputChannel();
        sinon.stub(fsExtra, 'emptyDir').resolves();
        sinon.stub(telemetrySender, 'sendTelemetryEvent');
        installStartStub();
    });

    teardown(() => {
        disposeAll(finders);
        sinon.restore();
    });

    // Type escape hatch to reach the private members the race exercises.
    type Internals = {
        connection: FakeConnection;
        configure: (options?: ConfigurationOptions) => Promise<void>;
        lastConfiguration?: ConfigurationOptions;
    };

    test('does not resurrect lastConfiguration when clearCache() lands mid-configure', async () => {
        const finder = createFinder();
        const internals = finder as unknown as Internals & { clearCache: () => Promise<void> };
        const sendRequest = connectionOf(finder).sendRequest;

        // Make the `configure` RPC hang until we resolve it; let `clear` resolve immediately.
        let resolveConfigure!: (value: unknown) => void;
        sendRequest.withArgs('configure').returns(new Promise((resolve) => (resolveConfigure = resolve)));
        sendRequest.withArgs('clear').resolves(null);

        const config = makeConfig();
        const configurePromise = internals.configure(config); // in flight, suspended at its await
        await Promise.resolve();

        // An explicit clear happens while configure is in flight: it advances the generation and
        // resets lastConfiguration.
        await finder.clearCache();

        // The in-flight configure now completes and must NOT write its (pre-clear) config back.
        resolveConfigure(null);
        await configurePromise;

        assert.strictEqual(
            internals.lastConfiguration,
            undefined,
            'a configure that raced a clear must not resurrect lastConfiguration',
        );
    });

    test('caches lastConfiguration normally when no clear intervenes', async () => {
        const finder = createFinder();
        const internals = finder as unknown as Internals;

        const config = makeConfig();
        await internals.configure(config);

        assert.deepStrictEqual(internals.lastConfiguration, config);
    });
});

suite('clearCacheDirectory (disk fallback before finder exists)', () => {
    let emptyDirStub: sinon.SinonStub;
    let traceVerboseStub: sinon.SinonStub;
    let traceErrorStub: sinon.SinonStub;

    setup(() => {
        emptyDirStub = sinon.stub(fsExtra, 'emptyDir').resolves();
        traceVerboseStub = sinon.stub(logging, 'traceVerbose');
        traceErrorStub = sinon.stub(logging, 'traceError');
    });

    teardown(() => sinon.restore());

    function makeContext(globalStorage: Uri): ExtensionContext {
        return { globalStorageUri: globalStorage } as unknown as ExtensionContext;
    }

    test('empties the pythonLocator directory under global storage', async () => {
        const globalStorage = Uri.file(path.join(os.tmpdir(), 'global-storage'));
        await clearCacheDirectory(makeContext(globalStorage));

        assert.strictEqual(emptyDirStub.callCount, 1);
        assert.strictEqual(emptyDirStub.firstCall.args[0], Uri.joinPath(globalStorage, 'pythonLocator').fsPath);
        assert.strictEqual(traceVerboseStub.called, true);
    });

    test('logs and propagates filesystem failures', async () => {
        const globalStorage = Uri.file(path.join(os.tmpdir(), 'global-storage-fail'));
        emptyDirStub.rejects(new Error('emptyDir failed'));

        await assert.rejects(() => clearCacheDirectory(makeContext(globalStorage)), /emptyDir failed/);
        assert.strictEqual(traceErrorStub.called, true);
    });
});
