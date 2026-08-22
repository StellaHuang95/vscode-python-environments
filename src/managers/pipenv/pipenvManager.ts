import { Disposable, EventEmitter, MarkdownString, ProgressLocation, Uri, workspace } from 'vscode';
import {
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
    RefreshEnvironmentsScope,
    ResolveEnvironmentContext,
    SetEnvironmentScope,
} from '../../api';
import { PipenvStrings } from '../../common/localize';
import { traceError, traceInfo } from '../../common/logging';
import { StopWatch } from '../../common/stopWatch';
import { EventNames } from '../../common/telemetry/constants';
import { classifyError } from '../../common/telemetry/errorClassifier';
import { sendTelemetryEvent } from '../../common/telemetry/sender';
import { createDeferred, Deferred } from '../../common/utils/deferred';
import { normalizePath } from '../../common/utils/pathUtils';
import { withProgress } from '../../common/window.apis';
import { PythonProjectManager } from '../../internal.api';
import { getProjectFsPathForScope, tryFastPathGet } from '../common/fastPath';
import { NativePythonFinder } from '../common/nativePythonFinder';
import { notifyMissingManagerIfDefault } from '../common/utils';
import {
    clearPipenvCache,
    getPipenv,
    getPipenvForGlobal,
    getPipenvForWorkspace,
    refreshPipenv,
    resolvePipenvPath,
    setPipenvForGlobal,
    setPipenvForWorkspace,
    setPipenvForWorkspaces,
} from './pipenvUtils';

export class PipenvManager implements EnvironmentManager, Disposable {
    private collection: PythonEnvironment[] = [];
    private fsPathToEnv: Map<string, PythonEnvironment> = new Map();
    private globalEnv: PythonEnvironment | undefined;

    private readonly _onDidChangeEnvironment = new EventEmitter<DidChangeEnvironmentEventArgs>();
    public readonly onDidChangeEnvironment = this._onDidChangeEnvironment.event;

    private readonly _onDidChangeEnvironments = new EventEmitter<DidChangeEnvironmentsEventArgs>();
    public readonly onDidChangeEnvironments = this._onDidChangeEnvironments.event;

    public readonly name: string;
    public readonly displayName: string;
    public readonly preferredPackageManagerId: string;
    public readonly description?: string;
    public readonly tooltip: string | MarkdownString;
    public readonly iconPath?: IconPath;

    private _initialized: Deferred<void> | undefined;

    constructor(
        public readonly nativeFinder: NativePythonFinder,
        public readonly api: PythonEnvironmentApi,
        private readonly projectManager?: PythonProjectManager,
    ) {
        this.name = 'pipenv';
        this.displayName = 'Pipenv';
        this.preferredPackageManagerId = 'ms-python.python:pip';
        this.tooltip = new MarkdownString(PipenvStrings.pipenvManager, true);
    }

    public dispose() {
        this.collection = [];
        this.fsPathToEnv.clear();
        this._onDidChangeEnvironment.dispose();
        this._onDidChangeEnvironments.dispose();
    }

    async initialize(): Promise<void> {
        if (this._initialized) {
            return this._initialized.promise;
        }
        const initialized = createDeferred<void>();
        this._initialized = initialized;
        const stopWatch = new StopWatch();
        let result: 'success' | 'tool_not_found' | 'error' = 'success';
        let envCount = 0;
        let toolSource = 'none';
        let errorType: string | undefined;

        try {
            // Check if tool is findable before PET refresh (settings/cache/PATH only, no PET)
            const hasExplicitSetting = !!workspace.getConfiguration('python').get<string>('pipenvPath');
            const preRefreshTool = await getPipenv();
            if (preRefreshTool) {
                toolSource = hasExplicitSetting ? 'settings' : 'local';
            }

            let committed = false;
            await withProgress(
                {
                    location: ProgressLocation.Window,
                    title: PipenvStrings.pipenvDiscovering,
                },
                async () => {
                    committed = await this.discoverAndCommit(initialized);
                },
            );

            // A superseded run (a concurrent clearCache()+reinit took over while we were
            // discovering) committed nothing and no longer owns the current state, so skip the
            // post-discovery bookkeeping: don't re-run tool lookup or emit a duplicate
            // missing-manager notification for a collection it did not write.
            if (committed) {
                envCount = this.collection.length;

                // If tool wasn't found via local lookup, check if refresh discovered it via PET
                if (!preRefreshTool) {
                    const postRefreshTool = await getPipenv();
                    toolSource = postRefreshTool ? 'pet' : 'none';
                }

                if (toolSource === 'none') {
                    result = 'tool_not_found';
                    if (this.projectManager) {
                        await notifyMissingManagerIfDefault('ms-python.python:pipenv', this.projectManager, this.api);
                    }
                }
            }
        } catch (ex) {
            result = 'error';
            errorType = classifyError(ex);
            traceError('Pipenv lazy initialization failed', ex);
            // Discovery threw: clear the guard so a later call can retry initialization, but only
            // if this run still owns it (don't clobber a deferred a concurrent reset installed).
            if (this._initialized === initialized) {
                this._initialized = undefined;
            }
        } finally {
            // Settle the captured deferred first so a telemetry failure can neither deadlock
            // concurrent waiters nor turn this swallow-style initialize() into a throwing one.
            initialized.resolve();
            try {
                sendTelemetryEvent(EventNames.MANAGER_LAZY_INIT, stopWatch.elapsedTime, {
                    managerName: 'pipenv',
                    result,
                    envCount,
                    toolSource,
                    errorType,
                });
            } catch (telemetryEx) {
                traceError('Failed to send pipenv manager initialization telemetry', telemetryEx);
            }
        }
    }

