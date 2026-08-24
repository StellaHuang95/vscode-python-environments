import * as fs from 'fs/promises';
import * as path from 'path';
import { EventEmitter, l10n, LogOutputChannel, MarkdownString, ProgressLocation, ThemeIcon, Uri } from 'vscode';
import {
    CreateEnvironmentOptions,
    CreateEnvironmentScope,
    DidChangeEnvironmentEventArgs,
    DidChangeEnvironmentsEventArgs,
    EnvironmentChangeKind,
    EnvironmentManager,
    GetEnvironmentScope,
    GetEnvironmentsScope,
    IconPath,
    PythonEnvironment,
    PythonEnvironmentApi,
    PythonProject,
    QuickCreateConfig,
    RefreshEnvironmentsScope,
    RemoveEnvironmentOptions,
    ResolveEnvironmentContext,
    SetEnvironmentScope,
} from '../../api';
import { executeCommand } from '../../common/command.api';
import { PYTHON_EXTENSION_ID } from '../../common/constants';
import { VenvManagerStrings } from '../../common/localize';
import { traceError, traceWarn } from '../../common/logging';
import { createDeferred, Deferred } from '../../common/utils/deferred';
import { normalizePath, isPathInside } from '../../common/utils/pathUtils';
import { showErrorMessage, showInformationMessage, withProgress } from '../../common/window.apis';
import { findParentIfFile } from '../../features/envCommands';
import { getProjectFsPathForScope, tryFastPathGet } from '../common/fastPath';
import { NativePythonFinder } from '../common/nativePythonFinder';
import { getLatest, shortenVersionString, sortEnvironments } from '../common/utils';
import { promptInstallPythonViaUv } from './uvPythonInstaller';
import {
    clearVenvCache,
    CreateEnvironmentResult,
    createPythonVenv,
    findVirtualEnvironments,
    getDefaultGlobalVenvLocation,
    getGlobalVenvLocation,
    getVenvForGlobal,
    getVenvForWorkspace,
    quickCreateVenv,
    removeVenv,
    resolveVenvPythonEnvironmentPath,
    setVenvForGlobal,
    setVenvForWorkspace,
    setVenvForWorkspaces,
} from './venvUtils';

export class VenvManager implements EnvironmentManager {
    private collection: PythonEnvironment[] = [];
    private refreshChain: Promise<void> = Promise.resolve();
    private collectionMutationGeneration = 0;
    private readonly directRemovalGenerations = new Map<string, number>();
    private readonly fsPathToEnv: Map<string, PythonEnvironment> = new Map();
    private globalEnv: PythonEnvironment | undefined;
    private skipWatcherRefresh = false;

    private readonly _onDidChangeEnvironment = new EventEmitter<DidChangeEnvironmentEventArgs>();
    public readonly onDidChangeEnvironment = this._onDidChangeEnvironment.event;

    private readonly _onDidChangeEnvironments = new EventEmitter<DidChangeEnvironmentsEventArgs>();
    public readonly onDidChangeEnvironments = this._onDidChangeEnvironments.event;

    readonly name: string;
    readonly displayName: string;
    readonly preferredPackageManagerId: string;
    readonly description?: string | undefined;
    readonly tooltip?: string | MarkdownString | undefined;
    readonly iconPath?: IconPath | undefined;

    constructor(
        private readonly nativeFinder: NativePythonFinder,
        private readonly api: PythonEnvironmentApi,
        private readonly baseManager: EnvironmentManager,
        public readonly log: LogOutputChannel,
    ) {
        this.name = 'venv';
        this.displayName = 'venv';
        // Descriptions were a bit too visually noisy
        // https://github.com/microsoft/vscode-python-environments/issues/167
        this.description = undefined;
        this.tooltip = new MarkdownString(VenvManagerStrings.venvManagerDescription, true);
        this.preferredPackageManagerId = 'ms-python.python:pip';
        this.iconPath = new ThemeIcon('python');
    }

    private _initialized: Deferred<void> | undefined;
    async initialize(): Promise<void> {
        if (this._initialized) {
            return this._initialized.promise;
        }

        this._initialized = createDeferred();

        try {
            await this.internalRefresh(undefined, false, VenvManagerStrings.venvInitialize);
        } finally {
            this._initialized.resolve();
        }
    }

