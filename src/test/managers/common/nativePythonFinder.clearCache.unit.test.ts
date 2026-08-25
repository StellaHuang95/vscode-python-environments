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
    NativePythonFinderImpl,
    NativeInfo,
    RefreshResult,
} from '../../../managers/common/nativePythonFinder';

interface FakeConnection {
    sendRequest: sinon.SinonStub;
    dispose: sinon.SinonStub;
}

suite('NativePythonFinderImpl.clearCache', () => {
    let startStub: sinon.SinonStub;
    let emptyDirStub: sinon.SinonStub;
    let outputChannel: LogOutputChannel;
    const finders: NativePythonFinderImpl[] = [];

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
        (finder as unknown as { processExited: boolean }).processExited = true;
        const sendRequest = connectionOf(finder).sendRequest;

        await finder.clearCache();

        assert.strictEqual(sendRequest.called, false, 'no RPC should be sent without a live server');
        assert.strictEqual(emptyDirStub.callCount, 1);
        assert.strictEqual(emptyDirStub.firstCall.args[0], cacheDir.fsPath);
    });

    test('still empties the on-disk cache directory when the live `clear` RPC fails', async () => {
        const cacheDir = Uri.file(path.join(os.tmpdir(), 'pet-clear-rpcfail'));
        const finder = createFinder(cacheDir);
        connectionOf(finder).sendRequest.rejects(new Error('rpc boom'));

        await finder.clearCache();

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

    test('does not fail the command when the redundant on-disk clear fails after a successful live clear', async () => {
        const cacheDir = Uri.file(path.join(os.tmpdir(), 'pet-clear-redundant-fail'));
        const finder = createFinder(cacheDir);
        emptyDirStub.rejects(new Error('redundant disk boom'));

        await finder.clearCache();

        assert.strictEqual(connectionOf(finder).sendRequest.callCount, 1, 'live clear should have run');
        assert.strictEqual(emptyDirStub.callCount, 1, 'redundant disk sweep should have been attempted');
    });

    test('warns and does not throw when there is no live server and no cache directory', async () => {
        const finder = createFinder(undefined);
        (finder as unknown as { processExited: boolean }).processExited = true;

        await finder.clearCache();

        assert.strictEqual(emptyDirStub.called, false);
    });

    suite('start-time bookkeeping', () => {
        test('start() is invoked exactly once per finder construction', () => {
            createFinder(Uri.file(path.join(os.tmpdir(), 'pet-clear-count')));
            assert.strictEqual(startStub.callCount, 1);
        });
    });

    function createFinder(cacheDirectory: Uri | undefined): NativePythonFinderImpl {
        const finder = new NativePythonFinderImpl(outputChannel, path.join('tool', 'pet'), makeApi(), cacheDirectory);
        finders.push(finder);
        return finder;
    }
});

