import { ChildProcess } from 'child_process';
import * as fs from 'fs-extra';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { PassThrough } from 'stream';
import { CancellationTokenSource, Disposable, ExtensionContext, LogOutputChannel, Uri } from 'vscode';
import * as rpc from 'vscode-jsonrpc/node';
import { PythonProjectApi } from '../../api';
import { spawnProcess } from '../../common/childProcess.apis';
import { ENVS_EXTENSION_ID, PYTHON_EXTENSION_ID } from '../../common/constants';
import { getExtension } from '../../common/extension.apis';
import { traceError, traceVerbose, traceWarn } from '../../common/logging';
import { StopWatch } from '../../common/stopWatch';
import { EventNames } from '../../common/telemetry/constants';
import { classifyError, isTimeoutErrorType } from '../../common/telemetry/errorClassifier';
import { sendTelemetryEvent } from '../../common/telemetry/sender';
import { untildify, untildifyArray } from '../../common/utils/pathUtils';
import { isWindows } from '../../common/utils/platformUtils';
import { createRunningWorkerPool, QueuePosition, WorkerPool } from '../../common/utils/workerPool';
import { getConfiguration, getWorkspaceFolders } from '../../common/workspace.apis';
import {
    getRefreshTelemetryMeasures,
    shouldRetainPetInfo,
    type RefreshPerformance,
} from './petTelemetry';
import { noop } from './utils';

// Timeout constants for JSON-RPC requests (in milliseconds)
const CONFIGURE_TIMEOUT_MS = 30_000; // 30 seconds for configuration
const MAX_CONFIGURE_TIMEOUT_MS = 60_000; // Max configure timeout after retries (60s)
const REFRESH_TIMEOUT_MS = 30_000; // 30 seconds for full refresh (with 1 retry = 60s max)
const RESOLVE_TIMEOUT_MS = 30_000; // 30 seconds for single resolve
const INFO_TIMEOUT_MS = 2_000; // `info` is a const lookup on PET; 2s is generous
const INFO_REQUEST_ATTEMPTS = 3; // Retry early startup timeouts without blocking PET operations

// CLI fallback timeout: generous budget since it's a full process spawn doing a full scan
const CLI_FALLBACK_TIMEOUT_MS = 120_000; // 2 minutes
// Limit concurrent resolve subprocesses to avoid CPU/memory pressure on machines with many envs
const CLI_RESOLVE_CONCURRENCY = 4;

// Restart/recovery constants
const MAX_RESTART_ATTEMPTS = 3;
const RESTART_BACKOFF_BASE_MS = 1_000; // 1 second base, exponential: 1s, 2s, 4s
const MAX_CONFIGURE_TIMEOUTS_BEFORE_KILL = 2; // Kill on the 2nd consecutive timeout
const MAX_REFRESH_RETRIES = 1; // Retry refresh once after timeout

/**
 * Computes the configure timeout with exponential backoff.
 * @param retryCount Number of consecutive configure timeouts so far
 * @returns Timeout in milliseconds: 30s, 60s, capped at MAX_CONFIGURE_TIMEOUT_MS (60s)
 */
export function getConfigureTimeoutMs(retryCount: number): number {
    return Math.min(CONFIGURE_TIMEOUT_MS * Math.pow(2, retryCount), MAX_CONFIGURE_TIMEOUT_MS);
}

/**
 * Encapsulates the configure retry state machine.
 * Tracks consecutive timeout count and decides whether to kill the process.
 */
export class ConfigureRetryState {
    private _timeoutCount: number = 0;

    get timeoutCount(): number {
        return this._timeoutCount;
    }

    /** Returns the timeout duration for the current attempt (with exponential backoff). */
    getTimeoutMs(): number {
        return getConfigureTimeoutMs(this._timeoutCount);
    }

    /** Call after a successful configure. Resets the timeout counter. */
    onSuccess(): void {
        this._timeoutCount = 0;
    }

    /**
     * Call after a configure timeout. Increments the counter and returns
     * whether the process should be killed (true = kill, false = let it continue).
     */
    onTimeout(): boolean {
        this._timeoutCount++;
        if (this._timeoutCount >= MAX_CONFIGURE_TIMEOUTS_BEFORE_KILL) {
            this._timeoutCount = 0;
            return true; // Kill the process
        }
        return false; // Let PET continue
    }

    /** Call after a non-timeout error or process restart. Resets the counter. */
    reset(): void {
        this._timeoutCount = 0;
    }
}

// ---------------------------------------------------------------------------
// Bounded end-to-end refresh latency
// ---------------------------------------------------------------------------

/**
 * Smallest remaining budget, in milliseconds, in which it is still worth starting an
 * extension-controlled stage (configure/refresh/resolve/CLI). Below this floor we fail fast
 * with {@link RefreshBudgetExceededError} instead of handing a stage a near-zero timeout that
 * would almost certainly expire. Justification: the fastest PET JSON-RPC round-trip (`info`, a
 * constant lookup) is budgeted a "generous" {@link INFO_TIMEOUT_MS} (2s); one second is a hard
 * floor below which even a trivial round-trip is unlikely to complete.
 */
export const MIN_STAGE_BUDGET_MS = 1_000;

/**
 * Computes the worst-case wall-clock of a *successful* server-mode refresh operation from the
 * existing stage constants. This is one of the two inputs to {@link computeRefreshOperationBudgetMs}.
 *
 * A successful `doRefresh` runs at most `MAX_REFRESH_RETRIES + 1` (= 2) attempts. The longest
 * successful path is reachable when the operation enters with an elevated restart-attempt state
 * (`restartAttempts = 2`) and a pending configure-timeout backoff (`configureRetry.timeoutCount = 1`)
 * while the process is healthy:
 *
 *   Attempt 0 — fails with a *retryable* refresh-RPC timeout (which triggers the single retry).
 *   No restart precedes it, so the extended configure timeout is NOT reset:
 *     - configure (extended after a prior timeout): MAX_CONFIGURE_TIMEOUT_MS   (60s)
 *     - refresh RPC timeout:                        REFRESH_TIMEOUT_MS          (30s)
 *     = 90s
 *
 *   Attempt 1 — restarts the process killed by attempt 0, then succeeds. The restart resets the
 *   configure timeout to its base:
 *     - restart backoff at the highest reachable attempt:
 *         RESTART_BACKOFF_BASE_MS * 2^(MAX_RESTART_ATTEMPTS - 1)                (1s * 2^2 = 4s)
 *     - configure (reset to base by the restart):   CONFIGURE_TIMEOUT_MS       (30s)
 *     - refresh RPC:                                REFRESH_TIMEOUT_MS         (30s)
 *     - parallel resolve enrichment (bounded):      RESOLVE_TIMEOUT_MS         (30s)
 *     = 94s
 *
 *   Total = 90s + 94s = 184s.
 *
 * The two attempts hit their individual maxima under the same reachable entry state (a failing
 * attempt with no restart but extended configure, followed by a succeeding attempt that restarts
 * at attempt index 2), so the sum is an attained maximum, not a loose over-approximation.
 *
 * The derivation is expressed in terms of {@link MAX_REFRESH_RETRIES} so the budget scales if the
 * retry count ever changes: only the first attempt can carry the extended configure timeout without
 * a preceding restart (every later attempt must restart first, which resets configure to its base),
 * so additional retries are modeled with the restart-based per-attempt cost.
 */
export function computeServerRefreshBudgetMs(): number {
    const maxRestartBackoffMs = RESTART_BACKOFF_BASE_MS * Math.pow(2, MAX_RESTART_ATTEMPTS - 1);
    // Only the first attempt can time out on an extended (already-backed-off) configure without a
    // preceding restart. Every later attempt restarts first, which resets configure to its base.
    const firstFailingAttemptMs = MAX_CONFIGURE_TIMEOUT_MS + REFRESH_TIMEOUT_MS;
    const additionalFailingAttemptMs = maxRestartBackoffMs + CONFIGURE_TIMEOUT_MS + REFRESH_TIMEOUT_MS;
    const failingAttemptsMs =
        MAX_REFRESH_RETRIES > 0
            ? firstFailingAttemptMs + (MAX_REFRESH_RETRIES - 1) * additionalFailingAttemptMs
            : 0;
    const succeedingAttemptMs = maxRestartBackoffMs + CONFIGURE_TIMEOUT_MS + REFRESH_TIMEOUT_MS + RESOLVE_TIMEOUT_MS;
    return failingAttemptsMs + succeedingAttemptMs;
}

/**
 * Computes the budget needed for the *CLI fallback* path, which is itself a valid successful path
 * and must keep its established enumeration timeout ({@link CLI_FALLBACK_TIMEOUT_MS}) rather than
 * being cut to whatever tiny remainder the server path leaves behind.
 *
 * The fallback is reached after the server path gives up. To bound its total latency without
 * starving the CLI, we model:
 *   - one worst *failing* server attempt (extended configure + refresh timeout):
 *       MAX_CONFIGURE_TIMEOUT_MS + REFRESH_TIMEOUT_MS                          (60s + 30s = 90s)
 *   - the restart/kill transition into the fallback (one max restart backoff):
 *       RESTART_BACKOFF_BASE_MS * 2^(MAX_RESTART_ATTEMPTS - 1)                 (4s)
 *   - the full CLI enumeration:
 *       CLI_FALLBACK_TIMEOUT_MS                                               (120s)
 *   = 214s
 *
 * To keep the server path from consuming this reserve, {@link retryWouldStarveCliFallbackMs} makes
 * `doRefresh` skip a second server retry (and fall back to the CLI immediately) whenever another
 * server attempt would leave less than a full CLI enumeration.
 */
export function computeCliFallbackPathBudgetMs(): number {
    const maxRestartBackoffMs = RESTART_BACKOFF_BASE_MS * Math.pow(2, MAX_RESTART_ATTEMPTS - 1);
    const worstServerAttemptMs = MAX_CONFIGURE_TIMEOUT_MS + REFRESH_TIMEOUT_MS;
    const transitionMs = maxRestartBackoffMs;
    return worstServerAttemptMs + transitionMs + CLI_FALLBACK_TIMEOUT_MS;
}

/**
 * The single end-to-end budget for one queued refresh operation. It is the *maximum* of the two
 * reachable successful paths — the full server retry path and the CLI-fallback path — so the cap
 * can never truncate either valid flow, and is deliberately NOT a stack of every pathological
 * timeout. With today's constants this is `max(184s, 214s) = 214s`.
 */
export function computeRefreshOperationBudgetMs(): number {
    return Math.max(computeServerRefreshBudgetMs(), computeCliFallbackPathBudgetMs());
}

/**
 * Returns true when doing another server refresh attempt would leave less than a full CLI
 * enumeration ({@link CLI_FALLBACK_TIMEOUT_MS} + one stage floor) of remaining budget. `doRefresh`
 * uses this to skip a second server retry and fall back to the CLI immediately, preserving the CLI
 * enumeration budget instead of burning it on a retry.
 *
 * The worst additional server attempt is a restart-backed attempt (restart backoff + base configure
 * + refresh); the extended-configure maximum only applies to the very first attempt, which has
 * already happened by the time this is consulted.
 */
