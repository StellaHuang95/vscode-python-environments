// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as fse from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import * as persistentState from '../../../common/persistentState';
import {
    clearInlineScriptEnvCache,
    getInlineScriptEnvForScript,
    INLINE_SCRIPT_ENVS_KEY,
    setInlineScriptEnvForScript,
    setInlineScriptEnvsForScripts,
} from '../../../managers/inlineScript/inlineScriptUtils';

suite('inlineScriptUtils', () => {
    let mockState: {
        get: sinon.SinonStub;
        set: sinon.SinonStub;
        clear: sinon.SinonStub;
    };
    let tmpDir: string;

    setup(async () => {
        tmpDir = path.join(os.tmpdir(), `iscript-utils-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        await fse.ensureDir(tmpDir);

        mockState = {
            get: sinon.stub(),
            set: sinon.stub().resolves(),
            clear: sinon.stub().resolves(),
        };
        sinon.stub(persistentState, 'getWorkspacePersistentState').resolves(mockState);
    });

    teardown(async () => {
        sinon.restore();
        await fse.remove(tmpDir);
    });

    suite('getInlineScriptEnvForScript', () => {
        test('returns the persisted env path when both binding and env dir exist', async () => {
            const scriptPath = path.join(tmpDir, 'demo.py');
            const envPath = path.join(tmpDir, 'env-abc');
            await fse.ensureDir(envPath);

            mockState.get.withArgs(INLINE_SCRIPT_ENVS_KEY).resolves({ [scriptPath]: envPath });

            assert.strictEqual(await getInlineScriptEnvForScript(scriptPath), envPath);
            assert.strictEqual(mockState.set.called, false, 'no rewrite when binding is fresh');
        });

        test('returns undefined and clears the stale binding when env dir is gone', async () => {
            const scriptPath = path.join(tmpDir, 'demo.py');
            const staleEnvPath = path.join(tmpDir, 'env-abc-gone');

            mockState.get.withArgs(INLINE_SCRIPT_ENVS_KEY).resolves({ [scriptPath]: staleEnvPath });

            assert.strictEqual(await getInlineScriptEnvForScript(scriptPath), undefined);
            assert.ok(mockState.set.called, 'expected the stale binding to be cleared');
            const [key, data] = mockState.set.firstCall.args;
            assert.strictEqual(key, INLINE_SCRIPT_ENVS_KEY);
            assert.strictEqual(scriptPath in (data as Record<string, string>), false);
        });

        test('returns undefined when no binding exists for the script', async () => {
            const scriptPath = path.join(tmpDir, 'demo.py');
            mockState.get.withArgs(INLINE_SCRIPT_ENVS_KEY).resolves({});

            assert.strictEqual(await getInlineScriptEnvForScript(scriptPath), undefined);
            assert.strictEqual(mockState.set.called, false);
        });

        test('returns undefined when the bucket itself is empty', async () => {
            mockState.get.withArgs(INLINE_SCRIPT_ENVS_KEY).resolves(undefined);
            assert.strictEqual(await getInlineScriptEnvForScript(path.join(tmpDir, 'demo.py')), undefined);
        });

        test('swallows persistent-state errors and returns undefined', async () => {
            mockState.get.withArgs(INLINE_SCRIPT_ENVS_KEY).rejects(new Error('memento boom'));
            assert.strictEqual(await getInlineScriptEnvForScript(path.join(tmpDir, 'demo.py')), undefined);
        });
    });

    suite('setInlineScriptEnvForScript', () => {
        test('writes a new binding into the existing bucket', async () => {
            mockState.get.withArgs(INLINE_SCRIPT_ENVS_KEY).resolves({ '/other/script.py': '/other/env' });

            await setInlineScriptEnvForScript('/proj/demo.py', '/proj/env-abc');

            assert.ok(mockState.set.calledOnce);
            const [key, data] = mockState.set.firstCall.args;
            assert.strictEqual(key, INLINE_SCRIPT_ENVS_KEY);
            assert.deepStrictEqual(data, {
                '/other/script.py': '/other/env',
                '/proj/demo.py': '/proj/env-abc',
            });
        });

        test('creates the bucket when it does not exist', async () => {
            mockState.get.withArgs(INLINE_SCRIPT_ENVS_KEY).resolves(undefined);

            await setInlineScriptEnvForScript('/proj/demo.py', '/proj/env-abc');

            const [, data] = mockState.set.firstCall.args;
            assert.deepStrictEqual(data, { '/proj/demo.py': '/proj/env-abc' });
        });

        test('removes the binding when envPath is undefined', async () => {
            mockState.get
                .withArgs(INLINE_SCRIPT_ENVS_KEY)
                .resolves({ '/proj/demo.py': '/proj/env-abc', '/proj/other.py': '/proj/env-xyz' });

            await setInlineScriptEnvForScript('/proj/demo.py', undefined);

            const [, data] = mockState.set.firstCall.args;
            assert.deepStrictEqual(data, { '/proj/other.py': '/proj/env-xyz' });
        });

        test('clearing a script that has no binding is a no-op (key is left absent)', async () => {
            mockState.get.withArgs(INLINE_SCRIPT_ENVS_KEY).resolves({ '/proj/other.py': '/proj/env-xyz' });

            await setInlineScriptEnvForScript('/proj/missing.py', undefined);

            const [, data] = mockState.set.firstCall.args;
            assert.deepStrictEqual(data, { '/proj/other.py': '/proj/env-xyz' });
        });
    });

    suite('setInlineScriptEnvsForScripts', () => {
        test('writes the memento exactly once for all scripts', async () => {
            mockState.get.withArgs(INLINE_SCRIPT_ENVS_KEY).resolves(undefined);

            await setInlineScriptEnvsForScripts(['/proj/a.py', '/proj/b.py', '/proj/c.py'], '/proj/env-shared');

            assert.strictEqual(mockState.set.callCount, 1, 'expected a single batched write');
            const [, data] = mockState.set.firstCall.args;
            assert.deepStrictEqual(data, {
                '/proj/a.py': '/proj/env-shared',
                '/proj/b.py': '/proj/env-shared',
                '/proj/c.py': '/proj/env-shared',
            });
        });

        test('removes all listed bindings when envPath is undefined', async () => {
            mockState.get.withArgs(INLINE_SCRIPT_ENVS_KEY).resolves({
                '/proj/a.py': '/proj/env-1',
                '/proj/b.py': '/proj/env-1',
                '/proj/keep.py': '/proj/env-2',
            });

            await setInlineScriptEnvsForScripts(['/proj/a.py', '/proj/b.py'], undefined);

            const [, data] = mockState.set.firstCall.args;
            assert.deepStrictEqual(data, { '/proj/keep.py': '/proj/env-2' });
        });

        test('empty fsPaths array still writes (no-op write, preserves existing data)', async () => {
            mockState.get.withArgs(INLINE_SCRIPT_ENVS_KEY).resolves({ '/proj/a.py': '/proj/env-1' });

            await setInlineScriptEnvsForScripts([], '/proj/env-shared');

            const [, data] = mockState.set.firstCall.args;
            assert.deepStrictEqual(data, { '/proj/a.py': '/proj/env-1' });
        });
    });

    suite('clearInlineScriptEnvCache', () => {
        test('clears exactly the inline-script bucket key', async () => {
            await clearInlineScriptEnvCache();
            assert.ok(mockState.clear.calledOnce);
            assert.deepStrictEqual(mockState.clear.firstCall.args[0], [INLINE_SCRIPT_ENVS_KEY]);
        });
    });
});
