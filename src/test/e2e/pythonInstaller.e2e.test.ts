// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as fs from 'fs-extra';
import { promises as nativeFs } from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { CodeLens, commands, ConfigurationTarget, Range, Uri, window, workspace, WorkspaceEdit } from 'vscode';
import { PythonEnvironment, PythonEnvironmentApi } from '../../api';
import { PythonVersion } from '../../common/pythonVersion';
import { isSameOrParentPath, normalizePath } from '../../common/utils/pathUtils';
import type { PythonProjectSettings } from '../../features/projectManager';
import { waitForCondition } from '../testUtils';
import {
    activateInstallerApi as activateApi,
    getInstallerFixtureRoot,
    PersistedInstallerFixture,
    readInstallerFixture,
    runFixturePython as runPython,
} from './pythonInstallerTestUtils';

interface InstalledRuntime {
    readonly provider: 'pymanager' | 'uv';
    readonly pythonPath: string;
}

const SHARED_SCRIPT_NAMES = ['parallel-one.py', 'parallel-two.py'];
const PROBE_BODY = 'import json, sys, pymanager_probe\nprint(json.dumps({"value":pymanager_probe.VALUE,"executable":sys.executable}))';

async function selectedScript(api: PythonEnvironmentApi, uri: Uri): Promise<PythonEnvironment> {
    let selected: PythonEnvironment | undefined;
    await waitForCondition(async () => {
        selected = await api.getEnvironment(uri);
        return selected?.envId.managerId === 'ms-python.python:inline-script';
    }, 60_000, 'The script did not receive its inline environment');
    assert.ok(selected);
    return selected;
}

async function setupLink(uri: Uri): Promise<CodeLens> {
    let lens: CodeLens | undefined;
    await waitForCondition(async () => {
        const lenses = await commands.executeCommand<CodeLens[]>('vscode.executeCodeLensProvider', uri);
        lens = lenses?.find((item) => item.command?.command === 'python-envs.setupInlineScriptEnv');
        return lens !== undefined;
    }, 20_000, 'Saved metadata did not offer the setup CodeLens');
    assert.ok(lens);
    return lens;
}

