import { ProgressLocation, QuickInputButtons, QuickPickItem, QuickPickItemKind, ThemeIcon, Uri, l10n } from 'vscode';
import { CreateEnvironmentOptions, IconPath, PythonEnvironment, PythonProject } from '../../api';
import { InternalEnvironmentManager } from '../../internal.api';
import { Common, Interpreter, Pickers } from '../localize';
import { traceError } from '../logging';
import { EventNames } from '../telemetry/constants';
import { sendTelemetryEvent } from '../telemetry/sender';
import { isWindows } from '../utils/platformUtils';
import { normalizePath } from '../utils/pathUtils';
import { handlePythonPath } from '../utils/pythonPath';
import {
    QuickPickController,
    showErrorMessage,
    showOpenDialog,
    showQuickPick,
    showQuickPickWithButtons,
    withProgress,
} from '../window.apis';
import { pickEnvironmentManager } from './managers';

type QuickPickIcon =
    | Uri
    | {
          light: Uri;
          dark: Uri;
      }
    | ThemeIcon
    | undefined;

function getIconPath(i: IconPath | undefined): QuickPickIcon {
    if (i === undefined || i instanceof ThemeIcon || i instanceof Uri) {
        return i;
    }

    if (typeof i === 'string') {
        return Uri.file(i);
    }

    return {
        light: i.light instanceof Uri ? i.light : Uri.file(i.light),
        dark: i.dark instanceof Uri ? i.dark : Uri.file(i.dark),
    };
}

interface EnvironmentPickOptions {
    showBackButton?: boolean;
    projects: PythonProject[];
    /**
     * Optional async resolver for the recommended environment, run **after** the picker is shown so a
     * slow default-manager `get()` never delays the picker from opening. It is the sole, authoritative
     * source for the recommended item: the picker opens immediately with only Browse/Create and the
     * streaming manager sections, and the recommended slot appears (deduplicated against the sections)
     * once this resolves. A rejected or `undefined` result simply leaves no recommendation shown, and a
     * delegating manager (e.g. Venv resolving to a System environment) is fully supported.
     */
    resolveRecommended?: () => Promise<PythonEnvironment | undefined>;
}
async function browseForPython(
    managers: InternalEnvironmentManager[],
    projectEnvManagers: InternalEnvironmentManager[],
): Promise<PythonEnvironment | undefined> {
    const filters = isWindows() ? { python: ['exe'] } : undefined;
    const uris = await showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters,
        title: Pickers.Environments.selectExecutable,
    });
    if (!uris || uris.length === 0) {
        return;
    }
    const uri = uris[0];

    const environment = await withProgress(
        {
            location: ProgressLocation.Notification,
            cancellable: false,
        },
        async (reporter, token) => {
            const env = await handlePythonPath(uri, managers, projectEnvManagers, reporter, token);
            return env;
        },
    );

    if (!environment) {
        showErrorMessage(l10n.t('Selected file is not a valid Python interpreter: {0}', uri.fsPath));
    }

    return environment;
}

async function createEnvironment(
    managers: InternalEnvironmentManager[],
    projectEnvManagers: InternalEnvironmentManager[],
    options: EnvironmentPickOptions,
): Promise<PythonEnvironment | undefined> {
    const managerId = await pickEnvironmentManager(
        managers.filter((m) => m.supportsCreate),
        projectEnvManagers.filter((m) => m.supportsCreate),
    );

    let manager: InternalEnvironmentManager | undefined;
    let createOptions: CreateEnvironmentOptions | undefined = undefined;
    if (managerId?.includes(`QuickCreate#`)) {
        manager = managers.find((m) => m.id === managerId.split('#')[1]);
        createOptions = {
            projects: projectEnvManagers.map((m) => m),
            quickCreate: true,
        } as CreateEnvironmentOptions;
    } else {
        manager = managers.find((m) => m.id === managerId);
    }

    if (manager) {
        try {
            // add telemetry here
            const env = await manager.create(
                options.projects.map((p) => p.uri),
                createOptions,
            );
            return env;
        } catch (ex) {
            if (ex === QuickInputButtons.Back) {
                return createEnvironment(managers, projectEnvManagers, options);
            }
            traceError(`Failed to create environment using ${manager.id}`, ex);
            throw ex;
        }
    }
}

/**
 * A picker item backed by a concrete environment. `manager` is undefined for the recommended slot,
 * which is not owned by any manager section.
 */
interface PickEnvItem extends QuickPickItem {
    result: PythonEnvironment;
    manager?: InternalEnvironmentManager;
}

type EnvironmentPickItem = QuickPickItem | PickEnvItem;

/**
 * A manager's loaded environments (locally deduplicated), stored as raw environments so the canonical
 * item objects can be (re)computed deterministically at build time in fixed manager order.
 */