suite('NativePythonFinderImpl.configure clear-race guard', () => {
    let outputChannel: LogOutputChannel;
    const finders: NativePythonFinderImpl[] = [];

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

    type Internals = {
        connection: FakeConnection;
        configure: (options?: ConfigurationOptions) => Promise<void>;
        lastConfiguration?: ConfigurationOptions;
    };

    test('does not resurrect lastConfiguration when clearCache() lands mid-configure', async () => {
        const finder = createFinder();
        const internals = finder as unknown as Internals & { clearCache: () => Promise<void> };
        const sendRequest = connectionOf(finder).sendRequest;

        let resolveConfigure!: (value: unknown) => void;
        sendRequest.withArgs('configure').returns(new Promise((resolve) => (resolveConfigure = resolve)));
        sendRequest.withArgs('clear').resolves(null);

        const config = makeConfig();
        const configurePromise = internals.configure(config);
        await Promise.resolve();

        await finder.clearCache();

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
});

suite('NativePythonFinderImpl in-flight refresh coalescing', () => {
    let outputChannel: LogOutputChannel;
    const finders: NativePythonFinderImpl[] = [];

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

    test('a hard refresh in flight when clearCache() runs is not reused by a later refresh', async () => {
        const finder = createFinder();
        stubBuildConfiguration(finder).resolves(makeConfiguration());
        const addToQueue = stubAddToQueue(finder);
        const first = createDeferred<RefreshResult>();
        const second = createDeferred<RefreshResult>();
        addToQueue.onCall(0).returns(first.promise);
        addToQueue.onCall(1).returns(second.promise);

        const firstRefresh = finder.refresh(true);
        await flushMicrotasks();
        assert.strictEqual(addToQueue.callCount, 1);

        await finder.clearCache();

        const secondRefresh = finder.refresh(true);
        await flushMicrotasks();
        assert.strictEqual(addToQueue.callCount, 2, 'a refresh after clear must not coalesce onto pre-clear work');

        first.resolve({ results: makeNativeResult('stale'), configuration: makeConfiguration() });
        second.resolve({ results: makeNativeResult('fresh'), configuration: makeConfiguration() });
        const secondResults = await secondRefresh;
        await firstRefresh;

        assert.strictEqual(secondResults.length, 1);
        assert.strictEqual((secondResults[0] as { executable: string }).executable, '/py/fresh');
    });

    test('a hard refresh in flight when the configuration changes is not reused by a later refresh', async () => {
        const finder = createFinder();
        const buildConfiguration = stubBuildConfiguration(finder);
        const configA = makeConfiguration();
        const configB = makeConfiguration({ condaExecutable: Uri.file('/tools/conda-b').fsPath });
        buildConfiguration.onCall(0).resolves(configA);
        buildConfiguration.onCall(1).resolves(configB);
        const addToQueue = stubAddToQueue(finder);
        const first = createDeferred<RefreshResult>();
        const second = createDeferred<RefreshResult>();
        addToQueue.onCall(0).returns(first.promise);
        addToQueue.onCall(1).returns(second.promise);

        const firstRefresh = finder.refresh(false);
        await flushMicrotasks();
        assert.strictEqual(addToQueue.callCount, 1);

        const secondRefresh = finder.refresh(false);
        await flushMicrotasks();
        assert.strictEqual(addToQueue.callCount, 2, 'a refresh under a changed configuration must not coalesce');

        first.resolve({ results: makeNativeResult('a'), configuration: configA });
        second.resolve({ results: makeNativeResult('b'), configuration: configB });
        await Promise.all([firstRefresh, secondRefresh]);
    });

    test('a second refresh for the same key and configuration coalesces onto the in-flight request', async () => {
        const finder = createFinder();
        stubBuildConfiguration(finder).resolves(makeConfiguration());
        const addToQueue = stubAddToQueue(finder);
        const first = createDeferred<RefreshResult>();
        addToQueue.onCall(0).returns(first.promise);

        const firstRefresh = finder.refresh(true);
        await flushMicrotasks();
        const secondRefresh = finder.refresh(true);
        await flushMicrotasks();

        assert.strictEqual(addToQueue.callCount, 1);

        first.resolve({ results: makeNativeResult('shared'), configuration: makeConfiguration() });
        const [firstResults, secondResults] = await Promise.all([firstRefresh, secondRefresh]);
        assert.strictEqual(firstResults, secondResults);
    });

    test('queued refreshes execute under the configuration captured when requested (A→B→A)', async () => {
        const finder = createFinder();
        const configA = makeConfiguration();
        const configB = makeConfiguration({ condaExecutable: Uri.file('/tools/conda-b').fsPath });
        const buildConfiguration = stubBuildConfiguration(finder);
        buildConfiguration.onCall(0).resolves(configA);
        buildConfiguration.onCall(1).resolves(configB);
        buildConfiguration.onCall(2).resolves(configA);

        const gates = [createDeferred<NativeInfo[]>(), createDeferred<NativeInfo[]>(), createDeferred<NativeInfo[]>()];
        const executedConfigurations: ConfigurationOptions[] = [];
        let dispatched = 0;
        sinon
            .stub(
                finder as unknown as {
                    doRefreshAttempt: (
                        options: unknown,
                        attempt: number,
                        configuration: ConfigurationOptions,
                    ) => Promise<NativeInfo[]>;
                },
                'doRefreshAttempt',
            )
            .callsFake((_options: unknown, _attempt: number, configuration: ConfigurationOptions) => {
                executedConfigurations.push(configuration);
                return gates[dispatched++].promise;
            });

        const firstRefresh = finder.refresh(true);
        await flushMicrotasks();
        const secondRefresh = finder.refresh(true);
        await flushMicrotasks();
        const thirdRefresh = finder.refresh(true);
        await flushMicrotasks();

        assert.deepStrictEqual(executedConfigurations, [configA]);

        gates[0].resolve(makeNativeResult('a'));
        await flushMicrotasks();
        gates[1].resolve(makeNativeResult('b'));
        await flushMicrotasks();
        gates[2].resolve(makeNativeResult('a2'));
        await Promise.all([firstRefresh, secondRefresh, thirdRefresh]);

        assert.deepStrictEqual(executedConfigurations, [configA, configB, configA]);
        assert.strictEqual(buildConfiguration.callCount, 3);
    });

    function createFinder(): NativePythonFinderImpl {
        const finder = new NativePythonFinderImpl(
            outputChannel,
            path.join('tool', 'pet'),
            makeApi(),
            Uri.file(path.join(os.tmpdir(), 'pet-inflight-race')),
        );
        finders.push(finder);
        return finder;
    }

    function stubAddToQueue(finder: NativePythonFinderImpl): sinon.SinonStub {
        return sinon.stub((finder as unknown as { pool: { addToQueue: () => unknown } }).pool, 'addToQueue');
    }

    function stubBuildConfiguration(finder: NativePythonFinderImpl): sinon.SinonStub {
        return sinon.stub(
            finder as unknown as { buildConfigurationOptions: () => Promise<ConfigurationOptions> },
            'buildConfigurationOptions',
        );
    }

    function makeConfiguration(overrides: Partial<ConfigurationOptions> = {}): ConfigurationOptions {
        return {
            workspaceDirectories: [Uri.file('/work/a').fsPath],
            environmentDirectories: [],
            condaExecutable: undefined,
            pipenvExecutable: undefined,
            poetryExecutable: undefined,
            ...overrides,
        };
    }

    function makeNativeResult(tag: string): NativeInfo[] {
        return [{ executable: `/py/${tag}` } as unknown as NativeInfo];
    }

    function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
        let resolve!: (value: T) => void;
        const promise = new Promise<T>((res) => {
            resolve = res;
        });
        return { promise, resolve };
    }

    function flushMicrotasks(): Promise<void> {
        return new Promise((resolve) => setImmediate(resolve));
    }
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

    function makeContext(globalStorage: Uri): ExtensionContext {
        return { globalStorageUri: globalStorage } as unknown as ExtensionContext;
    }
});

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
            // ignore
        }
    }
}
