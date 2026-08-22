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
import { normalizePath, isPathInside, toNormalizedPathKey, untildify } from '../../common/utils/pathUtils';
import { showErrorMessage, showInformationMessage, withProgress } from '../../common/window.apis';
import { findParentIfFile } from '../../features/envCommands';
import { PythonEnvironmentImpl } from '../../internal.api';
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
    getVenvFoldersSetting,
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
    private readonly fsPathToEnv: Map<string, PythonEnvironment> = new Map();
    private globalEnv: PythonEnvironment | undefined;
    private skipWatcherRefresh = false;

    // Tail of the refresh queue. Refresh transactions are chained onto this promise so that two
    // concurrent refreshes (for example scoped refreshes of folders A and B) can never interleave
    // their collection/map mutations or compute change events from each other's intermediate state.
    private refreshChain: Promise<unknown> = Promise.resolve();

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
        this.collection = this.collection.filter((e) => normalizePath(e.environmentPath.fsPath) !== envPath);
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
        // Serialize the whole transaction (scope resolution, discovery, collection/map mutation and
        // event computation) so concurrent refreshes cannot interleave or observe each other's
        // partial state.
        return this.enqueueRefresh(() => this.performRefresh(scope, hardRefresh, title, location));
    }

    /**
     * Runs a single refresh transaction. Callers reach this only through {@link enqueueRefresh}, so
     * the collection and workspace maps are mutated by at most one refresh at a time.
     *
     * The effective scope is resolved first: when a workspace project owns the scope Uri (including
     * a file such as `.../app/src/main.py`) the project root wins so discovery and the merge operate
     * on the whole project; only when no project owns the Uri do we fall back to the containing
     * directory (see {@link resolveScopeDirectory}).
     */
    private async performRefresh(
        scope: RefreshEnvironmentsScope,
        hardRefresh: boolean,
        title: string,
        location: ProgressLocation,
    ): Promise<void> {
        const owningProject = scope ? this.api.getPythonProject(scope) : undefined;
        const scopeDir = scope ? (owningProject?.uri ?? (await this.resolveScopeDirectory(scope))) : undefined;

        await withProgress(
            {
                location,
                title,
            },
            async () => {
                const discovered =
                    (await findVirtualEnvironments(
                        hardRefresh,
                        this.nativeFinder,
                        this.api,
                        this.log,
                        this,
                        scopeDir ? [scopeDir] : undefined,
                    )) ?? [];

                if (scopeDir) {
                    await this.applyScopedRefresh(scopeDir, owningProject, discovered);
                } else {
                    await this.applyFullRefresh(discovered);
                }
            },
        );
    }

    /**
     * Chains a refresh operation onto the serialized refresh queue. The operation runs only after
     * the previous refresh settles, whether it resolved or rejected, so a failed refresh does not
     * poison later ones. The caller receives the operation's real result or rejection; the internal
     * tail swallows both so the chain stays usable.
     */
    private enqueueRefresh<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.refreshChain.then(operation, operation);
        this.refreshChain = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    /**
     * Replaces the entire environment collection with the freshly discovered environments.
     *
     * Used for unscoped (full) refreshes where discovery is authoritative for every environment.
     * Fires a single event that removes every previously known environment and adds every
     * discovered one.
     */
    private async applyFullRefresh(discovered: PythonEnvironment[]): Promise<void> {
        const discard = this.collection.map((env) => ({
            kind: EnvironmentChangeKind.remove,
            environment: env,
        }));

        this.collection = discovered;
        await this.loadEnvMap();

        const added = this.collection.map((env) => ({ environment: env, kind: EnvironmentChangeKind.add }));
        this._onDidChangeEnvironments.fire([...discard, ...added]);
    }

    /**
     * Resolves a refresh scope Uri to a directory when no workspace project owns it. If the scope
     * points at a file (allowed by the {@link RefreshEnvironmentsScope} contract) its parent
     * directory is returned. If the path cannot be inspected (for example it no longer exists) the
     * scope is returned unchanged and treated as a directory, preserving best-effort behavior.
     */
    private async resolveScopeDirectory(scope: Uri): Promise<Uri> {
        try {
            return Uri.file(await findParentIfFile(scope.fsPath));
        } catch {
            return scope;
        }
    }

    /**
     * Reconciles the results of a URI-scoped discovery into the existing collection without
     * discarding environments that live outside the refreshed scope.
     *
     * A scoped refresh is authoritative only for the effective scope (the owning project's root, or
     * the scope directory when no project owns it). Three kinds of environment are retained
     * untouched so that, for example, refreshing folder A in a multi-root workspace never removes
     * folder B's or a global environment:
     *  - environments owned by a *different* workspace project (including one nested under the
     *    refreshed folder),
     *  - environments under a configured global `python.venvFolders` root — even when such a root is
     *    nested beneath the refreshed folder or the folder is a filesystem root, and
     *  - everything physically outside the scope directory.
     *
     * Within the effective scope the previous entries are rebuilt from the freshly discovered ones:
     * stale environments are dropped, new ones added, and a rediscovered environment at an existing
     * path keeps its stable {@link PythonEnvironmentId} while adopting the fresh (authoritative)
     * metadata. Because full semantic equality (activation/execInfo included) cannot be proven
     * cheaply, such an in-place refresh is announced as remove(old)+add(new) rather than silently
     * swapping the object with no event. All change events are computed from this scope-local
     * transaction — never by diffing the shared collection after an await — and never reference the
     * retained sibling/global environments. Only the owning project's persisted map entry is
     * reconciled (see {@link reconcileProjectEnvMapEntry}); the global environment and every other
     * project/global map entry are left untouched, and a scope no project owns does not touch the
     * workspace maps at all.
     */
    private async applyScopedRefresh(
        scope: Uri,
        owningProject: PythonProject | undefined,
        discovered: PythonEnvironment[],
    ): Promise<void> {
        const previous = this.collection;
        const scopeKey = toNormalizedPathKey(scope.fsPath);

        // Configured global venv roots, read via the same `python.venvFolders` setting the native
        // finder adds to its search paths. The roots are tilde-expanded (users commonly write
        // `~/.virtualenvs`) so containment matches the absolute environment paths PET returns;
        // without this a `~`-rooted global env nested under the scope would be wrongly removed.
        // Non-absolute entries (empty/relative misconfiguration — the setting is documented as
        // absolute or `~`) are dropped so they cannot resolve against the ext-host CWD and produce
        // surprising containment.
        const globalVenvRoots = getVenvFoldersSetting()
            .map(untildify)
            .filter((root) => path.isAbsolute(root));
        const underGlobalVenvRoot = (envFsPath: string): boolean =>
            globalVenvRoots.some((root) => isPathInside(root, envFsPath));

        // An environment is authoritative for this scope only when it is inside the effective scope,
        // not under a configured global venv root, and (if a project owns it) owned by exactly this
        // scope's project rather than a different (possibly nested) one.
        const isInScope = (env: PythonEnvironment): boolean => {
            const envFsPath = env.environmentPath.fsPath;
            if (!isPathInside(scope.fsPath, envFsPath)) {
                return false;
            }
            if (underGlobalVenvRoot(envFsPath)) {
                return false;
            }
            const owner = this.api.getPythonProject(env.environmentPath);
            return owner === undefined || toNormalizedPathKey(owner.uri.fsPath) === scopeKey;
        };

        // Partition the previous collection into retained (out-of-scope) and in-scope-by-path.
        const retained: PythonEnvironment[] = [];
        const previousInScope = new Map<string, PythonEnvironment>();
        for (const env of previous) {
            if (isInScope(env)) {
                previousInScope.set(toNormalizedPathKey(env.environmentPath.fsPath), env);
            } else {
                retained.push(env);
            }
        }

        // Authoritative in-scope discovery results, deduplicated by absolute normalized path.
        const discoveredInScope = new Map<string, PythonEnvironment>();
        for (const env of discovered) {
            if (isInScope(env)) {
                discoveredInScope.set(toNormalizedPathKey(env.environmentPath.fsPath), env);
            }
        }

        // Build the rebuilt in-scope set and the scope-local change events in a single pass,
        // preserving the stable id of a rediscovered same-path environment.
        const changes: DidChangeEnvironmentsEventArgs = [];
        const rebuiltInScope: PythonEnvironment[] = [];
        for (const [key, discoveredEnv] of discoveredInScope) {
            const prior = previousInScope.get(key);
            if (prior) {
                // Same path rediscovered: adopt the fresh authoritative metadata but keep the prior
                // stable envId, and announce the refresh as remove(old)+add(new).
                const preserved = new PythonEnvironmentImpl(prior.envId, discoveredEnv);
                rebuiltInScope.push(preserved);
                changes.push({ environment: prior, kind: EnvironmentChangeKind.remove });
                changes.push({ environment: preserved, kind: EnvironmentChangeKind.add });
            } else {
                rebuiltInScope.push(discoveredEnv);
                changes.push({ environment: discoveredEnv, kind: EnvironmentChangeKind.add });
            }
        }
        for (const [key, prior] of previousInScope) {
            if (!discoveredInScope.has(key)) {
                changes.push({ environment: prior, kind: EnvironmentChangeKind.remove });
            }
        }

        // Commit the new collection: retained out-of-scope environments plus the rebuilt in-scope
        // ones. This is the only mutation of the shared collection in this transaction.
        this.collection = [...retained, ...rebuiltInScope];

        // If the cached default interpreter is one of the environments just rebuilt in this scope
        // (same stable id, fresh metadata), re-point at the refreshed object so get(undefined) does
        // not return stale metadata. This does not resolve or rebuild global discovery, touches no
        // other map entry, and fires no additional event (the in-scope rebuild already announced it).
        // A cached default that was in-scope and *removed* (deleted on disk, not rediscovered) is
        // deliberately left as-is rather than re-resolved here: a scoped refresh must not rebuild
        // global state, so it self-heals on the next full/unscoped refresh.
        if (this.globalEnv) {
            const refreshedGlobal = rebuiltInScope.find((env) => env.envId.id === this.globalEnv!.envId.id);
            if (refreshedGlobal) {
                this.globalEnv = refreshedGlobal;
            }
        }

        // Reconcile only the owning project's persisted map entry (never a global loadEnvMap
        // rebuild). A scope no project owns leaves the workspace maps untouched. A *different*
        // project that had explicitly selected an in-scope env keeps its own map entry pointing at
        // the pre-refresh object (same id/path, older metadata) until the next full refresh; that
        // entry is outside this scope's authority, so it is intentionally not re-pointed here.
        let mappingChange: DidChangeEnvironmentEventArgs | undefined;
        if (owningProject) {
            const reconciled = await this.reconcileProjectEnvMapEntry(owningProject);
            changes.push(...reconciled.additions);
            mappingChange = reconciled.mappingChange;
        }

        if (changes.length > 0) {
            this._onDidChangeEnvironments.fire(changes);
        }
        if (mappingChange) {
            this._onDidChangeEnvironment.fire(mappingChange);
        }
    }

    /**
     * Reconciles the persisted environment mapping for a single project after a scoped refresh.
     *
     * Unlike {@link loadEnvMap} this never clears or rebuilds the global environment or any other
     * project's mapping, and it resolves only this project's own persisted environment. A
     * pre-mutation snapshot of the project's current mapping is taken so that a change event is
     * emitted only when *this* project's selected environment genuinely changes.
     *
     * @returns Any environment that had to be resolved and added to the collection to satisfy the
     * project's persisted selection (announced as an add so callers include it in the scope-local
     * change event), together with an optional mapping-change event for the project.
     */
    private async reconcileProjectEnvMapEntry(project: PythonProject): Promise<{
        additions: DidChangeEnvironmentsEventArgs;
        mappingChange: DidChangeEnvironmentEventArgs | undefined;
    }> {
        // The shared fsPathToEnv map is keyed with normalizePath by every other reader/writer
        // (getEnvironments, get, set, loadEnvMap); use the same key here so a scoped refresh cannot
        // write a second, unreadable entry for the same project. Ownership/containment comparisons
        // use the absolute normalized key (toNormalizedPathKey); the two are equal for canonical
        // absolute project URIs.
        const mapKey = normalizePath(project.uri.fsPath);
        const ownerKey = toNormalizedPathKey(project.uri.fsPath);
        const before = this.fsPathToEnv.get(mapKey);
        const additions: DidChangeEnvironmentsEventArgs = [];

        const persistedFsPath = await getVenvForWorkspace(project.uri.fsPath);
        let mapped: PythonEnvironment | undefined;
        if (persistedFsPath) {
            mapped = this.findEnvironmentByPath(persistedFsPath);
            if (!mapped) {
                // The selected environment is not in the collection (for example a portable or
                // global interpreter). Resolve only this target's selection and add it.
                const resolved = await resolveVenvPythonEnvironmentPath(
                    persistedFsPath,
                    this.nativeFinder,
                    this.api,
                    this,
                    this.baseManager,
                );
                if (resolved) {
                    this.addEnvironment(resolved, false);
                    mapped = resolved;
                    additions.push({ environment: resolved, kind: EnvironmentChangeKind.add });
                } else {
                    this.log.error(`Failed to resolve python environment: ${persistedFsPath}`);
                }
            }
        } else {
            // No persisted selection: keep the map consistent with the rebuilt collection by
            // pointing at an environment this project owns, if any. Match loadEnvMap's ordering
            // (a sorted copy) so a scoped and a full refresh auto-select the same interpreter and
            // do not fire a spurious mapping change. sortEnvironments mutates in place, so copy.
            mapped = sortEnvironments(this.collection.slice()).find((env) => {
                const owner = this.api.getPythonProject(env.environmentPath);
                return owner !== undefined && toNormalizedPathKey(owner.uri.fsPath) === ownerKey;
            });
        }

        if (mapped) {
            this.fsPathToEnv.set(mapKey, mapped);
        } else {
            this.fsPathToEnv.delete(mapKey);
        }

        const mappingChange =
            before?.envId.id !== mapped?.envId.id
                ? { uri: project.uri, old: before, new: mapped }
                : undefined;
        return { additions, mappingChange };
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

    private addEnvironment(environment: PythonEnvironment, raiseEvent?: boolean): void {
        if (this.collection.find((e) => e.envId.id === environment.envId.id)) {
            return;
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
    }

    private async resetGlobalEnv() {
        this.globalEnv = undefined;
        const globals = await this.baseManager.getEnvironments('global');
        await this.loadGlobalEnv(globals);
    }

    /**
     * Loads and sets the global Python environment from the provided list, resolving if necessary. O(g) where g = globals.length
     */
    private async loadGlobalEnv(globals: PythonEnvironment[]) {
        this.globalEnv = undefined;

        // Try to find a global environment
        const fsPath = await getVenvForGlobal();

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
                if (this.globalEnv) {
                    this.addEnvironment(this.globalEnv, false);
                }
            }
        }

        // If a global environment is still not set, use latest from globals
        if (!this.globalEnv) {
            this.globalEnv = getLatest(globals);
        }
    }

    /**
     * Loads and maps Python environments to their corresponding project paths in the workspace. about  O(p × e) where p = projects.len and e = environments.len
     */
    private async loadEnvMap() {
        const globals = await this.baseManager.getEnvironments('global');
        await this.loadGlobalEnv(globals);

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
                        this.addEnvironment(resolved, false);
                        foundEnv = resolved;
                    } else {
                        this.log.error(`Failed to resolve python environment: ${env}`);
                        return;
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