// This suite creates real runtimes only through the isolated, opt-in test driver.
if (process.env.VSC_PYTHON_INSTALLER_E2E === '1' && process.env.VSC_PYTHON_INSTALLER_VERIFY_RELOAD !== '1') {
    suite('Installer E2E: isolated PyManager and uv', function () {
        this.timeout(300_000);
        let api: PythonEnvironmentApi;
        let root: string;
        let oldVersion: string;
        let newVersion: string;
        let pimPath: string;
        let originalScript: Uri;

        async function resolveAndVerify(executable: string, version: string): Promise<PythonEnvironment> {
            await api.refreshEnvironments(undefined);
            if (isSameOrParentPath(path.join(root, 'pim-runtimes'), executable)) {
                const discovered = (await api.getEnvironments('global')).filter((environment) =>
                    normalizePath(environment.execInfo.run.executable) === normalizePath(executable));
                assert.strictEqual(discovered.length, 1, 'PyManager Python must appear once in Global without registry entries');
                assert.strictEqual(PythonVersion.tryParse(discovered[0].version)?.toString(), version);
            }
            const environment = await api.resolveEnvironment(Uri.file(executable));
            assert.ok(environment, 'The real API must resolve the installed interpreter');
            const info: { executable: string; version: string; prefix: string } = JSON.parse(await runPython(api, root, environment, [
                '-I', '-c',
                'import json, platform, sys; print(json.dumps({"executable":sys.executable,"version":platform.python_version(),"prefix":sys.prefix}))',
            ]));
            assert.strictEqual(info.version, version);
            assert.strictEqual(normalizePath(await nativeFs.realpath(info.executable)), normalizePath(await nativeFs.realpath(executable)));
            assert.ok(
                isSameOrParentPath(root, await nativeFs.realpath(info.prefix)),
                'The interpreter must belong to the isolated fixture',
            );
            assert.strictEqual(PythonVersion.tryParse(environment.version)?.toString(), version);
            return environment;
        }

        suiteSetup(async () => {
            root = await getInstallerFixtureRoot();
            api = await activateApi();
            const known = new Set((await api.getEnvironments('global'))
                .map((environment) => PythonVersion.tryParse(environment.version)?.toString()));
            const pair = [
                ['3.14.6', '3.14.7'],
                ['3.13.13', '3.13.14'],
            ].find(([older, newer]) => !known.has(older) && !known.has(newer));
            assert.ok(pair, 'Use a disposable Windows user with an unoccupied test version pair');
            [oldVersion, newVersion] = pair;
            originalScript = Uri.file(path.join(root, 'workspace', 'inline_probe.py'));
        });

        suiteTeardown(async () => {
            for (const terminal of window.terminals) {
                terminal.dispose();
            }
            await commands.executeCommand('workbench.action.closeAllEditors');
        });

        function wheelDependency(): string {
            return `pymanager-probe @ ${pathToFileURL(path.join(root, 'pymanager_probe-1.0-py3-none-any.whl')).href}`;
        }

        async function writeScript(name: string, dependencies: string[], body = PROBE_BODY): Promise<Uri> {
            const uri = Uri.file(path.join(root, 'workspace', name));
            assert.ok(isSameOrParentPath(path.join(root, 'workspace'), uri.fsPath));
            await fs.outputFile(uri.fsPath, [
                '# /// script',
                `# requires-python = "==${newVersion}"`,
                `# dependencies = ${JSON.stringify(dependencies)}`,
                '# ///',
                body,
                '',
            ].join('\n'));
            return uri;
        }

        async function assertProbe(uri: Uri): Promise<PythonEnvironment> {
            const selected = await selectedScript(api, uri);
            const output: { value: number; executable: string } = JSON.parse(await runPython(api, root, selected, [uri.fsPath]));
            assert.strictEqual(output.value, 723);
            assert.strictEqual(normalizePath(output.executable), normalizePath(selected.execInfo.run.executable));
            return selected;
        }

        test('installs and resolves an actual runtime through the detected PyManager', async () => {
            const result = await commands.executeCommand<InstalledRuntime>(
                'python-envs.test.installPythonRuntime', 'auto', oldVersion,
            );
            assert.ok(result);
            assert.strictEqual(result.provider, 'pymanager');
            pimPath = result.pythonPath;
            assert.ok(isSameOrParentPath(path.join(root, 'pim-runtimes'), pimPath));
            const environment = await resolveAndVerify(pimPath, oldVersion);
            await api.setEnvironment(undefined, environment);
            assert.strictEqual(normalizePath((await api.getEnvironment(undefined))!.execInfo.run.executable), normalizePath(pimPath));
        });

        test('updates only the approved isolated slot and refreshes its actual version', async () => {
            assert.ok(pimPath, 'The initial runtime installation must have completed');
            const result = await commands.executeCommand<InstalledRuntime>(
                'python-envs.test.installPythonRuntime', 'auto', newVersion,
            );
            assert.ok(result);
            assert.strictEqual(normalizePath(result.pythonPath), normalizePath(pimPath));
            await resolveAndVerify(pimPath, newVersion);
        });

        test('refuses to downgrade a newer runtime in the same slot', async () => {
            await assert.rejects(
                async () => { await commands.executeCommand('python-envs.test.installPythonRuntime', 'auto', oldVersion); },
                /downgraded|replaced/i,
            );
            await resolveAndVerify(pimPath, newVersion);
        });

        test('sets up and executes PEP 723 dependencies with the real selected interpreter', async () => {
            const base = await resolveAndVerify(pimPath, newVersion);
            const wheelPath = path.join(root, 'pymanager_probe-1.0-py3-none-any.whl');
            const wheelWriter = [
                'import csv, io, sys, zipfile',
                'files={"pymanager_probe/__init__.py":"VALUE = 723\\n",',
                '"pymanager_probe-1.0.dist-info/METADATA":"Metadata-Version: 2.1\\nName: pymanager-probe\\nVersion: 1.0\\n",',
                '"pymanager_probe-1.0.dist-info/WHEEL":"Wheel-Version: 1.0\\nGenerator: installer-e2e\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n"}',
                'record=io.StringIO()',
                'writer=csv.writer(record)',
                '[writer.writerow([name,"",""]) for name in files]',
                'writer.writerow(["pymanager_probe-1.0.dist-info/RECORD","",""])',
                'files["pymanager_probe-1.0.dist-info/RECORD"]=record.getvalue()',
                'archive=zipfile.ZipFile(sys.argv[1],"w")',
                '[archive.writestr(name,data) for name,data in files.items()]',
                'archive.close()',
            ].join('\n');
            await runPython(api, root, base, ['-I', '-c', wheelWriter, wheelPath]);
            const script = await writeScript('inline_probe.py', [wheelDependency()]);
            await window.showTextDocument(await workspace.openTextDocument(script));
            await setupLink(script);
            await commands.executeCommand('python-envs.setupInlineScriptEnv', script);
            const selected = await selectedScript(api, script);
            const output: { value: number; executable: string } = JSON.parse(await runPython(api, root, selected, [script.fsPath]));
            assert.strictEqual(output.value, 723);
            assert.strictEqual(
                normalizePath(await nativeFs.realpath(output.executable)),
                normalizePath(await nativeFs.realpath(selected.execInfo.run.executable)),
            );
            assert.notStrictEqual(normalizePath(output.executable), normalizePath(pimPath), 'Execution must use the cached venv, not the base');
            await api.refreshEnvironments(undefined);
            const afterRefresh = await api.getEnvironment(script);
            assert.ok(afterRefresh);
            assert.strictEqual(normalizePath(afterRefresh.execInfo.run.executable), normalizePath(output.executable));
            const fixture: PersistedInstallerFixture = {
                version: newVersion,
                pythonPath: pimPath,
                scriptPath: script.fsPath,
                scriptPythonPath: output.executable,
            };
            await fs.writeJson(path.join(root, '.installed-fixture-state.json'), fixture);
        });

        test('runs the existing uv installation backend without user registrations or aliases', async () => {
            const version = '3.11.14';
            const result = await commands.executeCommand<InstalledRuntime>(
                'python-envs.test.installPythonRuntime', 'uv', version,
            );
            assert.ok(result);
            assert.strictEqual(result.provider, 'uv');
            assert.ok(isSameOrParentPath(path.join(root, 'uv-runtimes'), result.pythonPath));
            await resolveAndVerify(result.pythonPath, version);
        });

        test('offers setup and executes dependencies for a script path with spaces and Unicode', async () => {
            const name = path.join('scripts with spaces', `${String.fromCodePoint(0x6D4B, 0x8BD5)} example.py`);
            const uri = await writeScript(name, [wheelDependency()]);
            await window.showTextDocument(await workspace.openTextDocument(uri));
            const lens = await setupLink(uri);
            assert.ok(lens.command);
            await commands.executeCommand(lens.command.command, ...(lens.command.arguments ?? []));
            const selected = await assertProbe(uri);
            const original = await selectedScript(api, originalScript);
            assert.strictEqual(normalizePath(selected.execInfo.run.executable), normalizePath(original.execInfo.run.executable));
        });

        test('concurrent setup of equivalent scripts shares a working cached environment', async () => {
            const scripts = await Promise.all(SHARED_SCRIPT_NAMES.map((name) => writeScript(name, [wheelDependency()])));
            await Promise.all(scripts.map((uri) => commands.executeCommand('python-envs.setupInlineScriptEnv', uri)));
            const [first, second] = await Promise.all(scripts.map(assertProbe));
            assert.strictEqual(normalizePath(first.execInfo.run.executable), normalizePath(second.execInfo.run.executable));
        });

        test('dependency edits rebuild the changed script without changing another script', async () => {
            const uri = await writeScript('changing-dependencies.py', [wheelDependency()]);
            await commands.executeCommand('python-envs.setupInlineScriptEnv', uri);
            const before = await assertProbe(uri);
            const document = await workspace.openTextDocument(uri);
            const replacement = [
                '# /// script', `# requires-python = "==${newVersion}"`, '# dependencies = []', '# ///',
                'import importlib.util, json, sys',
                'print(json.dumps({"has_probe":importlib.util.find_spec("pymanager_probe") is not None,"executable":sys.executable}))',
                '',
            ].join('\n');
            const edit = new WorkspaceEdit();
            edit.replace(uri, new Range(document.positionAt(0), document.positionAt(document.getText().length)), replacement);
            assert.ok(await workspace.applyEdit(edit));
            assert.ok(await document.save());
            await setupLink(uri);
            await commands.executeCommand('python-envs.setupInlineScriptEnv', uri);
            const after = await selectedScript(api, uri);
            assert.notStrictEqual(normalizePath(after.execInfo.run.executable), normalizePath(before.execInfo.run.executable));
            const output: { has_probe: boolean } = JSON.parse(await runPython(api, root, after, [uri.fsPath]));
            assert.strictEqual(output.has_probe, false);
            const original = await assertProbe(originalScript);
            assert.strictEqual(normalizePath(original.execInfo.run.executable), normalizePath(before.execInfo.run.executable));
        });

        test('a plain neighboring script keeps its ordinary environment', async () => {
            const uri = Uri.file(path.join(root, 'workspace', 'plain-neighbor.py'));
            await fs.writeFile(uri.fsPath, 'print("ordinary")\n');
            await window.showTextDocument(await workspace.openTextDocument(uri));
            const selected = await api.getEnvironment(uri);
            assert.ok(selected);
            assert.notStrictEqual(selected.envId.managerId, 'ms-python.python:inline-script');
            assert.strictEqual((await runPython(api, root, selected, [uri.fsPath])).trim(), 'ordinary');
        });

        test('a missing dependency wheel does not create a successful script association', async () => {
            const missing = `unavailable-probe @ ${pathToFileURL(path.join(root, 'unavailable_probe-1.0-py3-none-any.whl')).href}`;
            const uri = await writeScript('broken-dependency.py', [missing], 'print("not executed")');
            await commands.executeCommand('python-envs.setupInlineScriptEnv', uri);
            assert.notStrictEqual((await api.getEnvironment(uri))?.envId.managerId, 'ms-python.python:inline-script');
            await assertProbe(originalScript);
        });

        for (const useUv of [true, false]) {
            test(`creates a project venv from PyManager with alwaysUseUv=${useUv}`, async () => {
                const workspaceUri = workspace.workspaceFolders?.[0].uri;
                assert.ok(workspaceUri && isSameOrParentPath(root, workspaceUri.fsPath));
                const config = workspace.getConfiguration('python-envs', workspaceUri);
                const previousBackend = config.inspect<boolean>('alwaysUseUv')?.globalValue;
                const previousProjects = config.inspect<PythonProjectSettings[]>('pythonProjects')?.workspaceValue;
                const projectUri = Uri.file(path.join(root, 'workspace', useUv ? 'project uv' : 'project stdlib'));
                await fs.mkdir(projectUri.fsPath);
                let environment: PythonEnvironment | undefined;
                try {
                    await config.update('pythonProjects', [...config.get<PythonProjectSettings[]>('pythonProjects', []), {
                        path: path.relative(workspaceUri.fsPath, projectUri.fsPath),
                        envManager: 'ms-python.python:venv',
                        packageManager: 'ms-python.python:pip',
                    }], ConfigurationTarget.Workspace);
                    // This machine-scoped setting belongs to the fixture's isolated User profile.
                    await config.update('alwaysUseUv', useUv, ConfigurationTarget.Global);
                    await waitForCondition(() => api.getPythonProjects().some((project) =>
                        normalizePath(project.uri.fsPath) === normalizePath(projectUri.fsPath)),
                    10_000, 'Venv fixture project was not registered');
                    await api.refreshEnvironments(undefined);
                    environment = await api.createEnvironment(projectUri, {
                        quickCreate: true, additionalPackages: [wheelDependency()],
                    });
                    assert.ok(environment, 'The public API must return the created venv');
                    assert.strictEqual(environment.envId.managerId, 'ms-python.python:venv');
                    assert.ok(isSameOrParentPath(projectUri.fsPath, await nativeFs.realpath(environment.sysPrefix)));
                    const output: { base: string; value: number } = JSON.parse(await runPython(api, root, environment, [
                        '-c', 'import json, sys, pymanager_probe; print(json.dumps({"base":sys._base_executable,"value":pymanager_probe.VALUE}))',
                    ]));
                    assert.strictEqual(normalizePath(await nativeFs.realpath(output.base)), normalizePath(await nativeFs.realpath(pimPath)));
                    assert.strictEqual(output.value, 723);
                    const cfg = await fs.readFile(path.join(environment.sysPrefix, 'pyvenv.cfg'), 'utf8');
                    assert.strictEqual(/^uv =/m.test(cfg), useUv, 'Verify the actual venv backend');
                } finally {
                    try {
                        if (environment) {
                            assert.ok(isSameOrParentPath(projectUri.fsPath, await nativeFs.realpath(environment.sysPrefix)),
                                'Refuse removal outside the owned venv project');
                            await api.removeEnvironment(environment, { runHeadless: true });
                            assert.strictEqual(await fs.pathExists(environment.execInfo.run.executable), false);
                        }
                    } finally {
                        await config.update('alwaysUseUv', previousBackend, ConfigurationTarget.Global);
                        await config.update('pythonProjects', previousProjects, ConfigurationTarget.Workspace);
                    }
                }
            });
        }

        test('an integrated terminal executes the selected script interpreter', async () => {
            const selected = await selectedScript(api, originalScript);
            const outputFile = path.join(root, 'terminal-result.json');
            const script = path.join(root, 'workspace', 'terminal verification.py');
            await fs.writeFile(script, [
                'import json, pathlib, sys, pymanager_probe',
                `result = pathlib.Path(${JSON.stringify(outputFile)})`,
                'temporary = result.with_suffix(".tmp")',
                'temporary.write_text(json.dumps({"executable":sys.executable,"value":pymanager_probe.VALUE}))',
                'temporary.replace(result)',
            ].join('\n'));
            const terminal = await api.runInTerminal(selected, {
                cwd: Uri.file(path.join(root, 'workspace')), args: [script], show: false,
            });
            try {
                await waitForCondition(async () => await fs.pathExists(outputFile), 30_000, 'The terminal did not execute the script');
                const output: { executable: string; value: number } = await fs.readJson(outputFile);
                assert.strictEqual(output.value, 723);
                assert.strictEqual(normalizePath(output.executable), normalizePath(selected.execInfo.run.executable));
            } finally {
                terminal.dispose();
            }
        });
    });
}