    /**
     * Runs pipenv discovery and commits the resulting collection, project→env map and global
     * environment atomically — but only if `owner` still owns initialization when discovery
     * finishes.
     *
     * The new state is built entirely into locals first, so:
     *  - a mid-flight throw (from discovery or the map build) can never leave partially written
     *    collection/map/global state behind — the pre-run known-good state is left untouched;
     *  - a superseded run (a concurrent clearCache()+init, or a newer fast-path run, replaced our
     *    deferred while we were awaiting) discards its now-stale results instead of clobbering the
     *    newer state.
     *
     * The commit itself is synchronous (no awaits between the ownership check and the final write),
     * so it is atomic with respect to other callers.
     *
     * @param owner The deferred the caller installed as `this._initialized` for this run.
     * @returns `true` if this run committed its state, `false` if it was superseded and discarded
     *          its results (so the caller can skip post-discovery bookkeeping it no longer owns).
     */
    private async discoverAndCommit(owner: Deferred<void>): Promise<boolean> {
        const collection = (await refreshPipenv(false, this.nativeFinder, this.api, this)) ?? [];
        const { fsPathToEnv, globalEnv } = await this.buildEnvMap(collection);

        // Ownership check: bail before touching shared state if a newer run has taken over.
        if (this._initialized !== owner) {
            return false;
        }

        this.collection = collection;
        this.fsPathToEnv.clear();
        for (const [projectPath, env] of fsPathToEnv) {
            this.fsPathToEnv.set(projectPath, env);
        }
        this.globalEnv = globalEnv;

        this._onDidChangeEnvironments.fire(
            collection.map((e) => ({ environment: e, kind: EnvironmentChangeKind.add })),
        );
        return true;
    }

    /**
     * Builds the project→environment map and global environment for the given collection WITHOUT
     * mutating any shared manager state. Callers commit the returned result atomically so a failed
     * or superseded run can never leave partially written mappings behind. Each entry is resolved
     * by normalized identity against the collection being committed, so mappings never point into
     * a stale collection.
     */
    private async buildEnvMap(
        collection: PythonEnvironment[],
    ): Promise<{ fsPathToEnv: Map<string, PythonEnvironment>; globalEnv: PythonEnvironment | undefined }> {
        const fsPathToEnv = new Map<string, PythonEnvironment>();

        // Load environment mappings for projects
        const projects = this.api.getPythonProjects();
        for (const project of projects) {
            const envPath = await getPipenvForWorkspace(project.uri.fsPath);
            if (envPath) {
                const env = this.findEnvironmentByPathIn(collection, envPath);
                if (env) {
                    fsPathToEnv.set(normalizePath(project.uri.fsPath), env);
                }
            }
        }

        // Load global environment
        let globalEnv: PythonEnvironment | undefined;
        const globalEnvPath = await getPipenvForGlobal();
        if (globalEnvPath) {
            globalEnv = this.findEnvironmentByPathIn(collection, globalEnvPath);
        }

        return { fsPathToEnv, globalEnv };
    }

    private async loadEnvMap() {
        // Load environment mappings for projects
        const projects = this.api.getPythonProjects();
        for (const project of projects) {
            const envPath = await getPipenvForWorkspace(project.uri.fsPath);
            if (envPath) {
                const env = this.findEnvironmentByPath(envPath);
                if (env) {
                    this.fsPathToEnv.set(normalizePath(project.uri.fsPath), env);
                }
            }
        }

        // Load global environment
        const globalEnvPath = await getPipenvForGlobal();
        if (globalEnvPath) {
            this.globalEnv = this.findEnvironmentByPath(globalEnvPath);
        }
    }

    private findEnvironmentByPath(fsPath: string): PythonEnvironment | undefined {
        return this.findEnvironmentByPathIn(this.collection, fsPath);
    }

    private findEnvironmentByPathIn(
        collection: PythonEnvironment[],
        fsPath: string,
    ): PythonEnvironment | undefined {
        const normalized = normalizePath(fsPath);
        return collection.find(
            (env) =>
                normalizePath(env.environmentPath.fsPath) === normalized ||
                (env.execInfo?.run.executable && normalizePath(env.execInfo.run.executable) === normalized),
        );
    }