interface ManagerSection {
    readonly separator: QuickPickItem;
    readonly envs: ReadonlyArray<{ readonly key: string; readonly env: PythonEnvironment }>;
}

/**
 * Computes a stable, cross-manager identity for an environment so the same interpreter discovered by
 * more than one manager is only shown once.
 *
 * Prefers the environment/prefix path first: distinct Python-less environments (e.g. bare Conda
 * prefixes) can share a single launcher executable, so keying on the executable would incorrectly
 * collapse them into one. Falls back to the resolved executable, then the manager-scoped id. Paths
 * are normalized for cross-platform comparison.
 */
function environmentIdentityKey(e: PythonEnvironment): string {
    const envPath = e.environmentPath?.fsPath;
    if (envPath && envPath.trim().length > 0) {
        return normalizePath(envPath);
    }
    const execPath = e.execInfo?.run?.executable;
    if (execPath && execPath.trim().length > 0) {
        return normalizePath(execPath);
    }
    return `${e.envId.managerId}:${e.envId.id}`;
}

function describeEnvironment(e: PythonEnvironment): string {
    const pathDescription = e.displayPath;
    return e.description && e.description.trim() ? `${e.description} (${pathDescription})` : pathDescription;
}

/**
 * Writes an environment's presentation onto a picker item **in place**. Mutating a single canonical
 * object (rather than allocating a new one) is what lets the QuickPick preserve the user's active and
 * selected item by reference when an environment's owning manager changes as sections stream in.
 */
function applyEnvironmentToItem(
    item: PickEnvItem,
    e: PythonEnvironment,
    manager?: InternalEnvironmentManager,
): void {
    item.label = e.displayName ?? e.name;
    item.description = describeEnvironment(e);
    item.result = e;
    item.manager = manager;
    item.iconPath = getIconPath(e.iconPath);
}

async function pickEnvironmentImpl(
    items: EnvironmentPickItem[],
    managers: InternalEnvironmentManager[],
    projectEnvManagers: InternalEnvironmentManager[],
    options: EnvironmentPickOptions,
    onDidShow?: (controller: QuickPickController<EnvironmentPickItem>) => void,
): Promise<PythonEnvironment | undefined> {
    const selected = await showQuickPickWithButtons(items, {
        placeHolder: Pickers.Environments.selectEnvironment,
        ignoreFocusOut: true,
        showBackButton: options?.showBackButton,
        onDidShow,
    });

    if (selected && !Array.isArray(selected)) {
        if (selected.label === Interpreter.browsePath) {
            return browseForPython(managers, projectEnvManagers);
        } else if (selected.label === Interpreter.createVirtualEnvironment) {
            sendTelemetryEvent(EventNames.CREATE_ENVIRONMENT, undefined, {
                manager: 'none',
                triggeredLocation: 'pickEnv',
            });
            return createEnvironment(managers, projectEnvManagers, options);
        }
        return (selected as { result: PythonEnvironment })?.result;
    }
    return undefined;
}

