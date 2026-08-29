# PEP 723 Design Questions

> **Status — revised after implementation.** Sections 6, 7, 9, and 10 have
> been updated to match the shipped code and the in-flight PRs
> (`vscode-python-environments` #1744 / #1745, `pyrx` #9265,
> `vscode-python` #26129). Where the original "before-implementation"
> decision changed during implementation, the revised text records what was
> actually built and why.

This is a checklist of design decisions to make **before** implementing
code for PEP 723 / inline-script-metadata support in the Python
Environments extension. 

## Table of contents

1. [Detection — when do we notice a PEP 723 script?](#1-detection)
2. [Where the env lives on disk](#2-disk-location)
3. [What's in the env folder](#3-env-folder-contents)
4. [How to map a script to its on-disk directory](#4-script-to-directory-mapping)
5. [When to reuse vs create a new env](#5-reuse-vs-create)
6. [Persistence model for the script-to-env association](#6-association-persistence)
7. [Cleanup model — when and how do envs get removed?](#7-cleanup)
8. [UX — bulk vs single env creation](#8-ux-flows)
9. [How does Pylance pick up the env?](#9-pylance)
10. [How does Run / F5 / debug pick up the env?](#10-run-debug)
11. [Telemetry — what events do we emit?](#11-telemetry)

---

## 1. Detection

**Question:** When do we decide a `.py` file is a "PEP 723 script"?

**Decision:**

- **Lazy on open + save** — parse only when the file enters an editor or
  is saved. 
- **Opt-in bulk command** — user runs `Python Envs: Set Up Environments for Inline Script Files` from the command palette to discover all of them, list every detected inline-script files in a multi-select quick-pick.

---

## 2. Disk location

**Question:** Where on disk does the env live?

**Decision:**

- **`<globalStorageUri>/script-envs-v1/<...>/`** — hidden per-extension,
  sandboxed by VS Code, never in workspace.

## 3. Env folder contents

**Question:** What's inside the env directory? What do we own, what does
pip own?

**Decision**

- **The venv itself** — standard `python -m venv` output. Includes
  `pyvenv.cfg`, `bin/` or `Scripts/`, `Lib/site-packages/`. We only
  own the env layer, let pip handle the package layer.

- **A `.meta.json` sidecar** at the root of each env directory. (See Q7 for why it's needed.)
  Records the bookkeeping the extension needs to manage the env's
  lifecycle. Minimum fields:

  ```jsonc
  {
    "schemaVersion": 1,
    "scriptFsPath": "c:\\projects\\demo.py",     // owning script
    "createdAt":  "2026-06-18T22:30:00.000Z",
    "lastUsedAt": "2026-06-18T22:45:12.000Z",    // bumped on every reuse; drives Q7's TTL
    "requiresPython": ">=3.11",
    "dependencies": ["rich", "requests"]
  }
  ```

  Plain JSON, no code execution.

## 4. Script-to-directory mapping

**Question:** Given a script (e.g. `c:\projects\demo.py`), how do we
compute the directory name for its env?

**Why it matters.** This is the *cache key*. The choice determines
whether the same script always gets the same env, whether different
scripts can share envs, and whether changing metadata invalidates the
mapping.

  - uv's choice: Script absolute path → same script always → same env.
  - pipx's choice: Dependency list → same deps always → same env.

**Decision:**

**Approach: pipx-style, deps-keyed cache, adapted to honor `requires-python`.**

### Reasons

1. **No sync operation needed.** Install/uninstall in place is unnecessary because the cache key changes whenever deps change. This is the structural win of pipx-style over uv-style.
2. Current pipx approach may let the temp envs grow fast but it's mitigated by Q7's TTL cleanup. We can always revisit if real-world growth is a problem.

### Hash inputs

- **Canonicalized, sorted, whitespace-normalized dependency list.**
  Three normalization passes before sorting and hashing:
  1. **PEP 503 name canonicalization** on the project name and on
     each extra: lowercase, then collapse runs of `[._-]` to a
     single `-`. Per PEP 503 this is the comparison rule pip / uv /
     PyPI use, so `Django`, `django`, `Django-Extensions`, and
     `django_extensions` are all the same project and
     `requests[Socks]` ≡ `requests[socks]`. Without this the cache
     fragments the moment a user changes casing or a copy-paste
     uses underscores instead of dashes.
  2. **Strip internal whitespace in the version specifier** so
     `"requests <3"` and `"requests<3"` collide.
  3. **Sort the resulting list alphabetically** so `["rich",
     "requests"]` and `["requests", "rich"]` produce the same hash.

  The version specifier itself is left case-sensitive (PEP 440
  local-version identifiers and pre-release markers are
  case-sensitive in general).
- **Absolute path to the chosen Python interpreter**
  (e.g. `c:\Python313\python.exe`). Including this means changing
  the interpreter (system reinstall, switching between two
  installed Pythons) automatically produces a new cache entry —
  free invalidation, no special-case logic.

### Hash function and directory shape

- **SHA-256, truncated to 15-16 hex chars.** Node `crypto` stdlib;
  no new dependencies.
- **Directory name:** bare hex (e.g. `eabe3fccc4258ef`). The hash
  is never shown in the UI; users find it via "Reveal in Explorer"
  if they ever need to.

### Honoring `requires-python` and validating cache hits

Pipx ignores `requires-python` entirely. We don't, because the IDE
experience (Pylance completions, Run, F5) depends on the interpreter
matching the script's declaration. Four pieces — steps 1–2 happen at
build time; steps 3–4 are cache-hit guards:

1. **At build time, pick a compatible interpreter.** Enumerate
   installed Pythons via `nativeFinder`, filter by
   `matchesPythonVersion(requiresPython, version)`,
   pick the newest match. If no installed Python satisfies the
   specifier, fall back to the existing `promptInstallPythonViaUv`
   flow (in [`src/managers/builtin/uvPythonInstaller.ts`](src/managers/builtin/uvPythonInstaller.ts))
   to ask the user to install a compatible Python via uv. If the
   user declines, surface a clear error and abort the build.

2. **Hash the chosen interpreter path into the cache key.** Catches
   "user reinstalled Python under the same path, version
   changed" and "metadata change switched us to a different
   installed Python".

3. **On cache hit, re-verify `requires-python` is still satisfied.**
   Before returning a cached env, check
   `matchesPythonVersion(metadata.requiresPython, env.version)`.
   If it now fails (e.g. metadata tightened from `>=3.11` to
   `==3.11.7` while the interpreter is 3.11.9), treat as a cache
   miss and rebuild. Catches the edge where deps and interpreter
   path are unchanged but the version specifier became stricter.

4. **On cache hit, verify the base interpreter still exists on
   disk.** Stat the env's launcher — POSIX: `bin/python` (follows
   the symlink); Windows: parse `home = ...` out of `pyvenv.cfg`
   and stat `<home>\python.exe`. If the target file is gone, treat
   as a cache miss and rebuild against a fresh interpreter pick
   from step 1. Common triggers: `pyenv uninstall 3.11.7`,
   `uv python uninstall 3.11`, `brew uninstall python@3.11`,
   `apt remove python3.11`, Windows uninstall via Add/Remove
   Programs. Step 2's path hash does **not** catch this case — the
   recorded path is unchanged; only the file at the path is gone.
   Cost is one `fs.stat` per cache hit.

### Display name in status bar

Match the existing venv convention: `Python 3.13.7 (inline)`

## 5. Reuse vs create

**Question:** When do we reuse an existing env, when do we throw it
away and rebuild?

**Decision.**

There are only two outcomes — **reuse** or **build fresh**. There is
no "sync" or "delta install" path. The table below confirms each
case lands in the right bucket.

> **Note:** "Build fresh" describes *what happens when the user
> invokes env creation* (via the picker entry in Q8 or the bulk
> command in Q8).

| Change | Outcome |
|---|---|
| Nothing changed; user re-opens the script | **Reuse** — cache key unchanged, directory exists |
| User adds, removes, or repins a dep | **Build fresh** — cache key changes |
| User changes `requires-python` (compatible interpreter still selectable) | **Reuse** if the same interpreter is picked; **build fresh** if a different interpreter is now picked. Q4 step 3 catches the rare "specifier tightened past the cached interpreter" case and forces a rebuild. |
| User changes `requires-python` (no compatible interpreter installed) | Q4 step 1's `promptInstallPythonViaUv` fallback fires; build proceeds after install or aborts on user decline. |
| User moves / renames the script | **Reuse** — cache is deps-keyed, not path-keyed. Cross-script reuse is the intended behavior. |
| Someone `pip uninstall`s a package externally | **Reuse the (now-broken) env.** Script fails at runtime with `ModuleNotFoundError`. User can recover via `Python Envs: Clear Script Environment Cache` (see Q7). |
| Someone `pip install`s an extra package externally | **Reuse.** Extra package survives until the env hits the TTL. |

**What triggers the cache lookup?**

Lazy / on-demand. The cache lookup is performed inside `getEnvironment(scriptUri)`. Every consumer that asks "what's the env for this URI?" naturally triggers it. The existing API surface does the work.


## 6. Association persistence

**Question:** After we create the env for `demo.py`, where do we
remember "`demo.py` uses env at `<cache>/script-envs-v1/demo-b5849...`"?
What happens if the user explicitly selects a different env later?

**Decision (revised during implementation).**

Inline-script associations use a **dedicated persistence layer**, not
`VenvManager`'s. The original plan was to reuse
`setEnvironment(scriptUri, env, true)` → `VenvManager.set` unchanged with
"no new persistence code," but that proved insufficient: venv persistence
is a plain `fsPath → env` map with no notion of the script's *content*,
whereas an inline-script association must invalidate itself when the
script's metadata changes (the second question above, and a core UX
requirement).

### Storage: a dedicated inline-script layer

The inline-script manager owns its own state, independent of the venv
layers:

| Layer | Where | Lifetime |
|---|---|---|
| In-memory maps | `InlineScriptEnvManager.fsPathToEnv` / `fsPathToPersistedAssociation` | Per session |
| Persistent state | `InlineScriptAssociationStore` (workspace `Memento` keyed by `INLINE_SCRIPT_ENVS_KEY`, with a serialized read-modify-write queue) | Across restarts |

Each persisted record (`PersistedAssociationRecord`) stores the
environment path **plus a metadata-identity binding** — a normalized
identity of the script's `dependencies` + `requires-python`
(`getInlineScriptMetadataRoutingIdentity`, whose SHA-256 is also recorded
in the cache entry's `.meta.json` `sourceMetadataIdentityHashes`). On
activation the manager rehydrates these records and re-validates them
against the current on-disk metadata and the cached env's sidecar before
the association becomes routeable; a binding is `pending` (persisted but
not yet proven to match the current cache entry) or `matched`.

This binding is exactly what delivers invalidation: editing
`dependencies` / `requires-python`, renaming, or deleting the script makes
the current metadata identity stop matching the bound one,
`InlineScriptRoutingRegistry.shouldRoute` returns `false`, and the script
falls back to the workspace/default env (and the setup CodeLens returns).

> The separate `python-envs.pythonProjects[]` entry (Phase 3 PR 10) is a
> **user-visible project registration**, not the routing source of truth.
> Routing survives restart via the association store above; the managed
> project entry is deliberately ignored by exact-manager resolution
> (`getExactProjectEnvironmentManager` returns `undefined` for it) and
> no-ops for scripts opened outside a workspace folder.

## 7. Cleanup

**Question:** When and how do envs get removed from the cache? Without
cleanup, the cache grows unbounded.

**Decision.**

- **Explicit user command** — `Python Envs: Clear Script Environment
  Cache` from the command palette. Modal confirmation, then deletes
  the entire bucket. Reuses the existing `validateVenvRemovalPath`
  safety guards (refuses drive roots, shallow paths, anything without
  a `pyvenv.cfg`).

- **Opportunistic TTL, run once per session** — on the first
  inline-script env creation/lookup after activation, a guarded
  `runTtlEvictionOnce` walks the cache directory a single time (not on
  "every handler run"). For each cached env whose `.meta.json` sidecar
  shows a `lastUsedAt` (bumped on create and on reuse) older than the
  threshold (**14 days**, matching pipx), delete it — **except** entries
  that a live association still references, which are protected from
  eviction regardless of age (PR #1745). Only genuinely orphaned entries
  are reclaimed. This is TTL cleanup, not a sync of associations (see Q5,
  which keeps associations sticky).

---

## 8. UX flows

**Question:** How does the user create envs — for a single script, and
for many scripts at once?

**Decision**

- **Bulk creation** — user runs `Python Envs: Set Up Environments for Inline Script Files` from the command palette to discover all of them, list every detected inline-script files in a multi-select quick-pick.

- **Single-script creation entry point** — show one CodeLens only when
  the active file is a PEP 723 script with parsed metadata and no
  matching inline env is currently associated. Ordinary `.py` files
  and scripts already bound to an up-to-date inline env see no
  CodeLens.

  The CodeLens is anchored to the first line of the `# /// script`
  block:

  ```
  📦 Set up environment for this script
  # /// script
  # dependencies = ["requests"]
  # ///
  ```

  Clicking it creates or reuses the inline environment, persists the
  per-script association, registers the exact script project, and
  publishes the script's active-environment change.

- **Status bar — no special treatment (Option A).** Before setup, the
  status bar continues to show the currently active workspace/default
  environment, exactly as it does for any other `.py` file. The
  CodeLens carries setup discoverability.

  After setup succeeds, the existing status-bar lookup for the active
  document naturally resolves the new per-script environment and shows
  the normal inline display name, for example
  `Python 3.13.7 (inline)`. No status-bar-specific implementation is
  required.

  If setup is cancelled or fails, the current environment remains
  active and the CodeLens remains available. If saved inline metadata
  later changes so the associated environment is stale, inline routing
  is invalidated, the status bar falls back to the workspace/default
  environment, and the CodeLens becomes available again.

The first rollout does not add a special `Select Interpreter`
top-level item or a separate status-bar treatment PR. Those surfaces
can be reconsidered from feedback if the CodeLens is not discoverable
enough.

## 9. Pylance

**Question:** How does Pylance pick up the env so `import rich` resolves
and hover/completions work?

**Decision:**

We register the script-to-env association on our side (per Q6). On its
own that is **not sufficient** — Pylance did not query per-file env for
regular `.py` files, so the per-file mapping is invisible to it. Closing
the gap required a contained Pylance-side change (PR #9265). The
primitive already existed for notebook cells; we extended it to regular
`.py` files and — importantly — reused the **existing**
configuration-change signal rather than adding a new notification.

### Pylance change, as implemented (PR #9265)

In `pylance-internal` and `vscode-pylance`:

1. **Open-time per-file lookup —
   `documentWorkspaceResolver.getWorkspaceForFile`.** For a regular
   `.py` file, query per-file `pythonPath` via the existing
   `workspace/configuration` request scoped to the file URI. If it
   equals the workspace's interpreter, the file shares the workspace's
   analysis — no sub-workspace, no extra cost. If it differs, the file
   is *mimicked* into an immutable workspace pinned to that interpreter
   (`_mimicOpenFiles` / `_getOrCreateImmutableCopy`), and
   `_filterResultsToCurrentWorkspace` keeps diagnostics attributed to
   the correct workspace. `import rich` then resolves against the inline
   env's `site-packages`.
2. **Change-time re-route via the existing config signal — not a new
   notification.** When the user creates / removes an inline env we fire
   `onDidChangeEnvironment(scriptUri)`; the Pylance client already
   forwards that as a `workspace/didChangeConfiguration`
   (`pythonEnvironmentApi.ts` → `notifySettingChanges`). On
   `_onDidChangeConfiguration`, `_revalidateOpenRegularFiles`
   (asyncServer) enumerates the open regular files and calls
   `revalidateWorkspaceForFile` (documentWorkspaceResolver), which
   re-runs the per-file lookup and re-homes each file, releasing the
   old-generation owner via `removeRegularFileOwner` (wrapped in
   `try/finally` so the owner is released even if the lookup throws).
3. **PR 18's dedicated `python/didChangeFilePythonPath` notification is
   therefore optional.** The existing `didChangeConfiguration` path
   already delivers correct re-routing; a targeted single-file
   notification would only be a later *performance* optimization (avoid
   re-scanning all open files), not a correctness requirement.

### Behavior in both branches

- **No inline env registered (fallback case)** —
  `getEnvironment(scriptUri)` walks parents and returns the
  workspace folder's env. The per-file pythonPath equals the
  workspace's, the equality check skips sub-workspace creation, and
  the file is analyzed in the workspace env exactly as today.
  **Zero behavior change.**
- **Inline env registered** — `getEnvironment(scriptUri)` returns
  the inline env. The pythonPath differs from the workspace's, an
  immutable sub-workspace is created pinned to the inline env's
  interpreter, and the file is analyzed against that env's
  `site-packages`. `import rich` resolves.

### What we need to do on the Python Envs side

- After the env is materialized (created or reused), record the
  association in the inline-script store (per Q6) so it survives Code
  restart. Routing is driven by that store — **not** by the
  `python-envs.pythonProjects[]` entry, which is only user-visible
  project registration.
- The per-file re-route event fires from the **inline-script manager's
  own selection** (`onDidChangeEnvironment(scriptUri)` with
  `e.uri = scriptUri`), which the Pylance client forwards as a
  configuration change. This does not depend on PR 10 emitting the
  event.
- Package changes are handled by re-creating / re-resolving the env
  (Q5 keeps associations sticky rather than syncing in place), so the
  env reference changes and the normal change signal already reaches
  Pylance; no special in-place "sync then fire" path is required.

## 10. Run / Debug

**Question:** How do the green Run button and F5 (Run-and-Debug)
discover our env?

**Decision:**

The story splits in two:

- **Run Python File (green triangle / `Commands.Exec_In_Terminal`)** —
  already routes per-file on `ms/main`; works once the association is
  registered. **Caveat:** this per-file routing applies only when the
  Environments extension owns interpreter resolution, i.e.
  `python.useEnvironmentsExtension` is enabled (`useEnvExtension()`).
  The whole feature is scoped to that mode; behavior with the setting
  off is explicitly out of scope.
- **F5 / Debug-in-Terminal** — does **not** route per-file on `ms/main`:
  the debug-config resolver passes the *workspace folder* URI to
  `getActiveInterpreter`, so the per-file env is invisible. This needs a
  real fix in `vscode-python` (PR #26129), and it is **more than the
  "~10 LOC" originally estimated**. It threads an `exactResource` (the
  program/file URI) through debug interpreter resolution, resolves
  `${file}` / `${workspaceFolder}` to choose the lookup scope, sets
  `__pythonIsProgramInterpreter` so `launch.ts` forces activation of the
  per-file env, and includes a matching change in the Pylance-hosting
  middleware (`NodeLanguageClientMiddleware`) because vscode-python hosts
  Pylance via `NodeLanguageServerManager`. It remains a **pre-existing
  gap**, not a PEP 723 regression.

### vscode-python change, as implemented (PR #26129)

`getInterpreterForDebugConfiguration` (in the debug config resolver
`base.ts`) resolves `${file}` / `${workspaceFolder}` to an absolute
program path, then looks up the interpreter **scoped to that file**
(`getActiveInterpreter(programUri, { exactResource: true })`) instead of
only the workspace folder. When the per-file env differs from the
workspace env it sets `__pythonIsProgramInterpreter`, which `launch.ts`
uses to force activation of that env:

```typescript
// base.ts — getInterpreterForDebugConfiguration(workspaceFolder, debugConfiguration)
const programUri = this.getProgramUri(configuredProgram, programWorkspaceFolder);
if (programUri) {
    const programInterpreter =
        await this.interpreterService.getActiveInterpreter(programUri, { exactResource: true });
    if (programInterpreter) {
        const workspaceInterpreter =
            await this.interpreterService.getActiveInterpreter(workspaceFolder, { exactResource: true });
        if (!workspaceInterpreter || !arePathsSame(programInterpreter.path, workspaceInterpreter.path)) {
            debugConfiguration.__pythonIsProgramInterpreter = true; // launch.ts forces env activation
        }
        return programInterpreter;
    }
}
return this.interpreterService.getActiveInterpreter(workspaceFolder); // fallback: unchanged behavior
```

Because vscode-python hosts Pylance itself (via `NodeLanguageServerManager`
/ `NodeLanguageClientMiddleware`), the shared middleware base
(`languageClientMiddlewareBase.ts`) applies the same per-file
`{ exactResource: true }` lookup for `.py` files, so the debug and
language-server views of the interpreter stay consistent. Both call sites
note that `exactResource` is a **no-op unless the Environments extension
owns resolution** — the same `useEnvironmentsExtension` gating called out
for Run above.

### What we need to do on the Python Envs side

- One association registration (per Q6) covers Pylance, Run (on
  `ms/main`), and Debug (with PR #26129) — no per-surface wiring.
- Optionally register each cached inline env at activation as a
  discoverable interpreter (`api.createPythonEnvironmentItem(...)`) so
  the Select Interpreter quick-pick can list them under "Inline script
  environments" as a manual recovery path. This is a nice-to-have, not
  required for Run / Debug / Pylance to work.

## 11. Telemetry

**Question:** What telemetry events do we emit so we can tell if the
feature is working?

**Decision.** 

| Event | Properties | When fired |
|---|---|---|
| `inlineScript.detected` | trigger (open / save / scan), hasRequiresPython, depCount | Once per (URI, session) on first detection |
| `inlineScript.envCreated` | trigger, durationMs, basePythonVersion, depCount, success | After every creation attempt |
| `inlineScript.envReuseHit` | n/a | When ensureEnv finds a usable existing env, no work needed |
| `inlineScript.envError` | category (no-compatible-python / install-failure / network / lock-timeout) | On creation/sync failure |