    /**
     * Returns configuration for quick create in the workspace root, undefined if no suitable Python 3 version is found.
     */
    quickCreateConfig(): QuickCreateConfig | undefined {
        if (!this.globalEnv || !this.globalEnv.version.startsWith('3.')) {
            return undefined;
        }
        return {
            description: l10n.t('Create a virtual environment in workspace root'),
            detail: l10n.t(
                'Uses Python version {0} and installs workspace dependencies.',
                shortenVersionString(this.globalEnv.version),
            ),
        };
    }

    async create(
        scope: CreateEnvironmentScope,
        options: CreateEnvironmentOptions | undefined,
    ): Promise<PythonEnvironment | undefined> {
        try {
            this.skipWatcherRefresh = true;
            let isGlobal = scope === 'global';
            if (Array.isArray(scope) && scope.length > 1) {
                isGlobal = true;
            }
            let uri: Uri | undefined = undefined;
            if (isGlobal) {
                uri = options?.quickCreate ? await getDefaultGlobalVenvLocation() : await getGlobalVenvLocation();
            } else {
                uri = scope instanceof Uri ? scope : (scope as Uri[])[0];
            }

            if (!uri) {
                return;
            }

            const venvRoot: Uri = Uri.file(await findParentIfFile(uri.fsPath));

            let globals = await this.api.getEnvironments('global');

            // If no Python environments found, offer to install Python via uv
            if (globals.length === 0) {
                const installedPath = await promptInstallPythonViaUv('createEnvironment', this.log);
                if (installedPath) {
                    // Refresh environments to detect the newly installed Python
                    await this.api.refreshEnvironments(undefined);
                    // Re-fetch environments after refresh
                    globals = await this.api.getEnvironments('global');
                    // Update globalEnv reference if we found any Python 3.x environments
                    const python3Envs = globals.filter((e) => e.version.startsWith('3.'));
                    if (python3Envs.length === 0) {
                        this.log.warn('Python installed via uv but no Python 3.x global environments were detected.');
                    } else {
                        this.globalEnv = getLatest(python3Envs);
                    }
                }
            }

            let result: CreateEnvironmentResult | undefined = undefined;
            if (options?.quickCreate) {
                // error on missing information
                if (!this.globalEnv) {
                    this.log.error('No base python found');
                    showErrorMessage(VenvManagerStrings.venvErrorNoBasePython);
                    throw new Error('No base python found');
                }
                if (!this.globalEnv.version.startsWith('3.')) {
                    this.log.error('Did not find any base python 3.*');
                    globals.forEach((e, i) => {
                        this.log.error(`${i}: ${e.version} : ${e.environmentPath.fsPath}`);
                    });
                    showErrorMessage(VenvManagerStrings.venvErrorNoPython3);
                    throw new Error('Did not find any base python 3.*');
                }
                if (this.globalEnv && this.globalEnv.version.startsWith('3.')) {
                    // quick create given correct information
                    result = await quickCreateVenv(
                        this.nativeFinder,
                        this.api,
                        this.log,
                        this,
                        this.globalEnv,
                        venvRoot,
                        options?.additionalPackages,
                    );
                }
            } else {
                // If quickCreate is not set that means the user triggered this method from
                // environment manager View, by selecting the venv manager.
                result = await createPythonVenv(this.nativeFinder, this.api, this.log, this, globals, venvRoot, {
                    showQuickAndCustomOptions: options?.quickCreate === undefined,
                });
            }

            if (result?.environment) {
                const environment = result.environment;

                this.addEnvironment(environment, true);

                // Add .gitignore to the .venv folder
                try {
                    // determine if env path is python binary or environment folder
                    let envPath = environment.environmentPath.fsPath;
                    try {
                        const stat = await fs.stat(envPath);
                        if (!stat.isDirectory()) {
                            // If the env path is a file (likely the python binary), use parent-parent as the env path
                            // following format of .venv/bin/python or .venv\Scripts\python.exe
                            envPath = Uri.file(path.dirname(path.dirname(envPath))).fsPath;
                        }
                    } catch (err) {
                        // If stat fails, fallback to original envPath
                        traceWarn(
                            `Failed to stat environment path: ${envPath}. Error: ${
                                err instanceof Error ? err.message : String(err)
                            }, continuing to attempt to create .gitignore.`,
                        );
                    }
                    const gitignorePath = path.join(envPath, '.gitignore');
                    await fs.writeFile(gitignorePath, '*\n', { flag: 'w' });
                } catch (err) {
                    traceError(
                        `Failed to create .gitignore in venv: ${
                            err instanceof Error ? err.message : String(err)
                        }, continuing.`,
                    );
                }

                // Open the parent folder of the venv in the current window immediately after creation
                const envParent = environment.sysPrefix;
                try {
                    await executeCommand('revealInExplorer', Uri.file(envParent));
                } catch (error) {
                    showErrorMessage(
                        l10n.t(
                            'Failed to reveal venv parent folder in VS Code Explorer: but venv was still created in {0}',
                            envParent,
                        ),
                    );
                    traceError(
                        `Failed to reveal venv parent folder in VS Code Explorer: ${
                            error instanceof Error ? error.message : String(error)
                        }`,
                    );
                }
            } else if (result?.envCreationErr) {
                // Show error message to user when environment creation failed
                showErrorMessage(l10n.t('Failed to create virtual environment: {0}', result.envCreationErr));
            }
            return result?.environment ?? undefined;
        } finally {
            this.skipWatcherRefresh = false;
        }
    }

