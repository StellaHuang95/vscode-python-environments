import assert from 'node:assert';
import { Uri } from 'vscode';
import {
    ConfigurationOptions,
    configurationEquals,
    DiscoveryResultCache,
    NativeInfo,
} from '../../../managers/common/nativePythonFinder';

suite('configurationEquals', () => {
    test('returns true for two independently-built identical configurations', () => {
        assert.strictEqual(configurationEquals(makeConfig(), makeConfig()), true);
    });

    test('is order-independent for workspaceDirectories', () => {
        const a = makeConfig({ workspaceDirectories: [Uri.file('/work/a').fsPath, Uri.file('/work/b').fsPath] });
        const b = makeConfig({ workspaceDirectories: [Uri.file('/work/b').fsPath, Uri.file('/work/a').fsPath] });
        assert.strictEqual(configurationEquals(a, b), true);
    });

    test('is order-independent for environmentDirectories', () => {
        const a = makeConfig({ environmentDirectories: [Uri.file('/envs/x').fsPath, Uri.file('/envs/y').fsPath] });
        const b = makeConfig({ environmentDirectories: [Uri.file('/envs/y').fsPath, Uri.file('/envs/x').fsPath] });
        assert.strictEqual(configurationEquals(a, b), true);
    });

    test('detects a changed workspaceDirectories entry', () => {
        const a = makeConfig();
        const b = makeConfig({ workspaceDirectories: [Uri.file('/work/a').fsPath, Uri.file('/work/c').fsPath] });
        assert.strictEqual(configurationEquals(a, b), false);
    });

    test('detects a different workspaceDirectories length', () => {
        const a = makeConfig();
        const b = makeConfig({ workspaceDirectories: [Uri.file('/work/a').fsPath] });
        assert.strictEqual(configurationEquals(a, b), false);
    });

    test('detects a changed environmentDirectories entry', () => {
        const a = makeConfig();
        const b = makeConfig({ environmentDirectories: [Uri.file('/envs/x').fsPath, Uri.file('/envs/z').fsPath] });
        assert.strictEqual(configurationEquals(a, b), false);
    });

    test('detects a changed condaExecutable', () => {
        const a = makeConfig();
        const b = makeConfig({ condaExecutable: Uri.file('/tools/conda2').fsPath });
        assert.strictEqual(configurationEquals(a, b), false);
    });

    test('detects condaExecutable defined-vs-undefined', () => {
        const a = makeConfig();
        const b = makeConfig({ condaExecutable: undefined });
        assert.strictEqual(configurationEquals(a, b), false);
    });

    test('detects a changed pipenvExecutable', () => {
        const a = makeConfig();
        const b = makeConfig({ pipenvExecutable: Uri.file('/tools/pipenv2').fsPath });
        assert.strictEqual(configurationEquals(a, b), false);
    });

    test('detects a changed poetryExecutable', () => {
        const a = makeConfig();
        const b = makeConfig({ poetryExecutable: Uri.file('/tools/poetry2').fsPath });
        assert.strictEqual(configurationEquals(a, b), false);
    });

    test('detects a changed cacheDirectory', () => {
        const a = makeConfig();
        const b = makeConfig({ cacheDirectory: Uri.file('/cache/other').fsPath });
        assert.strictEqual(configurationEquals(a, b), false);
    });

    test('detects cacheDirectory defined-vs-undefined', () => {
        const a = makeConfig();
        const b = makeConfig({ cacheDirectory: undefined });
        assert.strictEqual(configurationEquals(a, b), false);
    });

    test('treats identical fsPath workspace directories as equal', () => {
        const p = Uri.file('/work/spaces and unicode проекты').fsPath;
        const a = makeConfig({ workspaceDirectories: [p] });
        const b = makeConfig({ workspaceDirectories: [Uri.file('/work/spaces and unicode проекты').fsPath] });
        assert.strictEqual(configurationEquals(a, b), true);
    });
});