export function retryWouldStarveCliFallbackMs(remainingMs: number): boolean {
    const maxRestartBackoffMs = RESTART_BACKOFF_BASE_MS * Math.pow(2, MAX_RESTART_ATTEMPTS - 1);
    const worstRetryCostMs = maxRestartBackoffMs + CONFIGURE_TIMEOUT_MS + REFRESH_TIMEOUT_MS;
    const cliReserveMs = CLI_FALLBACK_TIMEOUT_MS + MIN_STAGE_BUDGET_MS;
    return remainingMs < worstRetryCostMs + cliReserveMs;
}

/** The action `doRefresh` takes after a server refresh attempt fails. See {@link decideRefreshRetry}. */
export type RefreshRetryAction =
    | { kind: 'retry' } // kill + restart the process and try another server attempt
    // stop server mode and fall back to the JSON CLI (an existing success path). `reason` records why,
    // so the caller's log selection rides with the decision instead of re-deriving it:
    //   'starvation'       — another server retry would consume the reserved CLI enumeration budget
    //   'server-exhausted' — all restart attempts are used / the process is dead
    | { kind: 'cli-fallback'; reason: 'starvation' | 'server-exhausted' }
    | { kind: 'budget-exceeded' } // the operation budget can no longer fund another attempt
    | { kind: 'rethrow' }; // surface the original error unchanged

/** Inputs to {@link decideRefreshRetry}. All values are read once by the caller to avoid clock races. */
export interface RefreshRetryDecisionInput {
    /** The failure is already a {@link RefreshBudgetExceededError} (deadline provenance preserved upstream). */
    isBudgetError: boolean;
    /** A retryable transport failure (refresh-RPC timeout or connection error), not a configure error. */
    isRetryable: boolean;
    /** Zero-based index of the attempt that just failed. */
    attempt: number;
    /** Maximum additional retries ({@link MAX_REFRESH_RETRIES}). */
    maxRetries: number;
    /** Remaining operation budget in ms, or `undefined` when the caller supplied no deadline. */
    remainingMs: number | undefined;
    /** Whether server mode is fully exhausted (all restart attempts used / process dead). */
    serverExhausted: boolean;
}

/**
 * Pure decision for `doRefresh`'s post-failure control flow: retry another server attempt, fall back
 * to the CLI, surface a budget error, or rethrow. Extracted from `doRefresh` so the *composed*
 * retry/CLI-fallback/budget decision — not just the arithmetic helpers it builds on — is unit-testable
 * without spawning a real PET process or exporting the finder implementation. The caller performs the
 * side effects (logging, kill/restart, throwing) so this stays free of I/O.
 *
 * Ordering mirrors the original inline logic exactly:
 *  1. A budget error stops immediately (never retry/fall back — the CLI shares the same deadline).
 *  2. A retryable failure with retries left: fail fast if the budget is below one stage floor, else
 *     fall back to the CLI when another attempt would starve the reserved CLI enumeration budget,
 *     otherwise retry.
 *  3. Otherwise (non-retryable, or the final attempt): fall back to the CLI iff server mode is
 *     exhausted, else rethrow.
 */
export function decideRefreshRetry(input: RefreshRetryDecisionInput): RefreshRetryAction {
    if (input.isBudgetError) {
        return { kind: 'rethrow' };
    }

    if (input.isRetryable && input.attempt < input.maxRetries) {
        // A deadline is present (refresh path) but can no longer fund another attempt.
        if (input.remainingMs !== undefined && input.remainingMs < MIN_STAGE_BUDGET_MS) {
            return { kind: 'budget-exceeded' };
        }
        // Another server attempt would consume the reserved CLI enumeration budget: fall back now.
        if (input.remainingMs !== undefined && retryWouldStarveCliFallbackMs(input.remainingMs)) {
            return { kind: 'cli-fallback', reason: 'starvation' };
        }
        return { kind: 'retry' };
    }

    if (input.serverExhausted) {
        return { kind: 'cli-fallback', reason: 'server-exhausted' };
    }
    return { kind: 'rethrow' };
}

/** End-to-end budget for a single queued refresh operation. See {@link computeRefreshOperationBudgetMs}. */
export const REFRESH_OPERATION_BUDGET_MS = computeRefreshOperationBudgetMs();

/** Monotonic clock (immune to wall-clock adjustments) used for deadlines. Injectable for tests. */
export type MonotonicClock = () => number;

const defaultMonotonicClock: MonotonicClock = () => performance.now();

/**
 * An absolute, monotonic deadline captured at enqueue time. All running stages of a bounded
 * refresh clamp their timeouts to {@link remainingMs} so the operation cannot exceed its budget.
 */
export class Deadline {
    private readonly deadlineAt: number;

    /**
     * @param budgetMs Total time, in milliseconds, allowed from construction until the deadline.
     * @param now Monotonic clock. Defaults to `performance.now()`; injectable for deterministic tests.
     */
    constructor(
        budgetMs: number,
        private readonly now: MonotonicClock = defaultMonotonicClock,
    ) {
        this.deadlineAt = this.now() + budgetMs;
    }

    /** Milliseconds left before the deadline. Negative once the deadline has passed. */
    remainingMs(): number {
        return this.deadlineAt - this.now();
    }

    /** True when the remaining budget is below `floorMs` (default {@link MIN_STAGE_BUDGET_MS}). */
    isExhausted(floorMs: number = MIN_STAGE_BUDGET_MS): boolean {
        return this.remainingMs() < floorMs;
    }
}

/**
 * Error used to reject a bounded refresh (or one of its stages) once the operation budget is spent.
 * @param stage Short identifier of the stage that ran out of budget (for logs/telemetry).
 */
export class RefreshBudgetExceededError extends Error {
    constructor(
        public readonly stage: string,
        remainingMs: number,
    ) {
        super(`Refresh operation budget exceeded at stage '${stage}' (remaining ${Math.round(remainingMs)}ms)`);
        this.name = this.constructor.name;
    }
}

/**
 * Clamps a stage's base timeout to the deadline's remaining budget.
 *
 * - When `deadline` is undefined (resolve and other non-refresh callers), returns `baseTimeoutMs`
 *   unchanged so existing behavior is preserved.
 * - When the remaining budget is below `floorMs`, throws {@link RefreshBudgetExceededError} so the
 *   caller fails fast instead of starting a stage that would almost certainly time out.
 * - Otherwise returns `min(baseTimeoutMs, remaining)`.
 */
export function clampTimeoutToRemaining(
    baseTimeoutMs: number,
    deadline: Deadline | undefined,
    stage: string,
    floorMs: number = MIN_STAGE_BUDGET_MS,
): number {
    if (deadline === undefined) {
        return baseTimeoutMs;
    }
    const remaining = deadline.remainingMs();
    if (remaining < floorMs) {
        throw new RefreshBudgetExceededError(stage, remaining);
    }
    return Math.min(baseTimeoutMs, remaining);
}

export type NativePythonToolsSource = 'envs_extension' | 'python_extension';

export async function getNativePythonToolsPath(): Promise<string> {
    return (await getNativePythonToolsPathAndSource()).toolPath;
}

export async function getNativePythonToolsPathAndSource(): Promise<{
    toolPath: string;
    source: NativePythonToolsSource;
}> {
    const envsExt = getExtension(ENVS_EXTENSION_ID);
    if (envsExt) {
        const petPath = path.join(envsExt.extensionPath, 'python-env-tools', 'bin', isWindows() ? 'pet.exe' : 'pet');
        if (await fs.pathExists(petPath)) {
            return { toolPath: petPath, source: 'envs_extension' };
        }
    }

    const python = getExtension(PYTHON_EXTENSION_ID);
    if (!python) {
        throw new Error('Python extension not found');
    }

    return {
        toolPath: path.join(python.extensionPath, 'python-env-tools', 'bin', isWindows() ? 'pet.exe' : 'pet'),
        source: 'python_extension',
    };
}

/**
 * Runs `pet --version` and returns the parsed version string (e.g. '0.1.0').
 * Returns 'unknown' if the command fails, times out, or the output can't be parsed.
 */
export async function getNativePythonToolsVersion(toolPath: string, timeoutMs: number = 5_000): Promise<string> {
    return new Promise<string>((resolve) => {
        let settled = false;
        const settle = (value: string) => {
            if (settled) {
                return;
            }
            settled = true;
            resolve(value);
        };
        try {
            const proc = spawnProcess(toolPath, ['--version'], { stdio: 'pipe' });
            let stdout = '';
            const timer = setTimeout(() => {
                try {
                    proc.kill('SIGTERM');
                    // Force kill after a short grace period if still running.
                    setTimeout(() => {
                        if (proc.exitCode === null) {
                            try {
                                proc.kill('SIGKILL');
                            } catch {
                                // ignore
                            }
                        }
                    }, 500);
                } catch {
                    // ignore
                }
                settle('unknown');
            }, timeoutMs);
            proc.stdout?.on('data', (data: Buffer) => {
                stdout += data.toString();
            });
            proc.on('error', () => {
                clearTimeout(timer);
                settle('unknown');
            });
            proc.on('close', () => {
                clearTimeout(timer);
                // Output looks like "pet 0.1.0\n" — extract the version token.
                const match = stdout.match(/\b\d+\.\d+\.\d+\S*/);
                settle(match ? match[0] : 'unknown');
            });
        } catch {
            settle('unknown');
        }
    });
}

export interface NativeEnvInfo {
    displayName?: string;
    name?: string;
    executable?: string;
    kind?: NativePythonEnvironmentKind;
    version?: string;
    prefix?: string;
    manager?: NativeEnvManagerInfo;
    project?: string;
    arch?: 'x64' | 'x86';
    symlinks?: string[];
    /**
     * Error message if the environment is broken or invalid.
     * This is reported by PET when detecting issues like broken symlinks or missing executables.
     */
    error?: string;
}

export interface NativeEnvManagerInfo {
    tool: string;
    executable: string;
    version?: string;
}

export type NativeInfo = NativeEnvInfo | NativeEnvManagerInfo;

export function isNativeEnvInfo(info: NativeInfo): info is NativeEnvInfo {
    return !(info as NativeEnvManagerInfo).tool;
}

export enum NativePythonEnvironmentKind {
    conda = 'Conda',
    homebrew = 'Homebrew',
    pixi = 'Pixi',
    pyenv = 'Pyenv',
    globalPaths = 'GlobalPaths',
    pyenvVirtualEnv = 'PyenvVirtualEnv',
    pipenv = 'Pipenv',
    poetry = 'Poetry',
    macPythonOrg = 'MacPythonOrg',
    macCommandLineTools = 'MacCommandLineTools',
    linuxGlobal = 'LinuxGlobal',
    macXCode = 'MacXCode',
    uvWorkspace = 'UvWorkspace',
    venv = 'Venv',
    venvUv = 'Uv',
    virtualEnv = 'VirtualEnv',
    virtualEnvWrapper = 'VirtualEnvWrapper',
    windowsStore = 'WindowsStore',
    windowsRegistry = 'WindowsRegistry',
    winpython = 'WinPython',
}