    /**
     * Removes the specified Python environment, updates internal collections, and fires change events as needed.
     */
    async remove(environment: PythonEnvironment, options?: RemoveEnvironmentOptions): Promise<void> {
        try {
            this.skipWatcherRefresh = true;

            const isRemoved = await removeVenv(environment, this.log, options);
            if (!isRemoved) {
                return;
            }
            this.updateCollection(environment);
            this._onDidChangeEnvironments.fire([{ environment, kind: EnvironmentChangeKind.remove }]);

            const changedUris = this.updateFsPathToEnv(environment);

            for (const uri of changedUris) {
                const newEnv = await this.get(uri);
                this._onDidChangeEnvironment.fire({ uri, old: environment, new: newEnv });
            }

            if (this.globalEnv?.envId.id === environment.envId.id) {
                await this.set(undefined, undefined);
            }
        } finally {
            this.skipWatcherRefresh = false;
        }
    }

    private updateCollection(environment: PythonEnvironment): void {
        const envPath = normalizePath(environment.environmentPath.fsPath);
        const before = this.collection.length;
        this.collection = this.collection.filter((e) => normalizePath(e.environmentPath.fsPath) !== envPath);
        if (this.collection.length !== before) {
            this.collectionMutationGeneration++;
            this.directRemovalGenerations.set(envPath, this.collectionMutationGeneration);
        }
    }

    private wasDirectlyRemovedSince(environment: PythonEnvironment, generation: number): boolean {
        const removedGeneration = this.directRemovalGenerations.get(normalizePath(environment.environmentPath.fsPath));
        return removedGeneration !== undefined && removedGeneration > generation;
    }

    private updateFsPathToEnv(environment: PythonEnvironment): Uri[] {
        const envPath = normalizePath(environment.environmentPath.fsPath);
        const changed: Uri[] = [];
        this.fsPathToEnv.forEach((env, uri) => {
            if (normalizePath(env.environmentPath.fsPath) === envPath) {
                this.fsPathToEnv.delete(uri);
                changed.push(Uri.file(uri));
            }
        });
        return changed;
    }

    async refresh(scope: RefreshEnvironmentsScope): Promise<void> {
        return this.internalRefresh(scope, true, VenvManagerStrings.venvRefreshing);
    }

    async watcherRefresh(): Promise<void> {
        if (this.skipWatcherRefresh) {
            return;
        }
        return this.internalRefresh(undefined, true, VenvManagerStrings.venvRefreshing);
    }

