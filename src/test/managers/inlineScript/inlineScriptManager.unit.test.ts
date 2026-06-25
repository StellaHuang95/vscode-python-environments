// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import assert from 'assert';
import * as fse from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import { LogOutputChannel, Uri } from 'vscode';
import { EnvironmentManager, PythonEnvironment } from '../../../api';
import * as persistentState from '../../../common/persistentState';
import { InlineScriptManager } from '../../../managers/inlineScript/inlineScriptManager';
import { INLINE_SCRIPT_ENVS_KEY } from '../../../managers/inlineScript/inlineScriptUtils';

function makeFakeLog(): LogOutputChannel {
    return sinon.createStubInstance(
        class {
            info() {}
            warn() {}
            error() {}
            debug() {}
            trace() {}
            show() {}
            dispose() {}
            append() {}
            appendLine() {}
            replace() {}
            clear() {}
            hide() {}
        },
    ) as unknown as LogOutputChannel;
}

function makeEnv(overrides: Partial<PythonEnvironment> = {}): PythonEnvironment {
    return {
        envId: { id: 'fake', managerId: 'ms-python.python:inline-script' },
        name: 'fake',
        displayName: 'fake',
        displayPath: '/fake',
        version: '3.12.0',
        environmentPath: Uri.file('/fake'),
        execInfo: { run: { executable: '/fake' } },
        sysPrefix: '/fake',
        ...overrides,
    };
}