    async refresh(scope: RefreshEnvironmentsScope): Promise<void> {
        const hardRefresh = scope === undefined; // hard refresh when scope is undefined

        await withProgress(
            {
                location: ProgressLocation.Window,
                title: PipenvStrings.pipenvRefreshing,
            },
            async () => {
                traceInfo('Refreshing Pipenv Environments');
                const oldCollection = [...this.collection];
                this.collection = (await refreshPipenv(hardRefresh, this.nativeFinder, this.api, this)) ?? [];
                await this.loadEnvMap();

                // Fire change events for environments that were added or removed
                const changes: { environment: PythonEnvironment; kind: EnvironmentChangeKind }[] = [];

                // Find removed environments
                oldCollection.forEach((oldEnv) => {
                    if (!this.collection.find((newEnv) => newEnv.envId.id === oldEnv.envId.id)) {
                        changes.push({ environment: oldEnv, kind: EnvironmentChangeKind.remove });
                    }
                });

                // Find added environments
                this.collection.forEach((newEnv) => {
                    if (!oldCollection.find((oldEnv) => oldEnv.envId.id === newEnv.envId.id)) {
                        changes.push({ environment: newEnv, kind: EnvironmentChangeKind.add });
                    }
                });

                if (changes.length > 0) {
                    this._onDidChangeEnvironments.fire(changes);
                }
            },
        );
    }

    async getEnvironments(scope: GetEnvironmentsScope): Promise<PythonEnvironment[]> {
        await this.initialize();

        if (scope === 'all') {
            return Array.from(this.collection);
        }

        if (scope === 'global') {
            // Return all environments for global scope
            return Array.from(this.collection);
        }

        if (scope instanceof Uri) {
            const project = this.api.getPythonProject(scope);
            if (project) {
                const env = this.fsPathToEnv.get(normalizePath(project.uri.fsPath));
                return env ? [env] : [];
            }
        }

        return [];
    }

    async set(scope: SetEnvironmentScope, environment?: PythonEnvironment): Promise<void> {
        if (scope === undefined) {
            // Global scope
            const before = this.globalEnv;
            this.globalEnv = environment;
            await setPipenvForGlobal(environment?.environmentPath.fsPath);

            if (before?.envId.id !== this.globalEnv?.envId.id) {
                this._onDidChangeEnvironment.fire({ uri: undefined, old: before, new: this.globalEnv });
            }
            return;
        }

        if (scope instanceof Uri) {
            // Single project scope
            const project = this.api.getPythonProject(scope);
            if (!project) {
                return;
            }

            const normalizedPath = normalizePath(project.uri.fsPath);
            const before = this.fsPathToEnv.get(normalizedPath);
            if (environment) {
                this.fsPathToEnv.set(normalizedPath, environment);
            } else {
                this.fsPathToEnv.delete(normalizedPath);
            }

            await setPipenvForWorkspace(project.uri.fsPath, environment?.environmentPath.fsPath);

            if (before?.envId.id !== environment?.envId.id) {
                this._onDidChangeEnvironment.fire({ uri: scope, old: before, new: environment });
            }
        }

        if (Array.isArray(scope) && scope.every((u) => u instanceof Uri)) {
            // Multiple projects scope
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

            await setPipenvForWorkspaces(
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

    async get(scope: GetEnvironmentScope): Promise<PythonEnvironment | undefined> {
        const fastResult = await tryFastPathGet({
            initialized: this._initialized,
            setInitialized: (deferred) => {
                this._initialized = deferred;
            },
            getInitialized: () => this._initialized,
            scope,
            label: 'pipenv',
            getProjectFsPath: (s) => getProjectFsPathForScope(this.api, s),
            getPersistedPath: (fsPath) => getPipenvForWorkspace(fsPath),
            resolve: (p) => resolvePipenvPath(p, this.nativeFinder, this.api, this),
            startBackgroundInit: () => {
                // Capture the deferred fastPath just installed so the commit stays ownership-aware
                // (discoverAndCommit only writes shared state if this deferred still owns init).
                const owner = this._initialized;
                return withProgress(
                    { location: ProgressLocation.Window, title: PipenvStrings.pipenvDiscovering },
                    async () => {
                        if (owner) {
                            await this.discoverAndCommit(owner);
                        }
                    },
                );
            },
        });
        if (fastResult) {
            return fastResult.env;
        }

        await this.initialize();

        if (scope === undefined) {
            return this.globalEnv;
        }

        if (scope instanceof Uri) {
            const project = this.api.getPythonProject(scope);
            if (project) {
                return this.fsPathToEnv.get(normalizePath(project.uri.fsPath));
            }
        }

        return undefined;
    }

    async resolve(context: ResolveEnvironmentContext): Promise<PythonEnvironment | undefined> {
        await this.initialize();
        return resolvePipenvPath(context.fsPath, this.nativeFinder, this.api, this);
    }

    async clearCache?(): Promise<void> {
        await clearPipenvCache();
        this.collection = [];
        this.fsPathToEnv.clear();
        this.globalEnv = undefined;
        this._initialized = undefined;
    }
}