    private async internalRefresh(
        scope: RefreshEnvironmentsScope,
        hardRefresh: boolean,
        title: string,
        location: ProgressLocation = ProgressLocation.Window,
    ): Promise<void> {
        await withProgress(
            {
                location,
                title,
            },
            async () => {
                const run = this.refreshChain.then(
                    async (): Promise<DidChangeEnvironmentsEventArgs | undefined> => {
                        const generation = this.collectionMutationGeneration;
                        for (const [key, removedGeneration] of this.directRemovalGenerations) {
                            if (removedGeneration <= generation) {
                                this.directRemovalGenerations.delete(key);
                            }
                        }
                        let scopeRoot: string | undefined;
                        if (scope) {
                            try {
                                scopeRoot = await findParentIfFile(scope.fsPath);
                            } catch (err) {
                                if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
                                    return undefined;
                                }
                                throw err;
                            }
                        }
                        const discovered =
                            (await findVirtualEnvironments(
                                hardRefresh,
                                this.nativeFinder,
                                this.api,
                                this.log,
                                this,
                                scopeRoot !== undefined ? [Uri.file(scopeRoot)] : undefined,
                            )) ?? [];
                        if (this.collectionMutationGeneration !== generation) {
                            return undefined;
                        }
                        if (scopeRoot !== undefined) {
                            return this.mergeScopedEnvironments(scopeRoot, discovered, generation);
                        }
                        const previousCollection = this.collection;
                        this.collection = [...discovered];
                        const appended = await this.loadEnvMap();
                        const discard = previousCollection
                            .filter((env) => !this.wasDirectlyRemovedSince(env, generation))
                            .map((env) => ({
                                kind: EnvironmentChangeKind.remove,
                                environment: env,
                            }));
                        const added = [...discovered, ...appended]
                            .filter((env) => this.collection.includes(env))
                            .map((env) => ({
                                environment: env,
                                kind: EnvironmentChangeKind.add,
                            }));
                        const fullChanges = [...discard, ...added];
                        return fullChanges.length > 0 ? fullChanges : undefined;
                    },
                );
                this.refreshChain = run.then(
                    () => undefined,
                    () => undefined,
                );
                const changes = await run;

                if (changes !== undefined) {
                    this._onDidChangeEnvironments.fire(changes);
                }
            },
        );
    }

    // A scoped discovery is authoritative only within `scope`: environments in other workspace
    // folders (and globals outside it) are retained untouched, so they neither disappear nor emit
    // events; only in-scope environments are replaced by the freshly discovered ones.
    private async mergeScopedEnvironments(
        scopeRoot: string,
        discovered: readonly PythonEnvironment[],
        generation: number,
    ): Promise<DidChangeEnvironmentsEventArgs | undefined> {
        const inScope = (fsPath: string): boolean => isPathInside(scopeRoot, fsPath);

        const retained: PythonEnvironment[] = [];
        const oldInScope: PythonEnvironment[] = [];
        const oldByPath = new Map<string, PythonEnvironment>();
        for (const env of this.collection) {
            if (inScope(env.environmentPath.fsPath)) {
                oldInScope.push(env);
                const key = normalizePath(env.environmentPath.fsPath);
                if (!oldByPath.has(key)) {
                    oldByPath.set(key, env);
                }
            } else {
                retained.push(env);
            }
        }

        const retainedPaths = new Set(retained.map((env) => normalizePath(env.environmentPath.fsPath)));
        const discoveredByPath = new Map<string, PythonEnvironment>();
        for (const env of discovered) {
            if (!inScope(env.environmentPath.fsPath)) {
                continue;
            }
            const key = normalizePath(env.environmentPath.fsPath);
            if (retainedPaths.has(key) || discoveredByPath.has(key)) {
                continue;
            }
            discoveredByPath.set(key, env);
        }

        const finalInScope: PythonEnvironment[] = [];
        const added: PythonEnvironment[] = [];
        for (const [key, env] of discoveredByPath) {
            if (oldByPath.get(key) === env) {
                finalInScope.push(env);
            } else {
                added.push(env);
                finalInScope.push(env);
            }
        }

        this.collection = [...retained, ...finalInScope];
        const appended = await this.loadEnvMap(inScope);

        const changes: DidChangeEnvironmentsEventArgs = [];
        for (const env of oldInScope) {
            if (!this.collection.includes(env) && !this.wasDirectlyRemovedSince(env, generation)) {
                changes.push({ environment: env, kind: EnvironmentChangeKind.remove });
            }
        }
        for (const env of [...added, ...appended]) {
            if (this.collection.includes(env)) {
                changes.push({ environment: env, kind: EnvironmentChangeKind.add });
            }
        }
        return changes.length > 0 ? changes : undefined;
    }

    async getEnvironments(scope: GetEnvironmentsScope): Promise<PythonEnvironment[]> {
        await this.initialize();

        if (scope === 'all') {
            return Array.from(this.collection);
        }
        if (!(scope instanceof Uri)) {
            return [];
        }

        const env = this.fsPathToEnv.get(normalizePath(scope.fsPath));
        return env ? [env] : [];
    }

    async get(scope: GetEnvironmentScope): Promise<PythonEnvironment | undefined> {
        const fastResult = await tryFastPathGet({
            initialized: this._initialized,
            setInitialized: (deferred) => {
                this._initialized = deferred;
            },
            scope,
            label: 'venv',
            getProjectFsPath: (s) => getProjectFsPathForScope(this.api, s),
            getPersistedPath: (fsPath) => getVenvForWorkspace(fsPath),
            resolve: (p) => resolveVenvPythonEnvironmentPath(p, this.nativeFinder, this.api, this, this.baseManager),
            startBackgroundInit: () => this.internalRefresh(undefined, false, VenvManagerStrings.venvInitialize),
        });
        if (fastResult) {
            return fastResult.env;
        }

        await this.initialize();

        if (!scope) {
            // `undefined` for venv scenario return the global environment.
            return this.globalEnv;
        }

        const project = this.api.getPythonProject(scope);
        if (!project) {
            return this.globalEnv;
        }

        let env = this.fsPathToEnv.get(normalizePath(project.uri.fsPath));
        if (!env) {
            env = this.findEnvironmentByPath(project.uri.fsPath);
        }

        return env ?? this.globalEnv;
    }

    async set(scope: SetEnvironmentScope, environment?: PythonEnvironment): Promise<void> {
        if (scope === undefined) {
            const before = this.globalEnv;
            this.globalEnv = environment;
            await setVenvForGlobal(environment?.environmentPath.fsPath);
            await this.resetGlobalEnv();
            if (before?.envId.id !== this.globalEnv?.envId.id) {
                this._onDidChangeEnvironment.fire({ uri: undefined, old: before, new: this.globalEnv });
            }
            return;
        }

        if (scope instanceof Uri) {
            const pw = this.api.getPythonProject(scope);
            if (!pw) {
                return;
            }

            // Notify user if VIRTUAL_ENV is set and they're trying to select a different environment
            if (process.env.VIRTUAL_ENV && environment) {
                const virtualEnvPath = process.env.VIRTUAL_ENV;
                const selectedPath = environment.sysPrefix;
                // Only show notification if they selected a different environment
                if (virtualEnvPath !== selectedPath) {
                    showInformationMessage(VenvManagerStrings.venvVirtualEnvActive);
                }
            }

            const normalizedPwPath = normalizePath(pw.uri.fsPath);
            const before = this.fsPathToEnv.get(normalizedPwPath);
            if (environment) {
                this.fsPathToEnv.set(normalizedPwPath, environment);
            } else {
                this.fsPathToEnv.delete(normalizedPwPath);
            }
            await setVenvForWorkspace(pw.uri.fsPath, environment?.environmentPath.fsPath);

            if (before?.envId.id !== environment?.envId.id) {
                this._onDidChangeEnvironment.fire({ uri: scope, old: before, new: environment });
            }
        }

        if (Array.isArray(scope) && scope.every((u) => u instanceof Uri)) {
            const projects: PythonProject[] = [];
            scope
                .map((s) => this.api.getPythonProject(s))
                .forEach((p) => {
                    if (p) {
                        projects.push(p);
                    }
                });

            const before: Map<string, PythonEnvironment | undefined> = new Map();
            projects.forEach((p) => {
                const normalizedPath = normalizePath(p.uri.fsPath);
                before.set(p.uri.fsPath, this.fsPathToEnv.get(normalizedPath));
                if (environment) {
                    this.fsPathToEnv.set(normalizedPath, environment);
                } else {
                    this.fsPathToEnv.delete(normalizedPath);
                }
            });

            await setVenvForWorkspaces(
                projects.map((p) => p.uri.fsPath),
                environment?.environmentPath.fsPath,
            );

            projects.forEach((p) => {
                const b = before.get(p.uri.fsPath);
                if (b?.envId.id !== environment?.envId.id) {
                    this._onDidChangeEnvironment.fire({ uri: p.uri, old: b, new: environment });
                }
            });
        }
    }

    async resolve(context: ResolveEnvironmentContext): Promise<PythonEnvironment | undefined> {
        if (context instanceof Uri) {
            // NOTE: `environmentPath` for envs in `this.collection` for venv always points to the python
            // executable in the venv. This is set when we create the PythonEnvironment object.
            const found = this.findEnvironmentByPath(context.fsPath);
            if (found) {
                // If it is in the collection, then it is a venv, and it should already be fully resolved.
                return found;
            }
        }

        const resolved = await resolveVenvPythonEnvironmentPath(
            context.fsPath,
            this.nativeFinder,
            this.api,
            this,
            this.baseManager,
        );
        if (resolved) {
            if (resolved.envId.managerId === `${PYTHON_EXTENSION_ID}:venv`) {
                // We should only return the resolved env if it is a venv.
                // Fall through an return undefined if it is not a venv
                return resolved;
            }
        }

        return undefined;
    }

    async clearCache(): Promise<void> {
        await clearVenvCache();
    }

    private addEnvironment(environment: PythonEnvironment, raiseEvent?: boolean): PythonEnvironment | undefined {
        if (this.collection.find((e) => e.envId.id === environment.envId.id)) {
            return undefined;
        }

        const oldEnv = this.findEnvironmentByPath(environment.environmentPath.fsPath);
        if (oldEnv) {
            this.collection = this.collection.filter((e) => e.envId.id !== oldEnv.envId.id);
            this.collection.push(environment);
            if (raiseEvent) {
                this._onDidChangeEnvironments.fire([
                    { environment: oldEnv, kind: EnvironmentChangeKind.remove },
                    { environment, kind: EnvironmentChangeKind.add },
                ]);
            }
        } else {
            this.collection.push(environment);
            if (raiseEvent) {
                this._onDidChangeEnvironments.fire([{ environment, kind: EnvironmentChangeKind.add }]);
            }
        }
        if (raiseEvent) {
            this.collectionMutationGeneration++;
            if (oldEnv) {
                this.directRemovalGenerations.set(
                    normalizePath(oldEnv.environmentPath.fsPath),
                    this.collectionMutationGeneration,
                );
            }
        }
        return environment;
    }

    private async resetGlobalEnv() {
        this.globalEnv = undefined;
        const globals = await this.baseManager.getEnvironments('global');
        const added = await this.loadGlobalEnv(globals);
        if (added) {
            this._onDidChangeEnvironments.fire([{ environment: added, kind: EnvironmentChangeKind.add }]);
            this.collectionMutationGeneration++;
        }
    }

    /**
     * Loads and sets the global Python environment from the provided list, resolving if necessary. O(g) where g = globals.length
     */
    private async loadGlobalEnv(
        globals: PythonEnvironment[],
        inScope?: (fsPath: string) => boolean,
    ): Promise<PythonEnvironment | undefined> {
        this.globalEnv = undefined;

        // Try to find a global environment
        const fsPath = await getVenvForGlobal();

        let added: PythonEnvironment | undefined;
        if (fsPath) {
            this.globalEnv = this.findEnvironmentByPath(fsPath) ?? this.findEnvironmentByPath(fsPath, globals);

            // If the environment is not found, resolve the fsPath. Could be portable conda.
            if (!this.globalEnv) {
                this.globalEnv = await resolveVenvPythonEnvironmentPath(
                    fsPath,
                    this.nativeFinder,
                    this.api,
                    this,
                    this.baseManager,
                );

                // If the environment is resolved, add it to the collection
                if (this.globalEnv && (!inScope || inScope(this.globalEnv.environmentPath.fsPath))) {
                    added = this.addEnvironment(this.globalEnv, false);
                }
            }
        }

        // If a global environment is still not set, use latest from globals
        if (!this.globalEnv) {
            this.globalEnv = getLatest(globals);
        }
        return added;
    }

    /**
     * Loads and maps Python environments to their corresponding project paths in the workspace. about  O(p × e) where p = projects.len and e = environments.len
     */
    private async loadEnvMap(inScope?: (fsPath: string) => boolean): Promise<PythonEnvironment[]> {
        const appended: PythonEnvironment[] = [];
        const globals = await this.baseManager.getEnvironments('global');
        const globalAdded = await this.loadGlobalEnv(globals, inScope);
        if (globalAdded) {
            appended.push(globalAdded);
        }

        this.fsPathToEnv.clear();

        const sorted = sortEnvironments(this.collection);
        const projects = this.api.getPythonProjects();
        const events: (() => void)[] = [];
        // Iterates through all workspace projects
        for (const project of projects) {
            const originalPath = project.uri.fsPath;
            const normalizedPath = normalizePath(originalPath);
            const env = await getVenvForWorkspace(originalPath);
            if (env) {
                // from env path find PythonEnvironment object in the collection.
                let foundEnv = this.findEnvironmentByPath(env, sorted) ?? this.findEnvironmentByPath(env, globals);
                const previousEnv = this.fsPathToEnv.get(normalizedPath);
                if (!foundEnv) {
                    if (inScope && !inScope(env)) {
                        continue;
                    }
                    // attempt to resolve
                    const resolved = await resolveVenvPythonEnvironmentPath(
                        env,
                        this.nativeFinder,
                        this.api,
                        this,
                        this.baseManager,
                    );
                    if (resolved) {
                        // If resolved; add it to the venvManager collection
                        const addedEnv = this.addEnvironment(resolved, false);
                        if (addedEnv) {
                            appended.push(addedEnv);
                        }
                        foundEnv = resolved;
                    } else {
                        this.log.error(`Failed to resolve python environment: ${env}`);
                        return appended;
                    }
                }
                // Given found env, add it to the map and fire the event if needed.
                this.fsPathToEnv.set(normalizedPath, foundEnv);
                if (previousEnv?.envId.id !== foundEnv.envId.id) {
                    events.push(() =>
                        this._onDidChangeEnvironment.fire({ uri: project.uri, old: undefined, new: foundEnv }),
                    );
                }
            } else {
                // Search through all known environments (e) and check if any are associated with the current project path. If so, add that environment and path in the map.
                const found = sorted.find((e) => {
                    const t = this.api.getPythonProject(e.environmentPath)?.uri.fsPath;
                    return t && normalizePath(t) === normalizedPath;
                });
                if (found) {
                    this.fsPathToEnv.set(normalizedPath, found);
                }
            }
        }

        events.forEach((e) => e());
        return appended;
    }

    /**
     * Finds a PythonEnvironment in the given collection (or all environments) that matches the provided file system path. O(e) where e = environments.len
     */
    private findEnvironmentByPath(fsPath: string, collection?: PythonEnvironment[]): PythonEnvironment | undefined {
        const normalized = normalizePath(fsPath);
        const envs = collection ?? this.collection;
        return envs.find((e) => {
            const n = normalizePath(e.environmentPath.fsPath);
            return (
                n === normalized ||
                normalizePath(path.dirname(e.environmentPath.fsPath)) === normalized ||
                normalizePath(path.dirname(path.dirname(e.environmentPath.fsPath))) === normalized
            );
        });
    }

    /**
     * Returns all Python projects associated with the given environment.
     * O(p), where p is project.len
     */
    public getProjectsByEnvironment(environment: PythonEnvironment): PythonProject[] {
        const projects: PythonProject[] = [];
        this.fsPathToEnv.forEach((env, fsPath) => {
            if (env.envId.id === environment.envId.id) {
                const p = this.api.getPythonProject(Uri.file(fsPath));
                if (p) {
                    projects.push(p);
                }
            }
        });
        return projects;
    }
}