export async function pickEnvironment(
    managers: InternalEnvironmentManager[],
    projectEnvManagers: InternalEnvironmentManager[],
    options: EnvironmentPickOptions,
): Promise<PythonEnvironment | undefined> {
    const staticItems: EnvironmentPickItem[] = [
        {
            label: Interpreter.browsePath,
            iconPath: new ThemeIcon('folder'),
        },
        {
            label: '',
            kind: QuickPickItemKind.Separator,
        },
        {
            label: Interpreter.createVirtualEnvironment,
            iconPath: new ThemeIcon('add'),
        },
    ];

    // The recommendation is resolved asynchronously by options.resolveRecommended after the picker is
    // shown (see onDidShow); nothing is seeded synchronously, so a slow, rejected, or delegating
    // default-manager get() never delays opening nor forces a stale/ownership-ambiguous guess up front.
    let recommendedEnv: PythonEnvironment | undefined;
    const recommendedSeparator: QuickPickItem = { label: Common.recommended, kind: QuickPickItemKind.Separator };

    // One canonical item object per environment identity, reused across rebuilds. When an
    // environment's owning manager changes (a higher-priority manager resolves later) or it moves
    // between a manager section and the recommended slot, the same object is moved/updated instead
    // of replaced, so the QuickPick keeps the user's active and selected item by reference.
    const canonicalItems = new Map<string, PickEnvItem>();

    const canonicalItem = (key: string, env: PythonEnvironment): PickEnvItem => {
        let item = canonicalItems.get(key);
        if (!item) {
            item = { label: '', result: env };
            canonicalItems.set(key, item);
        }
        return item;
    };

    // Sections are stored per manager and rebuilt into the final list in fixed manager order,
    // independent of the order in which managers finish loading, so section ordering stays
    // deterministic while environments stream in.
    const sections = new Map<string, ManagerSection>();

    const buildItems = (): EnvironmentPickItem[] => {
        const result: EnvironmentPickItem[] = [...staticItems];
        const seen = new Set<string>();

        if (recommendedEnv) {
            // The recommended environment is shown at the top; skip it in the manager sections.
            // Reuse the one canonical object for this identity so an environment that also appears
            // in a manager section keeps the user's active/selected item by reference as it moves
            // in or out of the recommended slot.
            const key = environmentIdentityKey(recommendedEnv);
            seen.add(key);
            const item = canonicalItem(key, recommendedEnv);
            applyEnvironmentToItem(item, recommendedEnv);
            result.push(recommendedSeparator, item);
        }

        for (const manager of managers) {
            const section = sections.get(manager.id);
            if (!section) {
                continue;
            }
            const visible: PickEnvItem[] = [];
            for (const { key, env } of section.envs) {
                if (seen.has(key)) {
                    continue;
                }
                seen.add(key);
                const item = canonicalItem(key, env);
                applyEnvironmentToItem(item, env, manager);
                visible.push(item);
            }
            if (visible.length > 0) {
                result.push(section.separator, ...visible);
            }
        }
        return result;
    };

    const loadManager = async (
        manager: InternalEnvironmentManager,
        controller: QuickPickController<EnvironmentPickItem>,
    ): Promise<void> => {
        let section: ManagerSection | undefined;
        try {
            const envs = await manager.getEnvironments('all');
            const deduped: { key: string; env: PythonEnvironment }[] = [];
            const localKeys = new Set<string>();
            for (const env of envs) {
                const key = environmentIdentityKey(env);
                if (localKeys.has(key)) {
                    continue;
                }
                localKeys.add(key);
                deduped.push({ key, env });
            }
            section = {
                separator: {
                    label: manager.displayName,
                    kind: QuickPickItemKind.Separator,
                },
                envs: deduped,
            };
        } catch (err) {
            traceError(
                `[pickEnvironment] Failed to load environments for manager "${manager.id}"; section skipped.`,
                err,
            );
        }
        // Once the picker has settled (accepted/back/cancelled/disposed) never touch shared section or
        // canonical-item state: buildItems() rewrites canonical item objects in place, which would
        // otherwise change the result of an already-accepted item. The synchronous work below is safe
        // because nothing awaits between this guard and setItems().
        if (controller.settled) {
            return;
        }
        if (section) {
            sections.set(manager.id, section);
        }
        controller.setItems(buildItems());
    };

    const loadRecommendation = async (controller: QuickPickController<EnvironmentPickItem>): Promise<void> => {
        if (!options?.resolveRecommended) {
            return;
        }
        let resolved: PythonEnvironment | undefined;
        try {
            // The resolver is the sole, authoritative source for the recommendation, matching the
            // pre-streaming behavior where the awaited manager.get() was the only source. It runs after
            // show so a slow get() never blocks opening; a rejected/undefined result leaves no
            // recommendation. A delegating manager (e.g. Venv resolving to a System env) is fully
            // supported: whatever env it returns becomes the recommendation, deduped against the
            // sections by identity.
            resolved = await options.resolveRecommended();
        } catch (err) {
            traceError('[pickEnvironment] Failed to resolve the recommended environment.', err);
        }
        // See loadManager: never mutate canonical/section state or rebuild after the picker has settled.
        if (controller.settled) {
            return;
        }
        recommendedEnv = resolved;
        controller.setItems(buildItems());
    };

    const onDidShow = (controller: QuickPickController<EnvironmentPickItem>) => {
        controller.setBusy(true);
        const loads: Promise<void>[] = [
            ...managers.map((manager) => loadManager(manager, controller)),
            loadRecommendation(controller),
        ];
        void Promise.allSettled(loads).finally(() => controller.setBusy(false));
    };

    return pickEnvironmentImpl(buildItems(), managers, projectEnvManagers, options, onDidShow);
}

export async function pickEnvironmentFrom(environments: PythonEnvironment[]): Promise<PythonEnvironment | undefined> {
    const items = environments.map((e) => {
        const pathDescription = e.displayPath;
        const description =
            e.description && e.description.trim() ? `${e.description} (${pathDescription})` : pathDescription;

        return {
            label: e.displayName ?? e.name,
            description: description,
            e: e,
            iconPath: getIconPath(e.iconPath),
        };
    });
    const selected = await showQuickPick(items, {
        placeHolder: Pickers.Environments.selectEnvironment,
        ignoreFocusOut: true,
    });
    return (selected as { e: PythonEnvironment })?.e;
}