suite('DiscoveryResultCache', () => {
    const ALL = 'all';
    const CONDA = 'Conda';
    const URI_KEY = [Uri.file('/some/project').fsPath].join('\0');

    test('returns undefined for an unknown key', () => {
        const cache = new DiscoveryResultCache();
        assert.strictEqual(cache.getValid(ALL, makeConfig()), undefined);
    });

    test('per-key same-config lookup is a hit', () => {
        const cache = new DiscoveryResultCache();
        const config = makeConfig();
        const results = makeResults('all');
        cache.set(ALL, config, results, cache.generation);
        assert.strictEqual(cache.getValid(ALL, config), results);
    });

    test('round-trips the exact configuration used to tag the entry', () => {
        const cache = new DiscoveryResultCache();
        const configA = makeConfig();
        const configB = makeConfig({ condaExecutable: Uri.file('/tools/conda-changed').fsPath });
        const results = makeResults('all');
        cache.set(ALL, configA, results, cache.generation);
        assert.strictEqual(cache.getValid(ALL, configA), results, 'same config should hit');
        assert.strictEqual(cache.getValid(ALL, configB), undefined, 'changed config should miss');
    });

    test('a config change for one key does not invalidate other keys', () => {
        const cache = new DiscoveryResultCache();
        const configA = makeConfig();
        const configB = makeConfig({ environmentDirectories: [Uri.file('/envs/new').fsPath] });
        const allResults = makeResults('all');
        const condaResults = makeResults('conda');
        cache.set(ALL, configA, allResults, cache.generation);
        cache.set(CONDA, configA, condaResults, cache.generation);

        cache.set(ALL, configB, makeResults('all-2'), cache.generation);

        assert.deepStrictEqual(cache.getValid(CONDA, configA), condaResults);
        assert.strictEqual(cache.getValid(ALL, configB)?.length, 1);
    });

    test('alternating all/kind/URI lookups with unrelated configs do not thrash', () => {
        const cache = new DiscoveryResultCache();
        const configAll = makeConfig();
        const configConda = makeConfig({ poetryExecutable: Uri.file('/tools/poetry-b').fsPath });
        const configUri = makeConfig({ cacheDirectory: Uri.file('/cache/uri').fsPath });
        cache.set(ALL, configAll, makeResults('all'), cache.generation);
        cache.set(CONDA, configConda, makeResults('conda'), cache.generation);
        cache.set(URI_KEY, configUri, makeResults('uri'), cache.generation);
        assert.strictEqual(cache.size, 3);

        for (let i = 0; i < 3; i++) {
            assert.ok(cache.getValid(ALL, configAll), 'all should stay valid');
            assert.ok(cache.getValid(CONDA, configConda), 'conda should stay valid');
            assert.ok(cache.getValid(URI_KEY, configUri), 'uri should stay valid');
        }
        assert.strictEqual(cache.size, 3);
    });

    test('delete() removes a single key', () => {
        const cache = new DiscoveryResultCache();
        const config = makeConfig();
        cache.set(ALL, config, makeResults('all'), cache.generation);
        cache.delete(ALL);
        assert.strictEqual(cache.getValid(ALL, config), undefined);
        assert.strictEqual(cache.size, 0);
    });

    test('clear() empties all entries and advances the generation', () => {
        const cache = new DiscoveryResultCache();
        const config = makeConfig();
        cache.set(ALL, config, makeResults('all'), cache.generation);
        cache.set(CONDA, config, makeResults('conda'), cache.generation);
        const generationBefore = cache.generation;

        cache.clear();

        assert.strictEqual(cache.size, 0);
        assert.strictEqual(cache.generation, generationBefore + 1);
        assert.strictEqual(cache.getValid(ALL, config), undefined);
        assert.strictEqual(cache.getValid(CONDA, config), undefined);
    });

    test('a store from a refresh that began before clear() does not repopulate', () => {
        const cache = new DiscoveryResultCache();
        const config = makeConfig();
        const generationAtStart = cache.generation;
        cache.clear();
        const stored = cache.set(ALL, config, makeResults('stale'), generationAtStart);

        assert.strictEqual(stored, false, 'stale-generation store must be rejected');
        assert.strictEqual(cache.size, 0, 'cache must remain empty after clear');
        assert.strictEqual(cache.getValid(ALL, config), undefined);
    });

    test('a store with the current generation after clear() succeeds', () => {
        const cache = new DiscoveryResultCache();
        const config = makeConfig();
        cache.clear();
        const stored = cache.set(ALL, config, makeResults('fresh'), cache.generation);
        assert.strictEqual(stored, true);
        assert.strictEqual(cache.getValid(ALL, config)?.length, 1);
    });
});

function makeConfig(overrides: Partial<ConfigurationOptions> = {}): ConfigurationOptions {
    return {
        workspaceDirectories: [Uri.file('/work/a').fsPath, Uri.file('/work/b').fsPath],
        environmentDirectories: [Uri.file('/envs/x').fsPath, Uri.file('/envs/y').fsPath],
        condaExecutable: Uri.file('/tools/conda').fsPath,
        pipenvExecutable: Uri.file('/tools/pipenv').fsPath,
        poetryExecutable: Uri.file('/tools/poetry').fsPath,
        cacheDirectory: Uri.file('/cache/poetry').fsPath,
        ...overrides,
    };
}

function makeResults(tag: string): NativeInfo[] {
    return [{ executable: `/py/${tag}` } as unknown as NativeInfo];
}