suite('InlineScriptManager', () => {
    let mgr: InlineScriptManager;
    let mockState: {
        get: sinon.SinonStub;
        set: sinon.SinonStub;
        clear: sinon.SinonStub;
    };

    setup(() => {
        mockState = {
            get: sinon.stub().resolves(undefined),
            set: sinon.stub().resolves(),
            clear: sinon.stub().resolves(),
        };
        sinon.stub(persistentState, 'getWorkspacePersistentState').resolves(mockState);
        mgr = new InlineScriptManager(makeFakeLog());
    });

    teardown(() => {
        mgr.dispose();
        sinon.restore();
    });

    suite('static metadata', () => {
        test('name is "inline-script"', () => {
            assert.strictEqual(mgr.name, 'inline-script');
        });

        test('displayName is set (for the picker section header)', () => {
            assert.ok(mgr.displayName);
            assert.ok(mgr.displayName.length > 0);
        });

        test('preferredPackageManagerId is the standard pip manager id', () => {
            assert.strictEqual(mgr.preferredPackageManagerId, 'ms-python.python:pip');
        });

        test('iconPath is defined (renders in the picker)', () => {
            assert.ok(mgr.iconPath);
        });

        test('tooltip is defined (shown on hover in the picker)', () => {
            assert.ok(mgr.tooltip);
        });

        test('does not implement optional create / remove / quickCreateConfig', () => {
            // Cast via the interface to probe optional methods (the concrete class type doesn't declare them).
            const asInterface: EnvironmentManager = mgr;
            assert.strictEqual(asInterface.create, undefined);
            assert.strictEqual(asInterface.remove, undefined);
            assert.strictEqual(asInterface.quickCreateConfig, undefined);
        });
    });

    suite('refresh / resolve no-ops', () => {
        test('refresh(scope) is a no-op and does not throw', async () => {
            await assert.doesNotReject(mgr.refresh(undefined));
            await assert.doesNotReject(mgr.refresh(Uri.file('/tmp/script.py')));
        });

        test('resolve(Uri) returns undefined', async () => {
            assert.strictEqual(await mgr.resolve(Uri.file('/tmp/script.py')), undefined);
        });
    });

    suite('set / get round-trip', () => {
        test('set(Uri, env) makes get(Uri) return the env', async () => {
            const scriptUri = Uri.file('/tmp/never-exists/script.py');
            const env = makeEnv();
            await mgr.set(scriptUri, env);
            assert.strictEqual(await mgr.get(scriptUri), env);
        });

        test('set(Uri, env) makes getEnvironments(Uri) return [env]', async () => {
            const scriptUri = Uri.file('/tmp/never-exists/script.py');
            const env = makeEnv();
            await mgr.set(scriptUri, env);
            assert.deepStrictEqual(await mgr.getEnvironments(scriptUri), [env]);
        });

        test('set(Uri, undefined) clears the binding', async () => {
            const scriptUri = Uri.file('/tmp/never-exists/script.py');
            await mgr.set(scriptUri, makeEnv());
            await mgr.set(scriptUri, undefined);
            assert.strictEqual(await mgr.get(scriptUri), undefined);
        });

        test('set with a non-Uri scope is a no-op (no memento write, no event)', async () => {
            const envListener = sinon.spy();
            mgr.onDidChangeEnvironment(envListener);

            await mgr.set(undefined, makeEnv());

            assert.strictEqual(mockState.set.called, false);
            assert.strictEqual(envListener.callCount, 0);
        });

        test('get with a non-Uri scope returns undefined', async () => {
            await mgr.set(Uri.file('/tmp/never-exists/script.py'), makeEnv());
            assert.strictEqual(await mgr.get(undefined), undefined);
        });
    });

    suite('persistence', () => {
        test('set(Uri, env) writes the binding to the inline-scripts memento key', async () => {
            await mgr.set(Uri.file('/proj/demo.py'), makeEnv({ environmentPath: Uri.file('/proj/env-abc') }));

            assert.ok(mockState.set.calledOnce);
            const [key, data] = mockState.set.firstCall.args;
            assert.strictEqual(key, INLINE_SCRIPT_ENVS_KEY);
            const entries = data as Record<string, string>;
            // Single binding written. Use Object.values rather than literal-path key matching
            // so the test is robust to path normalization differences across platforms.
            assert.strictEqual(Object.keys(entries).length, 1);
            assert.strictEqual(Object.values(entries)[0], Uri.file('/proj/env-abc').fsPath);
        });

        test('set(Uri, undefined) removes the binding from the memento', async () => {
            mockState.get.withArgs(INLINE_SCRIPT_ENVS_KEY).resolves({
                [Uri.file('/proj/demo.py').fsPath]: Uri.file('/proj/env-abc').fsPath,
            });

            await mgr.set(Uri.file('/proj/demo.py'), undefined);

            const [, data] = mockState.set.firstCall.args;
            assert.deepStrictEqual(data, {});
        });

        test('uses INLINE_SCRIPT_ENVS_KEY (not the venv key)', async () => {
            await mgr.set(Uri.file('/proj/demo.py'), makeEnv());
            const [key] = mockState.set.firstCall.args;
            assert.ok(key.includes('inlineScripts'));
            assert.ok(!key.includes(':venv:'));
        });
    });

    suite('events', () => {
        test('set fires onDidChangeEnvironment with old → new envIds', async () => {
            const listener = sinon.spy();
            mgr.onDidChangeEnvironment(listener);
            const scriptUri = Uri.file('/tmp/never-exists/script.py');
            const env = makeEnv();

            await mgr.set(scriptUri, env);

            assert.strictEqual(listener.callCount, 1);
            const ev = listener.firstCall.args[0];
            assert.strictEqual(ev.uri, scriptUri);
            assert.strictEqual(ev.old, undefined);
            assert.strictEqual(ev.new, env);
        });

        test('re-setting the same env does NOT fire the event (envId-deduped)', async () => {
            const listener = sinon.spy();
            const scriptUri = Uri.file('/tmp/never-exists/script.py');
            const env = makeEnv();

            await mgr.set(scriptUri, env);
            mgr.onDidChangeEnvironment(listener);
            await mgr.set(scriptUri, makeEnv()); // same envId.id

            assert.strictEqual(listener.callCount, 0);
        });

        test('clearing a binding fires onDidChangeEnvironment with new=undefined', async () => {
            const scriptUri = Uri.file('/tmp/never-exists/script.py');
            const env = makeEnv();
            await mgr.set(scriptUri, env);

            const listener = sinon.spy();
            mgr.onDidChangeEnvironment(listener);
            await mgr.set(scriptUri, undefined);

            assert.strictEqual(listener.callCount, 1);
            const ev = listener.firstCall.args[0];
            assert.strictEqual(ev.old, env);
            assert.strictEqual(ev.new, undefined);
        });

        test('refresh / resolve do not fire any event', async () => {
            const envsListener = sinon.spy();
            const envListener = sinon.spy();
            mgr.onDidChangeEnvironments(envsListener);
            mgr.onDidChangeEnvironment(envListener);

            await mgr.refresh(undefined);
            await mgr.resolve(Uri.file('/tmp/never-exists/script.py'));

            assert.strictEqual(envsListener.callCount, 0);
            assert.strictEqual(envListener.callCount, 0);
        });
    });

    suite('getEnvironments("all")', () => {
        test('returns [] before any set', async () => {
            assert.deepStrictEqual(await mgr.getEnvironments('all'), []);
        });

        test('returns each bound env exactly once after multiple sets', async () => {
            const envA = makeEnv({ envId: { id: 'env-a', managerId: 'ms-python.python:inline-script' } });
            const envB = makeEnv({ envId: { id: 'env-b', managerId: 'ms-python.python:inline-script' } });
            await mgr.set(Uri.file('/tmp/never-exists/a.py'), envA);
            await mgr.set(Uri.file('/tmp/never-exists/b.py'), envB);

            const all = await mgr.getEnvironments('all');
            assert.strictEqual(all.length, 2);
            assert.ok(all.includes(envA));
            assert.ok(all.includes(envB));
        });

        test('dedupes by envId.id when the same env is bound to multiple scripts', async () => {
            const shared = makeEnv({ envId: { id: 'env-shared', managerId: 'ms-python.python:inline-script' } });
            await mgr.set(Uri.file('/tmp/never-exists/a.py'), shared);
            await mgr.set(Uri.file('/tmp/never-exists/b.py'), shared);
            await mgr.set(Uri.file('/tmp/never-exists/c.py'), shared);

            const all = await mgr.getEnvironments('all');
            assert.deepStrictEqual(all, [shared]);
        });

        test('non-"all", non-Uri scope returns []', async () => {
            await mgr.set(Uri.file('/tmp/never-exists/a.py'), makeEnv());
            assert.deepStrictEqual(await mgr.getEnvironments('global'), []);
        });
    });

    suite('requires-python re-verify on get', () => {
        let tmpDir: string;

        setup(async () => {
            tmpDir = path.join(os.tmpdir(), `iscript-mgr-${Date.now()}-${Math.random().toString(36).slice(2)}`);
            await fse.ensureDir(tmpDir);
        });

        teardown(async () => {
            await fse.remove(tmpDir);
        });

        async function writeScript(name: string, body: string): Promise<Uri> {
            const fsPath = path.join(tmpDir, name);
            await fse.writeFile(fsPath, body, 'utf8');
            return Uri.file(fsPath);
        }

        test('returns the env when the script has no metadata block', async () => {
            const script = await writeScript('plain.py', 'print("hello")\n');
            const env = makeEnv({ version: '3.12.0' });
            await mgr.set(script, env);

            assert.strictEqual(await mgr.get(script), env);
        });

        test('returns the env when the script has no requires-python', async () => {
            const script = await writeScript(
                'deps-only.py',
                '# /// script\n# dependencies = ["requests"]\n# ///\nprint("hi")\n',
            );
            const env = makeEnv({ version: '3.12.0' });
            await mgr.set(script, env);

            assert.strictEqual(await mgr.get(script), env);
        });

        test('returns the env when requires-python is satisfied', async () => {
            const script = await writeScript(
                'satisfied.py',
                '# /// script\n# requires-python = ">=3.11"\n# ///\nprint("hi")\n',
            );
            const env = makeEnv({ version: '3.12.4' });
            await mgr.set(script, env);

            assert.strictEqual(await mgr.get(script), env);
        });

        test('clears the binding and returns undefined when requires-python is no longer satisfied', async () => {
            const script = await writeScript(
                'tightened.py',
                '# /// script\n# requires-python = "==3.11.7"\n# ///\nprint("hi")\n',
            );
            const env = makeEnv({ version: '3.12.4' });
            await mgr.set(script, env);
            mockState.set.resetHistory();

            const listener = sinon.spy();
            mgr.onDidChangeEnvironment(listener);

            const result = await mgr.get(script);

            assert.strictEqual(result, undefined, 'expected stale binding to be returned as undefined');
            assert.strictEqual(await mgr.get(script), undefined, 'subsequent get also returns undefined');
            assert.ok(mockState.set.called, 'expected the stale binding to be cleared from the memento');
            const [, data] = mockState.set.firstCall.args;
            assert.deepStrictEqual(data, {}, 'memento should be empty after clearing the stale binding');
            assert.strictEqual(listener.callCount, 1, 'expected onDidChangeEnvironment to fire on clear');
            assert.strictEqual(listener.firstCall.args[0].new, undefined);
        });

        test('returns the env when the script file is unreadable (treat as no constraint)', async () => {
            const env = makeEnv({ version: '3.12.0' });
            const missingScript = Uri.file(path.join(tmpDir, 'never-existed.py'));
            await mgr.set(missingScript, env);

            assert.strictEqual(await mgr.get(missingScript), env);
        });

        test('returns the env when env.version is empty (treat as no constraint)', async () => {
            const script = await writeScript(
                'tight.py',
                '# /// script\n# requires-python = "==3.11.7"\n# ///\nprint("hi")\n',
            );
            const env = makeEnv({ version: '' });
            await mgr.set(script, env);

            assert.strictEqual(await mgr.get(script), env);
        });
    });

    suite('disposal', () => {
        test('dispose() does not throw', () => {
            assert.doesNotThrow(() => mgr.dispose());
        });

        test('dispose() is idempotent', () => {
            mgr.dispose();
            assert.doesNotThrow(() => mgr.dispose());
        });
    });
});