export interface NativePythonFinder extends Disposable {
    /**
     * Refresh the list of python environments.
     * Returns an async iterable that can be used to iterate over the list of python environments.
     * Internally this will take all of the current workspace folders and search for python environments.
     *
     * If a Uri is provided, then it will search for python environments in that location (ignoring workspaces).
     * Uri can be a file or a folder.
     * If a NativePythonEnvironmentKind is provided, then it will search for python environments of that kind (ignoring workspaces).
     */
    refresh(hardRefresh: boolean, options?: NativePythonEnvironmentKind | Uri[]): Promise<NativeInfo[]>;
    /**
     * Will spawn the provided Python executable and return information about the environment.
     * @param executable
     */
    resolve(executable: string): Promise<NativeEnvInfo>;
}
interface NativeLog {
    level: string;
    message: string;
}

interface RefreshOptions {
    searchKind?: NativePythonEnvironmentKind;
    searchPaths?: string[];
}

/** Params shape of the PET `telemetry` JSON-RPC notification. */
interface PetTelemetryNotification {
    event: string;
    data: {
        refreshPerformance?: RefreshPerformance;
    };
}

/**
 * Response shape of the PET `info` JSON-RPC request.
 * `buildId` / `commitSha` are populated only when the PET binary was built by CI
 * with the appropriate env vars set; local dev builds omit them.
 */
interface NativePetInfo {
    petVersion: string;
    buildId?: string;
    commitSha?: string;
}

/**
 * Error thrown when a JSON-RPC request times out.
 */
export class RpcTimeoutError extends Error {
    constructor(
        public readonly method: string,
        timeoutMs: number,
    ) {
        super(`Request '${method}' timed out after ${timeoutMs}ms`);
        this.name = this.constructor.name;
    }
}

/** Retries only JSON-RPC timeout failures; all other errors propagate immediately. */
export async function retryRpcTimeout<T>(
    request: () => Promise<T>,
    maxAttempts: number,
    shouldRetry: () => boolean = () => true,
): Promise<T> {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
        throw new RangeError('maxAttempts must be a positive integer');
    }

    let attempt = 0;
    while (true) {
        attempt++;
        try {
            return await request();
        } catch (ex) {
            if (!(ex instanceof RpcTimeoutError) || attempt >= maxAttempts || !shouldRetry()) {
                throw ex;
            }
        }
    }
}

/**
 * Wraps a JSON-RPC sendRequest call with a timeout.
 * @param connection The JSON-RPC connection
 * @param method The RPC method name
 * @param params The parameters to send
 * @param timeoutMs Timeout in milliseconds
 * @returns The result of the request
 * @throws RpcTimeoutError if the request times out
 */
async function sendRequestWithTimeout<T>(
    connection: rpc.MessageConnection,
    method: string,
    params: unknown,
    timeoutMs: number,
): Promise<T> {
    const cts = new CancellationTokenSource();
    const timeoutPromise = new Promise<never>((_, reject) => {
        const timer = setTimeout(() => {
            cts.cancel();
            reject(new RpcTimeoutError(method, timeoutMs));
        }, timeoutMs);
        // Clear timeout if the CancellationTokenSource is disposed
        cts.token.onCancellationRequested(() => clearTimeout(timer));
    });

    try {
        return await Promise.race([connection.sendRequest<T>(method, params, cts.token), timeoutPromise]);
    } finally {
        cts.dispose();
    }
}

/**
 * Converts a stage failure into a {@link RefreshBudgetExceededError} when the failure was caused by
 * our own deadline clamp rather than genuine PET slowness — preserving *deadline provenance*.
 *
 * A stage started under a bounded refresh has its timeout clamped to the remaining budget
 * (see {@link clampTimeoutToRemaining}). If such a clamped stage times out, we necessarily waited
 * the whole remaining budget, so the deadline is now exhausted. Detecting that here lets callers
 * reclassify the failure as a budget-cap error *before* mutating ordinary stage retry counters or
 * emitting stage-timeout telemetry, so a deadline cap is never misattributed to a slow PET.
 *
 * Returns `undefined` (leave the error as an ordinary stage timeout) when there is no deadline, the
 * deadline still has budget left (a genuine base-timeout on a healthy budget), or the error is not
 * an {@link RpcTimeoutError}.
 */
export function toBudgetError(
    ex: unknown,
    deadline: Deadline | undefined,
    stage: string,
): RefreshBudgetExceededError | undefined {
    if (deadline !== undefined && deadline.isExhausted() && ex instanceof RpcTimeoutError) {
        return new RefreshBudgetExceededError(stage, deadline.remainingMs());
    }
    return undefined;
}

/**
 * Awaits a (already clamped) restart backoff, then rechecks the deadline. Rejects with
 * {@link RefreshBudgetExceededError} if the budget was spent during the wait, so a restart never
 * proceeds to teardown/spawn after the deadline has passed.
 *
 * @param waitMs Backoff duration to wait (callers clamp this to the remaining budget first).
 * @param deadline Optional operation deadline; when omitted the wait is unbounded (existing behavior).
 * @param sleep Injectable sleep, for deterministic tests.
 */
