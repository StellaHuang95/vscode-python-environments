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
} from '../../../managers/common/nativePythonFinder';

interface FakeConnection {
    sendRequest: sinon.SinonStub;
    dispose: sinon.SinonStub;
}

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

suite('NativePythonFinderImpl.clearCache', () => {
    let startStub: sinon.SinonStub;
    let emptyDirStub: sinon.SinonStub;
    let outputChannel: LogOutputChannel;
    const finders: NativePythonFinderImpl[] = [];

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