if (process.env.VSC_PYTHON_INSTALLER_E2E === '1' && process.env.VSC_PYTHON_INSTALLER_VERIFY_RELOAD === '1') {
    suite('Installer E2E: restored after VS Code restart', function () {
        this.timeout(180_000);
        let root: string;
        let fixture: PersistedInstallerFixture;
        let api: PythonEnvironmentApi;

        suiteSetup(async () => {
            root = await getInstallerFixtureRoot();
            fixture = await readInstallerFixture(root);
            api = await activateApi();
        });

        suiteTeardown(async () => {
            await commands.executeCommand('workbench.action.closeAllEditors');
        });

        test('rediscovers PyManager and restores Global and per-script selections without reinstalling', async () => {
            const global = await api.getEnvironment(undefined);
            assert.ok(global, 'The explicitly selected Global interpreter must survive restart');
            assert.strictEqual(normalizePath(global.execInfo.run.executable), normalizePath(fixture.pythonPath));
            assert.strictEqual(PythonVersion.tryParse(global.version)?.toString(), fixture.version);
            const discovered = (await api.getEnvironments('global')).filter((environment) =>
                normalizePath(environment.execInfo.run.executable) === normalizePath(fixture.pythonPath));
            assert.strictEqual(discovered.length, 1, 'A fresh host must discover the unregistered PyManager runtime once');

            const script = Uri.file(fixture.scriptPath);
            await window.showTextDocument(await workspace.openTextDocument(script));
            const selected = await selectedScript(api, script);
            assert.strictEqual(normalizePath(selected.execInfo.run.executable), normalizePath(fixture.scriptPythonPath));
            const output: { value: number; executable: string } = JSON.parse(await runPython(api, root, selected, [fixture.scriptPath]));
            assert.strictEqual(output.value, 723);
            assert.strictEqual(normalizePath(output.executable), normalizePath(fixture.scriptPythonPath));
        });

        test('restores multiple scripts sharing one cache after restart', async () => {
            for (const name of SHARED_SCRIPT_NAMES) {
                const uri = Uri.file(path.join(root, 'workspace', name));
                await window.showTextDocument(await workspace.openTextDocument(uri));
                const selected = await selectedScript(api, uri);
                assert.strictEqual(normalizePath(selected.execInfo.run.executable), normalizePath(fixture.scriptPythonPath));
                const output: { value: number } = JSON.parse(await runPython(api, root, selected, [uri.fsPath]));
                assert.strictEqual(output.value, 723);
            }
        });

        test('removes and rebuilds a shared cache without deleting scripts or the base Python', async () => {
            const originalUri = Uri.file(fixture.scriptPath);
            const environment = await selectedScript(api, originalUri);
            assert.ok(isSameOrParentPath(root, await nativeFs.realpath(environment.sysPrefix)));
            await api.removeEnvironment(environment, { runHeadless: true });
            assert.strictEqual(await fs.pathExists(environment.execInfo.run.executable), false);
            for (const script of [fixture.scriptPath, ...SHARED_SCRIPT_NAMES.map((name) => path.join(root, 'workspace', name))]) {
                assert.ok((await fs.stat(script)).isFile());
                assert.notStrictEqual((await api.getEnvironment(Uri.file(script)))?.envId.managerId, 'ms-python.python:inline-script');
            }
            const base = await api.resolveEnvironment(Uri.file(fixture.pythonPath));
            assert.ok(base);
            assert.strictEqual((await runPython(api, root, base, ['-I', '-c', 'import platform; print(platform.python_version())'])).trim(), fixture.version);
            await commands.executeCommand('python-envs.setupInlineScriptEnv', originalUri);
            const rebuilt = await selectedScript(api, originalUri);
            const output: { value: number } = JSON.parse(await runPython(api, root, rebuilt, [fixture.scriptPath]));
            assert.strictEqual(output.value, 723);
        });
    });
}