export async function backoffThenCheckBudget(
    waitMs: number,
    deadline: Deadline | undefined,
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<void> {
    if (waitMs > 0) {
        await sleep(waitMs);
    }
    if (deadline?.isExhausted()) {
        throw new RefreshBudgetExceededError('restart', deadline.remainingMs());
    }
}

/**
 * Item queued on the refresh worker pool. Carries the caller's refresh options plus the optional
 * end-to-end {@link Deadline} captured at enqueue time, so the worker can clamp its running stages
 * to the remaining budget.
 */
interface RefreshWorkItem {
    options?: NativePythonEnvironmentKind | Uri[];
    deadline?: Deadline;
}

/**
 * Result of a single `doRefresh`. `complete` is false when the environment enumeration succeeded but
 * per-environment enrichment (resolve) was cut short by the operation budget. Consumers still receive
 * the full enumerated `info`, but an incomplete result is NOT written to the soft cache, so a later
 * refresh retries the enrichment. Enumeration failures reject instead of returning a partial list.
 */
interface RefreshResult {
    info: NativeInfo[];
    complete: boolean;
}

class NativePythonFinderImpl implements NativePythonFinder {
    private connection: rpc.MessageConnection;
    private readonly pool: WorkerPool<RefreshWorkItem, RefreshResult>;
    private cache: Map<string, NativeInfo[]> = new Map();
    /**
     * Tracks in-flight hard refreshes by cache key so concurrent callers share a
     * single PET scan instead of queueing duplicate work.
     */
    private inFlightRefreshes: Map<string, Promise<NativeInfo[]>> = new Map();
    private startDisposables: Disposable[] = [];
    private proc: ChildProcess | undefined;
    private processExited: boolean = false;
    private startFailed: boolean = false;
    private restartAttempts: number = 0;
    private isRestarting: boolean = false;
    private processExitReason: string | undefined = undefined;
    private readonly configureRetry = new ConfigureRetryState();
    /**
     * Last successful PET `info` response. It survives process restarts because the executable
     * path is unchanged, then refreshes asynchronously for each new connection. This prevents
     * a transient startup timeout from erasing known build attribution.
     */
    private petInfo: NativePetInfo | undefined;
    private petBinaryFingerprint: string | undefined;

    constructor(
        private readonly outputChannel: LogOutputChannel,
        private readonly toolPath: string,
        private readonly api: PythonProjectApi,
        private readonly cacheDirectory?: Uri,
    ) {
        this.connection = this.start();
        this.pool = createRunningWorkerPool<RefreshWorkItem, RefreshResult>(
            async (work) => await this.doRefresh(work.options, work.deadline),
            1,
            'NativeRefresh-task',
        );
    }

    public async resolve(executable: string): Promise<NativeEnvInfo> {
        const sw = new StopWatch();
        try {
            await this.ensureProcessRunning();
            try {
                await this.configure();
                const environment = await sendRequestWithTimeout<NativeEnvInfo>(
                    this.connection,
                    'resolve',
                    { executable },
                    RESOLVE_TIMEOUT_MS,
                );

                this.outputChannel.info(`Resolved Python Environment ${environment.executable}`);
                // Reset restart attempts on successful request
                this.restartAttempts = 0;
                sendTelemetryEvent(EventNames.PET_RESOLVE, sw.elapsedTime, {
                    result: 'success',
                    ...this.getPetInfoProperties(),
                });
                return environment;
            } catch (ex) {
                // On resolve timeout or connection error (not configure — configure handles its own timeout),
                // kill the hung process so next request triggers restart
                if ((ex instanceof RpcTimeoutError && ex.method !== 'configure') || ex instanceof rpc.ConnectionError) {
                    const reason = ex instanceof rpc.ConnectionError ? 'crashed' : 'timed out';
                    this.outputChannel.warn(`[pet] Resolve request ${reason}, killing process for restart`);
                    this.killProcess();
                    this.processExited = true;
                    this.processExitReason =
                        ex instanceof rpc.ConnectionError ? 'rpc_connection_error' : 'rpc_resolve_timeout';
                }
                throw ex;
            }
        } catch (ex) {
            const errorType = classifyError(ex);
            sendTelemetryEvent(
                EventNames.PET_RESOLVE,
                sw.elapsedTime,
                {
                    result: isTimeoutErrorType(errorType) ? 'timeout' : 'error',
                    errorType,
                    ...this.getPetInfoProperties(),
                },
                ex instanceof Error ? ex : undefined,
            );
            // If the server mode is fully exhausted, fall back to the CLI JSON mode
            if (this.isServerExhausted()) {
                this.outputChannel.warn('[pet] Server mode exhausted, falling back to JSON CLI for resolve');
                return this.resolveViaJsonCli(executable);
            }
            throw ex;
        }
    }

    /**
     * Ensures the PET process is running. If it has exited or failed, attempts to restart
     * with exponential backoff up to MAX_RESTART_ATTEMPTS times.
     * @param deadline Optional operation deadline. When provided, the restart backoff is clamped to
     *        the remaining budget and a restart is refused once the budget is spent.
     * @throws Error if the process cannot be started after all retry attempts
     * @throws RefreshBudgetExceededError if the operation budget is spent
     */
    private async ensureProcessRunning(deadline?: Deadline): Promise<void> {
        // Process is running fine
        if (!this.startFailed && !this.processExited) {
            return;
        }

        // Already in the process of restarting (prevent recursive restarts)
        if (this.isRestarting) {
            throw new Error('Python Environment Tools (PET) is currently restarting. Please try again.');
        }

        // Check if we've exceeded max restart attempts
        if (this.restartAttempts >= MAX_RESTART_ATTEMPTS) {
            throw new Error(
                `Python Environment Tools (PET) failed after ${MAX_RESTART_ATTEMPTS} restart attempts. ` +
                    'Please reload the window or check the output channel for details. ' +
                    'To debug, run "Python Environments: Run Python Environment Tool (PET) in Terminal" from the Command Palette.',
            );
        }

        // Attempt restart with exponential backoff
        await this.restart(deadline);
    }

    /**
     * Kills the current PET process (if running) and starts a fresh one.
     * Implements exponential backoff between restart attempts.
     * @param deadline Optional operation deadline. When provided, the backoff wait is clamped to the
     *        remaining budget and the restart fails fast if the budget is already spent.
     */
    private async restart(deadline?: Deadline): Promise<void> {
        // Fail fast before mutating any state if the budget can no longer fund a restart + a useful
        // follow-up request. Leaves process/connection state untouched for the next operation.
        if (deadline?.isExhausted()) {
            throw new RefreshBudgetExceededError('restart', deadline.remainingMs());
        }

        this.isRestarting = true;
        this.restartAttempts++;
        const attempt = this.restartAttempts;
        const triggerReason = this.processExitReason ?? (this.startFailed ? 'start_failed' : 'unknown');

        // Clamp the exponential backoff to the remaining budget so a restart never overshoots the
        // operation deadline (unbounded when no deadline is supplied — resolve/non-refresh callers).
        const backoffMs = RESTART_BACKOFF_BASE_MS * Math.pow(2, this.restartAttempts - 1);
        const waitMs = deadline ? Math.min(backoffMs, Math.max(0, deadline.remainingMs())) : backoffMs;
        this.outputChannel.warn(
            `[pet] Restarting Python Environment Tools (attempt ${this.restartAttempts}/${MAX_RESTART_ATTEMPTS}, ` +
                `waiting ${waitMs}ms)`,
        );

        const sw = new StopWatch();
        try {
            // Wait out the (clamped) exponential backoff FIRST, then recheck the deadline. Once the
            // operation budget is spent we must not tear down the current process or spawn a
            // replacement, so this recheck sits immediately before teardown / state-reset / spawn.
            // backoffThenCheckBudget throws RefreshBudgetExceededError if the budget elapsed during
            // the wait; it is a plain (unbounded) wait when no deadline is supplied.
            await backoffThenCheckBudget(waitMs, deadline);

            // Kill existing process if still running
            this.killProcess();

            // Dispose existing connection and streams
            this.startDisposables.forEach((d) => d.dispose());
            this.startDisposables = [];

            // Reset state flags
            this.processExited = false;
            this.startFailed = false;
            this.processExitReason = undefined;
            this.lastConfiguration = undefined; // Force reconfiguration
            this.configureRetry.reset();

            // Start fresh
            this.connection = this.start();

            this.outputChannel.info('[pet] Python Environment Tools restarted successfully');
            sendTelemetryEvent(
                EventNames.PET_PROCESS_RESTART,
                { duration: sw.elapsedTime, attempt },
                {
                    result: 'success',
                    triggerReason,
                    ...this.getPetInfoProperties(),
                },
            );

            // Reset restart attempts on successful start (process didn't immediately fail)
            // We'll reset this only after a successful request completes
        } catch (ex) {
            if (ex instanceof RefreshBudgetExceededError) {
                // The operation budget was spent during the clamped backoff wait. This is a budget
                // cap, not a restart failure: undo the speculative attempt increment (no process was
                // actually spawned) and skip restart-error telemetry so it is not misclassified as a
                // PET restart error. The caller propagates it through the budget path.
                this.restartAttempts--;
                this.outputChannel.warn(`[pet] Restart aborted before spawn: ${ex.message}`);
                throw ex;
            }
            sendTelemetryEvent(
                EventNames.PET_PROCESS_RESTART,
                { duration: sw.elapsedTime, attempt },
                {
                    result: 'error',
                    errorType: classifyError(ex),
                    triggerReason,
                    ...this.getPetInfoProperties(),
                },
                ex instanceof Error ? ex : undefined,
            );
            this.outputChannel.error('[pet] Failed to restart Python Environment Tools:', ex);
            this.outputChannel.error(
                '[pet] To debug, run "Python Environments: Run Python Environment Tool (PET) in Terminal" from the Command Palette.',
            );
            throw ex;
        } finally {
            this.isRestarting = false;
        }
    }

    /**
     * Attempts to kill the PET process. Used during restart and timeout recovery.
     */
    private killProcess(): void {
        if (this.proc && this.proc.exitCode === null) {
            try {
                this.outputChannel.info('[pet] Killing hung/crashed PET process');
                this.proc.kill('SIGTERM');
                // Give it a moment to terminate gracefully, then force kill
                setTimeout(() => {
                    if (this.proc && this.proc.exitCode === null) {
                        this.proc.kill('SIGKILL');
                    }
                }, 500);
            } catch (ex) {
                this.outputChannel.error('[pet] Error killing process:', ex);
            }
        }
        this.proc = undefined;
    }

    public async refresh(hardRefresh: boolean, options?: NativePythonEnvironmentKind | Uri[]): Promise<NativeInfo[]> {
        if (hardRefresh) {
            return this.handleHardRefresh(options);
        }
        return this.handleSoftRefresh(options);
    }

    private getKey(options?: NativePythonEnvironmentKind | Uri[]): string {
        if (options === undefined) {
            return 'all';
        }
        if (typeof options === 'string') {
            return options;
        }
        if (Array.isArray(options)) {
            // Use null character as separator to avoid collisions with paths containing commas
            return options.map((item) => item.fsPath).join('\0');
        }
        return 'all';
    }

    private async handleHardRefresh(options?: NativePythonEnvironmentKind | Uri[]): Promise<NativeInfo[]> {
        const key = this.getKey(options);

        const inFlight = this.inFlightRefreshes.get(key);
        if (inFlight) {
            this.outputChannel.debug(`[Finder] Coalescing hard refresh with in-flight request for key: ${key}`);
            return inFlight;
        }

        this.cache.delete(key);
        if (!options) {
            this.outputChannel.debug('[Finder] Refreshing all environments');
        } else {
            this.outputChannel.debug(`[Finder] Hard refresh for key: ${key}`);
        }

        // A single monotonic deadline, captured now (enqueue time), bounds the operation end to end:
        // the worker pool rejects the item with QueueTaskExpiredError if it is still queued when the
        // budget elapses, and the same deadline clamps every running stage (configure/refresh/resolve/
        // restart/CLI). This caps both unbounded queue wait behind a stuck refresh and CLI enrichment
        // that would otherwise scale with the environment count.
        //
        // Trade-off (intentional): because the deadline is captured at enqueue and shared by the
        // queue wait and the running stages, time spent waiting in the queue is subtracted from the
        // running budget. Under sustained contention a distinct-key refresh queued behind a slow (but
        // not yet stuck) refresh may therefore fail fast rather than wait unbounded — this is the
        // point of the bound. In practice the common startup fan-out coalesces (all managers refresh
        // key 'all', deduped via inFlightRefreshes), so genuinely distinct-key contention is rare.
        const deadline = new Deadline(REFRESH_OPERATION_BUDGET_MS);

        // .finally clears the in-flight slot on both success AND failure paths so
        // a rejected refresh does not poison the cache — the next call after a
        // failure starts a fresh attempt, matching today's behavior.
        const refreshPromise = this.pool
            .addToQueue({ options, deadline }, QueuePosition.back, REFRESH_OPERATION_BUDGET_MS)
            .then((result) => {
                if (!result || !Array.isArray(result.info)) {
                    this.outputChannel.warn(`[pet] Worker pool returned invalid result type: ${typeof result}`);
                    return [] as NativeInfo[];
                }
                // Only cache a fully-enriched result. When enumeration succeeded but per-environment
                // enrichment was cut short by the operation budget (complete === false), we still hand
                // the caller the full enumerated list, but skip the cache so a later refresh retries
                // the enrichment instead of serving a permanently under-resolved result.
                if (result.complete) {
                    this.cache.set(key, result.info);
                } else {
                    this.outputChannel.debug(
                        `[Finder] Not caching enrichment-incomplete result for key: ${key} (budget exhausted during resolve)`,
                    );
                }
                return result.info;
            })
            .finally(() => {
                this.inFlightRefreshes.delete(key);
            });

        this.inFlightRefreshes.set(key, refreshPromise);
        return refreshPromise;
    }

    private async handleSoftRefresh(options?: NativePythonEnvironmentKind | Uri[]): Promise<NativeInfo[]> {
        const key = this.getKey(options);
        const cacheResult = this.cache.get(key);
        // Validate cache integrity - if cached value is not a valid array, do a hard refresh
        if (!cacheResult || !Array.isArray(cacheResult)) {
            if (cacheResult !== undefined) {
                this.outputChannel.warn(`[pet] Cache contained invalid data type: ${typeof cacheResult}`);
                this.cache.delete(key);
            }
            return this.handleHardRefresh(options);
        }

        if (!options) {
            this.outputChannel.debug('[Finder] Returning cached environments for all');
        } else {
            this.outputChannel.debug(`[Finder] Returning cached environments for key: ${key}`);
        }
        return cacheResult;
    }

    public dispose() {
        this.pool.stop();
        this.startDisposables.forEach((d) => d.dispose());
        this.connection.dispose();
    }

    private getRefreshOptions(options?: NativePythonEnvironmentKind | Uri[]): RefreshOptions {
        // Note: venvFolders is also fetched in getAllExtraSearchPaths() for configure().
        // This duplication is intentional: when searchPaths is provided to the native finder,
        // it may override (not supplement) the configured environmentDirectories.
        // We must include venvFolders here to ensure they're always searched during targeted refreshes.
        const venvFolders = getPythonSettingAndUntildify<string[]>('venvFolders') ?? [];
        if (options) {
            if (typeof options === 'string') {
                // kind
                return { searchKind: options };
            }
            if (Array.isArray(options)) {
                const uriSearchPaths = options.map((item) => item.fsPath);
                uriSearchPaths.push(...venvFolders);
                return { searchPaths: uriSearchPaths };
            }
        }
        // return empty object to use configured defaults (for nativeFinder refresh)
        return {};
    }

    private start(): rpc.MessageConnection {
        this.outputChannel.info(`[pet] Starting Python Locator ${this.toolPath} server`);

        // jsonrpc package cannot handle messages coming through too quickly.
        // Lets handle the messages and close the stream only when
        // we have got the exit event.
        const readable = new PassThrough();
        const writable = new PassThrough();

        try {
            this.proc = spawnProcess(this.toolPath, ['server'], { env: process.env, stdio: 'pipe' });

            if (!this.proc.stdout || !this.proc.stderr || !this.proc.stdin) {
                throw new Error('Failed to create stdio streams for PET process');
            }

            this.proc.stdout.pipe(readable, { end: false });
            this.proc.stderr.on('data', (data) => this.outputChannel.error(`[pet] ${data.toString()}`));
            writable.pipe(this.proc.stdin, { end: false });

            // Handle process exit - mark as exited so pending requests fail fast
            this.proc.on('exit', (code, signal) => {
                this.processExited = true;
                // Preserve a more-specific reason (e.g. rpc_*) if one was already recorded before the kill.
                if (this.processExitReason === undefined) {
                    this.processExitReason = `process_exit:${code ?? 'null'}:${signal ?? 'none'}`;
                }
                if (code !== 0) {
                    this.outputChannel.error(
                        `[pet] Python Environment Tools exited unexpectedly with code ${code}, signal ${signal}`,
                    );
                }
            });

            // Handle process errors (e.g., ENOENT if executable not found)
            this.proc.on('error', (err) => {
                this.processExited = true;
                if (this.processExitReason === undefined) {
                    this.processExitReason = 'process_error';
                }
                this.outputChannel.error('[pet] Process error:', err);
            });

            const proc = this.proc;
            this.startDisposables.push({
                dispose: () => {
                    try {
                        if (proc.exitCode === null) {
                            // Attempt graceful shutdown by closing stdin before killing
                            // This gives the process a chance to clean up
                            this.outputChannel.debug('[pet] Shutting down Python Locator server');
                            proc.stdin?.end();
                            // Give process a moment to exit gracefully, then force kill
                            setTimeout(() => {
                                if (proc.exitCode === null) {
                                    proc.kill();
                                }
                            }, 500);
                        }
                    } catch (ex) {
                        this.outputChannel.error('[pet] Error disposing finder', ex);
                    }
                },
            });
        } catch (ex) {
            // Mark start as failed so all subsequent requests fail immediately
            this.startFailed = true;
            this.outputChannel.error(`[pet] Error starting Python Finder ${this.toolPath} server`, ex);
            this.outputChannel.error(
                '[pet] To debug, run "Python Environments: Run Python Environment Tool (PET) in Terminal" from the Command Palette.',
            );
            // Don't continue - throw so caller knows spawn failed
            throw ex;
        }
        const connection = rpc.createMessageConnection(
            new rpc.StreamMessageReader(readable),
            new rpc.StreamMessageWriter(writable),
        );
        this.startDisposables.push(
            connection,
            new Disposable(() => {
                readable.end();
                writable.end();
            }),
            connection.onError((ex) => {
                this.outputChannel.error('[pet] Connection Error:', ex);
            }),
            connection.onNotification('log', (data: NativeLog) => {
                const msg = `[pet] ${data.message}`;
                switch (data.level) {
                    case 'info':
                        this.outputChannel.info(msg);
                        break;
                    case 'warning':
                        this.outputChannel.warn(msg);
                        break;
                    case 'error':
                        this.outputChannel.error(msg);
                        break;
                    case 'debug':
                        this.outputChannel.debug(msg);
                        break;
                    default:
                        this.outputChannel.trace(msg);
                }
            }),
            connection.onNotification('telemetry', (data) => this.outputChannel.info('[pet] Telemetry: ', data)),
            connection.onClose(() => {
                this.startDisposables.forEach((d) => d.dispose());
            }),
        );

        connection.listen();

        this.updatePetBinaryFingerprint();
        // Stamp PET telemetry with version/buildId/commitSha. Fire-and-forget — must not block refresh.
        this.kickoffInfoFetch(connection);

        return connection;
    }

    private updatePetBinaryFingerprint(): void {
        let currentFingerprint: string | undefined;
        try {
            const stat = fs.statSync(this.toolPath);
            currentFingerprint = `${stat.size}:${stat.mtimeMs}`;
        } catch (ex) {
            this.outputChannel.debug('[pet] Unable to fingerprint PET binary:', ex);
        }

        if (!shouldRetainPetInfo(this.petInfo !== undefined, this.petBinaryFingerprint, currentFingerprint)) {
            this.petInfo = undefined;
        }
        this.petBinaryFingerprint = currentFingerprint;
    }

    /**
     * Asks the PET server for its build metadata (version + optional buildId + optional commitSha)
     * and caches it in `this.petInfo` for downstream telemetry. Runs once per `start()` call.
     *
     * Fire-and-forget by design: refresh/resolve callers are never blocked. Early timeout
     * failures are retried with a bounded attempt count; older PET binaries and connection
     * failures still fail immediately. Responses from superseded connections are discarded.
     */
    private kickoffInfoFetch(connection: rpc.MessageConnection): void {
        retryRpcTimeout(
            () => sendRequestWithTimeout<NativePetInfo>(connection, 'info', {}, INFO_TIMEOUT_MS),
            INFO_REQUEST_ATTEMPTS,
            () => connection === this.connection,
        )
            .then((result) => {
                if (connection !== this.connection) {
                    return;
                }
                this.petInfo = result;
                this.outputChannel.debug('[pet] info:', result);
            })
            .catch((ex) => {
                if (connection !== this.connection) {
                    return;
                }
                // Older PET binaries don't implement `info`; preserve any prior successful attribution.
                this.outputChannel.debug('[pet] info request failed after bounded retries:', ex);
            });
    }

    /**
     * Builds the petVersion/petBuildId/petCommitSha properties for PET telemetry events.
     * Always returns concrete strings (defaulting to 'unknown') so Kusto can group by them
     * without dealing with nulls.
     */
    private getPetInfoProperties(): { petVersion: string; petBuildId: string; petCommitSha: string } {
        return {
            petVersion: this.petInfo?.petVersion ?? 'unknown',
            petBuildId: this.petInfo?.buildId ?? 'unknown',
            petCommitSha: this.petInfo?.commitSha ?? 'unknown',
        };
    }

    private async doRefresh(
        options?: NativePythonEnvironmentKind | Uri[],
        deadline?: Deadline,
    ): Promise<RefreshResult> {
        let lastError: unknown;

        for (let attempt = 0; attempt <= MAX_REFRESH_RETRIES; attempt++) {
            try {
                return await this.doRefreshAttempt(options, attempt, deadline);
            } catch (ex) {
                lastError = ex;

                const isBudgetError = ex instanceof RefreshBudgetExceededError;
                // Retry on timeout or connection errors (PET hung or crashed mid-request).
                const isRetryable =
                    (ex instanceof RpcTimeoutError && ex.method !== 'configure') || ex instanceof rpc.ConnectionError;
                // Read the remaining budget once so the decision and any budget error it produces
                // observe the same clock sample. `remainingMs` / `isServerExhausted()` are pure,
                // synchronous reads, so evaluating them eagerly for every caught error (rather than
                // lazily per-branch as the original did) yields identical values with no side effects.
                const remainingMs = deadline?.remainingMs();

                // The final retryable attempt is logged before the (shared) server-exhausted check,
                // matching the original inline ordering.
                if (isRetryable && attempt >= MAX_REFRESH_RETRIES) {
                    this.outputChannel.error(`[pet] Refresh failed after ${MAX_REFRESH_RETRIES + 1} attempts`);
                }

                const decision = decideRefreshRetry({
                    isBudgetError,
                    isRetryable,
                    attempt,
                    maxRetries: MAX_REFRESH_RETRIES,
                    remainingMs,
                    serverExhausted: this.isServerExhausted(),
                });

                switch (decision.kind) {
                    case 'budget-exceeded':
                        // The deadline can no longer fund another attempt: surface a budget error
                        // instead of burning the remaining time on a doomed restart + retry.
                        this.outputChannel.warn('[pet] Refresh budget exhausted after attempt failure, not retrying');
                        throw new RefreshBudgetExceededError('refresh_retry', remainingMs ?? 0);
                    case 'cli-fallback':
                        if (decision.reason === 'starvation') {
                            // Skipped the retry to preserve the reserved CLI enumeration budget.
                            // doRefreshAttempt already killed the process / set processExited for this
                            // retryable failure, so the CLI fallback starts from a clean slate.
                            this.outputChannel.warn(
                                '[pet] Skipping server retry to preserve the CLI enumeration budget; falling back to JSON CLI',
                            );
                        } else {
                            // Server mode is fully exhausted (all restart attempts used / process dead).
                            this.outputChannel.warn('[pet] Server mode exhausted, falling back to JSON CLI for refresh');
                        }
                        return await this.refreshViaJsonCli(options, deadline);
                    case 'retry': {
                        const reason = ex instanceof rpc.ConnectionError ? 'crashed' : 'timed out';
                        this.outputChannel.warn(
                            `[pet] Refresh ${reason} (attempt ${attempt + 1}/${MAX_REFRESH_RETRIES + 1}), restarting and retrying...`,
                        );
                        // Kill and restart for retry
                        this.killProcess();
                        this.processExited = true;
                        this.processExitReason =
                            ex instanceof rpc.ConnectionError ? 'rpc_connection_error' : 'rpc_refresh_timeout';
                        continue;
                    }
                    case 'rethrow':
                        // Budget errors stop immediately (the CLI shares this same deadline and would
                        // only fail its own budget check); other non-retryable errors surface as-is.
                        if (ex instanceof RefreshBudgetExceededError) {
                            this.outputChannel.warn(
                                `[pet] Refresh operation budget exhausted (${ex.message}), aborting`,
                            );
                        }
                        throw ex;
                }
            }
        }

        // Should not reach here, but TypeScript needs this
        if (this.isServerExhausted()) {
            this.outputChannel.warn('[pet] Server mode exhausted, falling back to JSON CLI for refresh (final)');
            return this.refreshViaJsonCli(options, deadline);
        }
        throw lastError;
    }

    private async doRefreshAttempt(
        options: NativePythonEnvironmentKind | Uri[] | undefined,
        attempt: number,
        deadline?: Deadline,
    ): Promise<RefreshResult> {
        await this.ensureProcessRunning(deadline);
        const disposables: Disposable[] = [];
        const unresolved: Promise<void>[] = [];
        const nativeInfo: NativeInfo[] = [];
        const sw = new StopWatch();
        let unresolvedCount = 0;
        // True when enumeration succeeded but at least one enrichment resolve was cut short by the
        // operation budget. The full (partially-unresolved) list is still returned to the caller, but
        // handleHardRefresh will not cache it, so a later refresh retries the enrichment.
        let enrichmentIncomplete = false;
        let refreshPerf: RefreshPerformance | undefined;
        let workspaceDirCount: number | undefined;
        let searchPathCount: number | undefined;
        try {
            const configuration = await this.buildConfigurationOptions();
            workspaceDirCount = configuration.workspaceDirectories.length;
            searchPathCount = configuration.environmentDirectories.length;
            await this.configure(configuration, deadline);
            const refreshOptions = this.getRefreshOptions(options);
            disposables.push(
                this.connection.onNotification('environment', (data: NativeEnvInfo) => {
                    this.outputChannel.info(`Discovered env: ${data.executable || data.prefix}`);
                    if (data.executable && (!data.version || !data.prefix)) {
                        unresolvedCount++;
                        // Clamp each enrichment resolve to the remaining budget. If the budget is
                        // already spent, keep the unresolved record (never drop a discovered env).
                        let resolveTimeout: number;
                        try {
                            resolveTimeout = clampTimeoutToRemaining(RESOLVE_TIMEOUT_MS, deadline, 'refresh_resolve');
                        } catch {
                            enrichmentIncomplete = true;
                            nativeInfo.push(data);
                            return;
                        }
                        unresolved.push(
                            sendRequestWithTimeout<NativeEnvInfo>(
                                this.connection,
                                'resolve',
                                { executable: data.executable },
                                resolveTimeout,
                            )
                                .then((environment: NativeEnvInfo) => {
                                    this.outputChannel.info(
                                        `Resolved environment during PET refresh: ${environment.executable}`,
                                    );
                                    nativeInfo.push(environment);
                                })
                                .catch((ex) => {
                                    // A resolve whose (clamped) timeout was cut short by an exhausted
                                    // budget must not drop the env — retain the unresolved record so
                                    // budget pressure never truncates discovery (mirrors the CLI path
                                    // and the budget-skip branch above). Genuine resolve failures with
                                    // budget still to spare keep the existing log-and-drop behavior.
                                    if (deadline?.isExhausted()) {
                                        enrichmentIncomplete = true;
                                        nativeInfo.push(data);
                                        return;
                                    }
                                    this.outputChannel.error(`Error in Resolving ${JSON.stringify(data)}`, ex);
                                }),
                        );
                    } else {
                        nativeInfo.push(data);
                    }
                }),
                this.connection.onNotification('manager', (data: NativeEnvManagerInfo) => {
                    this.outputChannel.info(`Discovered manager: (${data.tool}) ${data.executable}`);
                    nativeInfo.push(data);
                }),
                this.connection.onNotification('telemetry', (notification: PetTelemetryNotification) => {
                    if (notification?.event === 'RefreshPerformance' && notification.data?.refreshPerformance) {
                        refreshPerf = notification.data.refreshPerformance;
                    }
                }),
            );
            await sendRequestWithTimeout<{ duration: number }>(
                this.connection,
                'refresh',
                refreshOptions,
                clampTimeoutToRemaining(REFRESH_TIMEOUT_MS, deadline, 'refresh'),
            );
            await Promise.all(unresolved);

            // Reset restart attempts on successful refresh
            this.restartAttempts = 0;
            if (attempt > 0) {
                this.outputChannel.info(`[pet] Refresh succeeded on retry attempt ${attempt + 1}`);
            }

            sendTelemetryEvent(
                EventNames.PET_REFRESH,
                getRefreshTelemetryMeasures({
                    duration: sw.elapsedTime,
                    nativeInfo,
                    condaKind: NativePythonEnvironmentKind.conda,
                    unresolvedCount,
                    workspaceDirCount,
                    searchPathCount,
                    attempt,
                    refreshPerformance: refreshPerf,
                }),
                {
                    result: 'success',
                    locatorsJson: refreshPerf ? JSON.stringify(refreshPerf.locators) : undefined,
                    ...this.getPetInfoProperties(),
                },
            );
        } catch (ex) {
            // Deadline provenance (checked before ordinary stage telemetry/counters/kill): a budget
            // error — whether a stage below already threw it, or a clamped refresh-RPC timeout is
            // reclassified here — must propagate as a budget cap. We deliberately do NOT emit
            // PET_REFRESH stage-timeout telemetry, mutate restart/timeout counters, or kill the
            // process for it: exhausting OUR operation budget does not mean PET is unhealthy, and
            // sendRequestWithTimeout already cancelled the in-flight refresh RPC via its token.
            const budgetError =
                ex instanceof RefreshBudgetExceededError ? ex : toBudgetError(ex, deadline, 'refresh');
            if (budgetError) {
                this.outputChannel.warn(`[pet] Refresh attempt aborted by operation budget: ${budgetError.message}`);
                throw budgetError;
            }
            const errorType = classifyError(ex);
            sendTelemetryEvent(
                EventNames.PET_REFRESH,
                getRefreshTelemetryMeasures({
                    duration: sw.elapsedTime,
                    nativeInfo,
                    condaKind: NativePythonEnvironmentKind.conda,
                    unresolvedCount,
                    workspaceDirCount,
                    searchPathCount,
                    attempt,
                    refreshPerformance: refreshPerf,
                }),
                {
                    result: isTimeoutErrorType(errorType) ? 'timeout' : 'error',
                    errorType,
                    locatorsJson: refreshPerf ? JSON.stringify(refreshPerf.locators) : undefined,
                    ...this.getPetInfoProperties(),
                },
                ex instanceof Error ? ex : undefined,
            );
            // On refresh timeout or connection error (not configure — configure handles its own timeout),
            // kill the hung process so next request triggers restart
            if ((ex instanceof RpcTimeoutError && ex.method !== 'configure') || ex instanceof rpc.ConnectionError) {
                const reason = ex instanceof rpc.ConnectionError ? 'crashed' : 'timed out';
                this.outputChannel.warn(`[pet] PET process ${reason}, killing for restart`);
                this.killProcess();
                this.processExited = true;
                this.processExitReason =
                    ex instanceof rpc.ConnectionError ? 'rpc_connection_error' : 'rpc_refresh_timeout';
            }
            this.outputChannel.error('[pet] Error refreshing', ex);
            throw ex;
        } finally {
            disposables.forEach((d) => d.dispose());
        }

        return { info: nativeInfo, complete: !enrichmentIncomplete };
    }

    private lastConfiguration?: ConfigurationOptions;

    /**
     * Configuration request, this must always be invoked before any other request.
     * Must be invoked when ever there are changes to any data related to the configuration details.
     * @param deadline Optional operation deadline. When provided, the configure timeout is clamped to
     *        the remaining budget and configure fails fast once the budget is spent.
     */
    private async configure(options?: ConfigurationOptions, deadline?: Deadline) {
        const configuration = options ?? (await this.buildConfigurationOptions());
        const workspaceDirCount = configuration.workspaceDirectories.length;
        const envDirCount = configuration.environmentDirectories.length;
        // No need to send a configuration request if there are no changes.
        if (this.lastConfiguration && this.configurationEquals(configuration, this.lastConfiguration)) {
            this.outputChannel.debug('[pet] configure: No changes detected, skipping configuration update.');
            sendTelemetryEvent(
                EventNames.PET_CONFIGURE,
                { duration: 0, workspaceDirCount, envDirCount, retryCount: 0 },
                { result: 'skipped' },
            );
            return;
        }
        this.outputChannel.info('[pet] configure: Sending configuration update:', JSON.stringify(configuration));
        // Exponential backoff: 30s, 60s on retry. Capped at MAX_CONFIGURE_TIMEOUT_MS, then further
        // clamped to the remaining operation budget when a deadline is supplied (refresh path only).
        const timeoutMs = clampTimeoutToRemaining(this.configureRetry.getTimeoutMs(), deadline, 'configure');
        if (this.configureRetry.timeoutCount > 0) {
            this.outputChannel.info(
                `[pet] configure: Using extended timeout of ${timeoutMs}ms (retry ${this.configureRetry.timeoutCount})`,
            );
        }
        const sw = new StopWatch();
        const retryCount = this.configureRetry.timeoutCount;
        try {
            await sendRequestWithTimeout(this.connection, 'configure', configuration, timeoutMs);
            // Only cache after success so failed/timed-out calls will retry
            this.lastConfiguration = configuration;
            this.configureRetry.onSuccess();
            sendTelemetryEvent(
                EventNames.PET_CONFIGURE,
                { duration: sw.elapsedTime, workspaceDirCount, envDirCount, retryCount },
                { result: 'success' },
            );
        } catch (ex) {
            // Deadline provenance (checked before ordinary stage telemetry/retry counters): if OUR
            // budget clamp caused this timeout, reclassify it as a budget error up-front. We clear the
            // cached configuration (so a later operation reconfigures) but do NOT call
            // configureRetry.onTimeout(), emit PET_CONFIGURE stage-timeout telemetry, or kill the
            // process — exhausting our own budget does not imply an unhealthy PET, and
            // sendRequestWithTimeout already cancelled the in-flight configure via its token.
            const budgetError = toBudgetError(ex, deadline, 'configure');
            if (budgetError) {
                this.lastConfiguration = undefined;
                this.outputChannel.warn(`[pet] Configure aborted by operation budget: ${budgetError.message}`);
                throw budgetError;
            }
            const errorType = classifyError(ex);
            sendTelemetryEvent(
                EventNames.PET_CONFIGURE,
                { duration: sw.elapsedTime, workspaceDirCount, envDirCount, retryCount },
                {
                    result: isTimeoutErrorType(errorType) ? 'timeout' : 'error',
                    errorType,
                },
                ex instanceof Error ? ex : undefined,
            );
            // Clear cached config so the next call retries instead of short-circuiting via configurationEquals
            this.lastConfiguration = undefined;
            if (ex instanceof RpcTimeoutError) {
                const shouldKill = this.configureRetry.onTimeout();
                if (shouldKill) {
                    this.outputChannel.error(
                        '[pet] Configure timed out on consecutive attempts, killing hung process for restart',
                    );
                    this.killProcess();
                    this.processExited = true;
                    this.processExitReason = 'rpc_configure_timeout';
                } else {
                    this.outputChannel.warn(
                        `[pet] Configure request timed out (attempt ${this.configureRetry.timeoutCount}/${MAX_CONFIGURE_TIMEOUTS_BEFORE_KILL}), ` +
                            'will retry on next request without killing process',
                    );
                }
            } else {
                // Non-timeout errors reset the counter so only consecutive timeouts are counted
                this.configureRetry.reset();
                this.outputChannel.error('[pet] configure: Configuration error', ex);
            }
            throw ex;
        }
    }

    /**
     * Builds the current ConfigurationOptions from VS Code settings and the active workspace.
     * Extracted from configure() so the CLI fallback can build the same config.
     */
    private async buildConfigurationOptions(): Promise<ConfigurationOptions> {
        // Get all extra search paths including legacy settings and new searchPaths
        const extraSearchPaths = await getAllExtraSearchPaths();
        return {
            workspaceDirectories: this.api.getPythonProjects().map((item) => item.uri.fsPath),
            environmentDirectories: extraSearchPaths,
            condaExecutable: getPythonSettingAndUntildify<string>('condaPath'),
            pipenvExecutable: getPythonSettingAndUntildify<string>('pipenvPath'),
            poetryExecutable: getPythonSettingAndUntildify<string>('poetryPath'),
            cacheDirectory: this.cacheDirectory?.fsPath,
        };
    }

    /**
     * Returns true when all server restart attempts have been exhausted.
     * Used to decide whether to fall back to CLI mode.
     * Does NOT return true while a restart is in progress — the server is not exhausted
     * if it is still mid-restart (concurrent callers must not bypass to CLI prematurely).
     */
    private isServerExhausted(): boolean {
        return (
            !this.isRestarting &&
            this.restartAttempts >= MAX_RESTART_ATTEMPTS &&
            (this.startFailed || this.processExited)
        );
    }

    /**
     * Spawns the PET binary with the given args and collects its stdout.
     * Uses direct spawn (not shell) to avoid injection risks from user-supplied paths.
     * Kills the process after `timeoutMs` to prevent hangs.
     *
     * @param args Arguments to pass to the PET binary.
     * @param timeoutMs Maximum time to wait for the process to complete.
     * @returns The stdout string.
     */
    private runPetCliProcess(args: string[], timeoutMs: number): Promise<string> {
        return new Promise((resolve, reject) => {
            const proc = spawnProcess(this.toolPath, args, { stdio: 'pipe' });
            let stdout = '';
            // Guard against settling the promise more than once.
            // The timeout handler and the 'close'/'error' handlers can both fire
            // (e.g. timeout fires → SIGTERM sent → close event fires shortly after).
            let settled = false;

            const timer = setTimeout(() => {
                if (settled) {
                    return;
                }
                settled = true;
                try {
                    proc.kill('SIGTERM');
                    // Force kill after a short grace period if still running
                    setTimeout(() => {
                        if (proc.exitCode === null) {
                            proc.kill('SIGKILL');
                        }
                    }, 500);
                } catch {
                    // Ignore kill errors
                }
                reject(new Error(`PET CLI process timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            proc.stdout.on('data', (data: Buffer) => {
                stdout += data.toString();
            });
            proc.stderr.on('data', (data: Buffer) => {
                // PET writes diagnostics/logs to stderr in --json mode; surface them as debug
                this.outputChannel.debug(`[pet CLI] ${data.toString().trimEnd()}`);
            });
            proc.on('close', (code) => {
                if (settled) {
                    return;
                }
                clearTimeout(timer);
                settled = true;
                // If the process failed and produced no output, reject so caller gets a clear error
                if (code !== 0 && stdout.trim().length === 0) {
                    reject(new Error(`PET CLI process exited with code ${code}`));
                    return;
                }
                if (code !== 0) {
                    this.outputChannel.warn(
                        `[pet CLI] Process exited with code ${code} but produced output; using output`,
                    );
                }
                resolve(stdout);
            });
            proc.on('error', (err) => {
                if (settled) {
                    return;
                }
                clearTimeout(timer);
                settled = true;
                reject(err);
            });
        });
    }

    /**
     * Fallback environment refresh using `pet find --json`.
     * Invoked when the JSON-RPC server mode is exhausted after all restart attempts.
     * Spawns PET as a one-shot subprocess and parses the JSON output.
     *
     * @param options Optional kind filter or URI search paths (same semantics as refresh()).
     * @param deadline Optional operation deadline shared with the server-mode path. When provided,
     *        the `find` process and each enrichment resolve are clamped to the remaining budget.
     *        If enumeration (the `find`) cannot complete within budget the call rejects, but once
     *        `find` has completed, every discovered record is retained — running out of budget only
     *        stops further enrichment; it never truncates the environment list.
     * @returns RefreshResult whose `info` contains managers and environments (same as server mode).
     *          `complete` is false when enumeration succeeded but enrichment ran out of budget, so
     *          the caller can avoid caching a partially-enriched result.
     */
    private async refreshViaJsonCli(
        options?: NativePythonEnvironmentKind | Uri[],
        deadline?: Deadline,
    ): Promise<RefreshResult> {
        const config = await this.buildConfigurationOptions();
        // venvFolders must be included explicitly as search paths when options is Uri[],
        // mirroring getRefreshOptions() server-mode behaviour (searchPaths may override environmentDirectories).
        const venvFolders = getPythonSettingAndUntildify<string[]>('venvFolders') ?? [];
        const args = buildFindCliArgs(config, options, venvFolders);

        this.outputChannel.info(`[pet] JSON CLI fallback refresh: ${this.toolPath} ${args.join(' ')}`);
        const stopWatch = new StopWatch();

        // Enumeration must be able to complete within budget; clamp its timeout to the remaining
        // budget (throws RefreshBudgetExceededError up-front if the budget is already spent).
        const findTimeout = clampTimeoutToRemaining(CLI_FALLBACK_TIMEOUT_MS, deadline, 'cli_find');

        let stdout: string;
        try {
            stdout = await this.runPetCliProcess(args, findTimeout);
        } catch (ex) {
            sendTelemetryEvent(EventNames.PET_JSON_CLI_FALLBACK, stopWatch.elapsedTime, {
                operation: 'refresh',
                result: 'error',
            });
            this.outputChannel.error('[pet] JSON CLI fallback refresh failed:', ex);
            // A budget-clamped enumeration that timed out is an incomplete enumeration: surface it as
            // a budget error rather than a generic CLI timeout so it classifies consistently.
            if (deadline?.isExhausted()) {
                throw new RefreshBudgetExceededError('cli_find', deadline.remainingMs());
            }
            throw ex;
        }

        let parsed: { managers: NativeEnvManagerInfo[]; environments: NativeEnvInfo[] };
        try {
            parsed = parseRefreshCliOutput(stdout);
        } catch (ex) {
            sendTelemetryEvent(EventNames.PET_JSON_CLI_FALLBACK, stopWatch.elapsedTime, {
                operation: 'refresh',
                result: 'error',
            });
            this.outputChannel.error(
                `[pet] JSON CLI fallback: Failed to parse find output (first 500 chars): ${stdout.slice(0, 500)}`,
                ex,
            );
            const cause = ex instanceof Error ? `: ${ex.message}` : '';
            throw new Error(`Failed to parse PET find --json output${cause}`);
        }

        const nativeInfo: NativeInfo[] = [];

        for (const manager of parsed.managers ?? []) {
            this.outputChannel.info(`[pet CLI] Discovered manager: (${manager.tool}) ${manager.executable}`);
            nativeInfo.push(manager);
        }

        // Collect environments that need individual resolve calls.
        // Incomplete environments have an executable but are missing version or prefix.
        const toResolve: NativeEnvInfo[] = [];
        for (const env of parsed.environments ?? []) {
            if (env.executable && (!env.version || !env.prefix)) {
                toResolve.push(env);
            } else {
                this.outputChannel.info(`[pet CLI] Discovered env: ${env.executable ?? env.prefix}`);
                nativeInfo.push(env);
            }
        }

        // Resolve incomplete environments with bounded concurrency to avoid spawning too many
        // subprocesses at once on machines with many incomplete environments.
        // Each resolveViaJsonCli() spawns a new OS process, unlike server mode where all resolve
        // calls share a single long-lived process — so unbounded parallelism would cause CPU/memory
        // pressure. Process in batches of CLI_RESOLVE_CONCURRENCY.
        let enrichmentBudgetSpent = false;
        // Retains every not-yet-enriched record as-is (unresolved) so budget exhaustion never
        // truncates the enumerated environment list. Called on both the up-front exhaustion check
        // and the (rare) case where the clamp trips between that check and issuing the batch.
        const retainRemainingUnresolved = (fromIndex: number): void => {
            enrichmentBudgetSpent = true;
            const remaining = toResolve.slice(fromIndex);
            this.outputChannel.warn(
                `[pet CLI] Refresh budget exhausted; retaining ${remaining.length} unresolved env(s) without enrichment`,
            );
            for (const env of remaining) {
                nativeInfo.push(env);
            }
        };
        for (let i = 0; i < toResolve.length; i += CLI_RESOLVE_CONCURRENCY) {
            // Enrichment is best-effort: once the budget is spent, retain every remaining discovered
            // record as-is (unresolved) and stop. This bounds enrichment latency (which otherwise
            // scales with environment count) without ever truncating the enumerated environment list.
            if (deadline?.isExhausted()) {
                retainRemainingUnresolved(i);
                break;
            }
            const batch = toResolve.slice(i, i + CLI_RESOLVE_CONCURRENCY);
            // isExhausted() and clampTimeoutToRemaining() read the clock separately, so the budget
            // could dip below the floor between them. Treat that clamp throw exactly like an
            // exhausted budget (retain + stop) instead of letting it escape and discard everything
            // already enumerated.
            let resolveTimeout: number;
            try {
                resolveTimeout = clampTimeoutToRemaining(CLI_FALLBACK_TIMEOUT_MS, deadline, 'cli_resolve');
            } catch (ex) {
                if (ex instanceof RefreshBudgetExceededError) {
                    retainRemainingUnresolved(i);
                    break;
                }
                throw ex;
            }
            await Promise.all(
                batch.map((env) =>
                    this.resolveViaJsonCli(env.executable!, resolveTimeout)
                        .then((resolved) => {
                            this.outputChannel.info(`[pet CLI] Resolved env: ${resolved.executable}`);
                            nativeInfo.push(resolved);
                        })
                        .catch(() => {
                            // If resolve fails, still include the partial env so nothing is silently
                            // dropped. If the failure was our budget clamp cutting this resolve short
                            // (deadline now exhausted), mark enrichment incomplete so even the final /
                            // only batch is reported partial and the result is not cached — a later
                            // refresh then retries the enrichment.
                            if (deadline?.isExhausted()) {
                                enrichmentBudgetSpent = true;
                            }
                            this.outputChannel.warn(
                                `[pet CLI] Could not resolve incomplete env, using partial data: ${env.executable}`,
                            );
                            nativeInfo.push(env);
                        }),
                ),
            );
        }

        sendTelemetryEvent(EventNames.PET_JSON_CLI_FALLBACK, stopWatch.elapsedTime, {
            operation: 'refresh',
            result: enrichmentBudgetSpent ? 'partial' : 'success',
        });
        return { info: nativeInfo, complete: !enrichmentBudgetSpent };
    }

    /**
     * Fallback environment resolution using `pet resolve <exe> --json`.
     * Invoked when the JSON-RPC server mode is exhausted after all restart attempts.
     *
     * @param executable Path to the Python executable to resolve.
     * @returns The resolved NativeEnvInfo.
     * @throws Error if PET cannot identify the environment or if the output cannot be parsed.
     */
    private async resolveViaJsonCli(
        executable: string,
        timeoutMs: number = CLI_FALLBACK_TIMEOUT_MS,
    ): Promise<NativeEnvInfo> {
        const args = ['resolve', executable, '--json'];
        if (this.cacheDirectory) {
            args.push('--cache-directory', this.cacheDirectory.fsPath);
        }

        this.outputChannel.info(`[pet] JSON CLI fallback resolve: ${this.toolPath} ${args.join(' ')}`);
        const stopWatch = new StopWatch();

        let stdout: string;
        try {
            stdout = await this.runPetCliProcess(args, timeoutMs);
        } catch (ex) {
            sendTelemetryEvent(EventNames.PET_JSON_CLI_FALLBACK, stopWatch.elapsedTime, {
                operation: 'resolve',
                result: 'error',
            });
            this.outputChannel.error('[pet] JSON CLI fallback resolve failed:', ex);
            throw ex;
        }

        let parsed: NativeEnvInfo;
        try {
            parsed = parseResolveCliOutput(stdout.trim(), executable);
        } catch (ex) {
            sendTelemetryEvent(EventNames.PET_JSON_CLI_FALLBACK, stopWatch.elapsedTime, {
                operation: 'resolve',
                result: 'error',
            });
            if (ex instanceof SyntaxError) {
                this.outputChannel.error(
                    '[pet] JSON CLI fallback: Failed to parse resolve output:',
                    stdout.slice(0, 200),
                );
                throw new Error(`Failed to parse PET resolve --json output for ${executable}`);
            }
            // "not found" (null) or other parse error
            throw ex;
        }

        sendTelemetryEvent(EventNames.PET_JSON_CLI_FALLBACK, stopWatch.elapsedTime, {
            operation: 'resolve',
            result: 'success',
        });
        return parsed;
    }

    /**
     * Compares two ConfigurationOptions objects for equality.
     * Uses property-by-property comparison to avoid issues with JSON.stringify
     * (property order, undefined values serialization).
     */
    private configurationEquals(a: ConfigurationOptions, b: ConfigurationOptions): boolean {
        // Compare simple optional string properties
        if (a.condaExecutable !== b.condaExecutable) {
            return false;
        }
        if (a.pipenvExecutable !== b.pipenvExecutable) {
            return false;
        }
        if (a.poetryExecutable !== b.poetryExecutable) {
            return false;
        }
        if (a.cacheDirectory !== b.cacheDirectory) {
            return false;
        }

        // Compare array properties using sorted comparison to handle order differences
        const arraysEqual = (arr1: string[], arr2: string[]): boolean => {
            if (arr1.length !== arr2.length) {
                return false;
            }
            const sorted1 = [...arr1].sort();
            const sorted2 = [...arr2].sort();
            return sorted1.every((val, idx) => val === sorted2[idx]);
        };

        if (!arraysEqual(a.workspaceDirectories, b.workspaceDirectories)) {
            return false;
        }
        if (!arraysEqual(a.environmentDirectories, b.environmentDirectories)) {
            return false;
        }

        return true;
    }
}

export type ConfigurationOptions = {
    workspaceDirectories: string[];
    environmentDirectories: string[];
    condaExecutable: string | undefined;
    pipenvExecutable: string | undefined;
    poetryExecutable: string | undefined;
    cacheDirectory?: string;
};

/**
 * Parses the stdout of `pet find --json` into a structured result.
 * Returns `{ managers, environments }` arrays (each may be empty).
 *
 * @param stdout Raw stdout from `pet find --json`.
 * @returns Parsed result object.
 * @throws SyntaxError if `stdout` is not valid JSON or not the expected object shape.
 */
export function parseRefreshCliOutput(stdout: string): {
    managers: NativeEnvManagerInfo[];
    environments: NativeEnvInfo[];
} {
    // May throw SyntaxError on malformed JSON — callers must handle
    const parsed = JSON.parse(stdout);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new SyntaxError('PET find --json output is not a JSON object');
    }
    return {
        managers: Array.isArray(parsed.managers) ? parsed.managers : [],
        environments: Array.isArray(parsed.environments) ? parsed.environments : [],
    };
}

/**
 * Parses the stdout of `pet resolve <exe> --json` into a single environment info object.
 *
 * @param stdout Raw stdout from `pet resolve --json` (trimmed).
 * @param executable The executable that was resolved (used in error messages).
 * @returns The parsed `NativeEnvInfo`.
 * @throws Error if `stdout` is `"null"` (environment not found) or malformed JSON.
 */
export function parseResolveCliOutput(stdout: string, executable: string): NativeEnvInfo {
    // May throw SyntaxError on malformed JSON — callers must handle
    const parsed: NativeEnvInfo | null = JSON.parse(stdout);
    if (parsed === null) {
        throw new Error(`PET could not identify environment for executable: ${executable}`);
    }
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new SyntaxError(`PET resolve --json output is not a JSON object for ${executable}`);
    }
    return parsed;
}

/**
 * Builds the CLI arguments array for a `pet find --json` invocation.
 * This is exported for testability.
 *
 * @param config The configuration options (workspace dirs, tool paths, cache dir, env dirs).
 * @param options Optional refresh options: a kind filter string or an array of URIs to search.
 * @param venvFolders Additional virtual environment folder paths to include when searching
 *   URI-based paths (needed because searchPaths may override environmentDirectories in PET).
 * @returns The args array to pass directly to the PET binary, starting with `['find', '--json']`
 *   followed by the positional search paths and configuration flags.
 */
export function buildFindCliArgs(
    config: ConfigurationOptions,
    options?: NativePythonEnvironmentKind | Uri[],
    venvFolders: string[] = [],
): string[] {
    const args: string[] = ['find', '--json'];

    if (options) {
        if (typeof options === 'string') {
            // NativePythonEnvironmentKind — filter by environment kind.
            // In server mode, `build_refresh_config` keeps the configured workspace dirs when
            // search_kind is set, so workspace-scoped envs of that kind (e.g. Venv) are found.
            // Mirror that here by passing workspace dirs as positional search paths.
            args.push('--kind', options);
            for (const dir of config.workspaceDirectories) {
                args.push(dir);
            }
        } else if (Array.isArray(options)) {
            // Uri[] — these become the positional search paths (overriding workspace dirs).
            // In server mode, `build_refresh_config` sets search_scope = Workspace, which causes
            // find_and_report_envs to skip all global discovery phases (locators, PATH, global venvs)
            // and only search the provided paths. Mirror that with --workspace.
            //
            // Edge case: if both options and venvFolders are empty, omit --workspace entirely.
            // PET's CLI has no "search nothing" mode — with --workspace but no positional paths it
            // falls back to CWD. Falling through to the workspace-dirs path is a better approximation
            // of server-mode's empty-searchPaths behavior (which searches nothing meaningful) and
            // avoids scanning an arbitrary directory.
            const searchPaths = [...options.map((u) => u.fsPath), ...venvFolders];
            if (searchPaths.length > 0) {
                args.push('--workspace');
                for (const p of searchPaths) {
                    args.push(p);
                }
            } else {
                // No search paths at all: fall back to workspace dirs as positional args
                for (const dir of config.workspaceDirectories) {
                    args.push(dir);
                }
            }
        }
    } else {
        // No options: pass workspace directories as positional search paths
        for (const dir of config.workspaceDirectories) {
            args.push(dir);
        }
    }

    // Always forward configuration flags
    if (config.cacheDirectory) {
        args.push('--cache-directory', config.cacheDirectory);
    }
    if (config.condaExecutable) {
        args.push('--conda-executable', config.condaExecutable);
    }
    if (config.pipenvExecutable) {
        args.push('--pipenv-executable', config.pipenvExecutable);
    }
    if (config.poetryExecutable) {
        args.push('--poetry-executable', config.poetryExecutable);
    }
    // Pass each environment directory as a separate flag repetition.
    // PET's --environment-directories uses value_delimiter=',' for env-var parsing, but
    // repeating the flag on the CLI is the safe way to handle paths that contain commas.
    for (const dir of config.environmentDirectories) {
        args.push('--environment-directories', dir);
    }

    return args;
}
/**
 * Gets all custom virtual environment locations to look for environments from the legacy python settings (venvPath, venvFolders).
 */
function getCustomVirtualEnvDirsLegacy(): string[] {
    const venvDirs: string[] = [];
    const venvPath = getPythonSettingAndUntildify<string>('venvPath');
    if (venvPath) {
        venvDirs.push(untildify(venvPath));
    }
    const venvFolders = getPythonSettingAndUntildify<string[]>('venvFolders') ?? [];
    venvFolders.forEach((item) => {
        venvDirs.push(item);
    });
    return Array.from(new Set(venvDirs));
}

function getPythonSettingAndUntildify<T>(name: string, scope?: Uri): T | undefined {
    const value = getConfiguration('python', scope).get<T>(name);
    if (typeof value === 'string') {
        return value ? (untildify(value as string) as unknown as T) : undefined;
    }
    return value;
}

/**
 * Cross-platform check for absolute paths.
 * Uses both current platform's check and Windows-specific check to handle
 * Windows paths (e.g., C:\path) when running on Unix systems.
 */
function isAbsolutePath(inputPath: string): boolean {
    return path.isAbsolute(inputPath) || path.win32.isAbsolute(inputPath);
}

/**
 * Gets all extra environment search paths from various configuration sources.
 * Combines legacy python settings (with migration), globalSearchPaths, and workspaceSearchPaths.
 *
 * Paths can include glob patterns which are expanded by the native
 * Python Environment Tool (PET) during environment discovery.
 *
 * @returns Array of search paths (may include glob patterns)
 */
export async function getAllExtraSearchPaths(): Promise<string[]> {
    const searchDirectories: string[] = [];

    // add legacy custom venv directories
    const customVenvDirs = getCustomVirtualEnvDirsLegacy();
    searchDirectories.push(...customVenvDirs);

    // Get globalSearchPaths
    const globalSearchPaths = getGlobalSearchPaths().filter((path) => path && path.trim() !== '');
    searchDirectories.push(...globalSearchPaths);

    // Get workspaceSearchPaths — scoped per workspace folder in multi-root workspaces
    const workspaceFolders = getWorkspaceFolders();
    const workspaceSearchPathsPerFolder: { paths: string[]; folder?: Uri }[] = [];

    if (workspaceFolders && workspaceFolders.length > 0) {
        for (const folder of workspaceFolders) {
            const paths = getWorkspaceSearchPaths(folder.uri);
            workspaceSearchPathsPerFolder.push({ paths, folder: folder.uri });
        }
    } else {
        // No workspace folders — fall back to unscoped call
        workspaceSearchPathsPerFolder.push({ paths: getWorkspaceSearchPaths() });
    }

    // Resolve relative paths against the specific folder they came from
    for (const { paths, folder } of workspaceSearchPathsPerFolder) {
        for (const searchPath of paths) {
            if (!searchPath || searchPath.trim() === '') {
                continue;
            }

            const trimmedPath = searchPath.trim();

            if (isAbsolutePath(trimmedPath)) {
                // Absolute path - use as is
                searchDirectories.push(trimmedPath);
            } else if (folder) {
                // Relative path - resolve against the specific folder it came from
                const resolvedPath = path.resolve(folder.fsPath, trimmedPath);
                searchDirectories.push(resolvedPath);
            } else {
                traceWarn('No workspace folder for relative search path:', trimmedPath);
            }
        }
    }

    // Remove duplicates and normalize to forward slashes for cross-platform glob compatibility
    const uniquePaths = Array.from(new Set(searchDirectories));
    const normalizedPaths = uniquePaths.map((p) => p.replace(/\\/g, '/'));
    traceVerbose('Environment search directories:', normalizedPaths.length, 'paths');
    return normalizedPaths;
}

/**
 * Gets globalSearchPaths setting with proper validation.
 * Only gets user-level (global) setting since this setting is application-scoped.
 */
function getGlobalSearchPaths(): string[] {
    try {
        const envConfig = getConfiguration('python-envs');
        const inspection = envConfig.inspect<string[]>('globalSearchPaths');

        const globalPaths = inspection?.globalValue || [];
        return untildifyArray(globalPaths);
    } catch (error) {
        traceError('Error getting globalSearchPaths:', error);
        return [];
    }
}

let workspaceSearchPathsGlobalWarningShown = false;

/**
 * @internal Test-only helper to reset the workspaceSearchPaths global-level warning flag.
 */
export function resetWorkspaceSearchPathsGlobalWarningFlag(): void {
    workspaceSearchPathsGlobalWarningShown = false;
}

/**
 * Gets the most specific workspace-level setting available for workspaceSearchPaths.
 * Supports glob patterns which are expanded by PET.
 */
function getWorkspaceSearchPaths(scope?: Uri): string[] {
    try {
        const envConfig = getConfiguration('python-envs', scope);
        const inspection = envConfig.inspect<string[]>('workspaceSearchPaths');

        if (inspection?.globalValue && !workspaceSearchPathsGlobalWarningShown) {
            workspaceSearchPathsGlobalWarningShown = true;
            traceError(
                'python-envs.workspaceSearchPaths is set at the user/global level, but this setting can only be set at the workspace or workspace folder level.',
            );
        }

        // For workspace settings, prefer workspaceFolder > workspace > default
        if (inspection?.workspaceFolderValue) {
            return inspection.workspaceFolderValue;
        }

        if (inspection?.workspaceValue) {
            return inspection.workspaceValue;
        }

        // Use the default value from package.json
        return inspection?.defaultValue ?? [];
    } catch (error) {
        traceError('Error getting workspaceSearchPaths:', error);
        return [];
    }
}

export function getCacheDirectory(context: ExtensionContext): Uri {
    return Uri.joinPath(context.globalStorageUri, 'pythonLocator');
}

export async function clearCacheDirectory(context: ExtensionContext): Promise<void> {
    const cacheDirectory = getCacheDirectory(context);
    await fs.emptyDir(cacheDirectory.fsPath).catch(noop);
}

export async function createNativePythonFinder(
    outputChannel: LogOutputChannel,
    api: PythonProjectApi,
    context: ExtensionContext,
): Promise<NativePythonFinder> {
    return new NativePythonFinderImpl(outputChannel, await getNativePythonToolsPath(), api, getCacheDirectory(context));
}
