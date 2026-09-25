# Contributing to Python Environments Extension

Thank you for your interest in contributing to the Python Environments extension! This guide will help you get started.

## Prerequisites

- Node.js (LTS version recommended)
- npm
- VS Code Insiders (recommended for development)
- Git
- Python

## Getting Started

1. **Clone the repository**
   ```bash
   cd vscode-python-environments
   ```

2. **Create a Python virtual environment**

   A Python virtual environment is important for development because it isolates the Python dependencies used for testing and development from your system Python installation. This ensures reproducible builds and prevents conflicts with other projects.

   **Using the Python Environments extension (recommended):**

   1. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
   2. Run **Python: Create Environment**
   3. Select **Venv** as the environment type
   4. Choose your preferred Python interpreter
   5. The extension will create the `.venv` folder and configure your workspace automatically

   **Alternatively, from the command line:**

   ```bash
   # Create the virtual environment
   python -m venv .venv

   # Activate it (Linux/macOS)
   source .venv/bin/activate

   # Activate it (Windows - Command Prompt)
   .venv\Scripts\activate.bat

   # Activate it (Windows - PowerShell)
   .venv\Scripts\Activate.ps1
   ```

   > **Note:** Keep the virtual environment activated while developing. The extension uses this environment for running Python-related tests and for environment discovery during development.


3. **Install dependencies**
   ```bash
   npm install
   ```

4. **Build and watch**
   ```bash
   npm run watch
   ```

5. **Run tests**
   ```bash
   npm run unittest
   ```

## Development Workflow

### Running the Extension

1. Open the project in VS Code
2. Press `F5` to launch the Extension Development Host
3. The extension will be loaded in the new VS Code window

### Making Changes

- **Localization**: Use VS Code's `l10n` API for all user-facing messages
- **Logging**: Use `traceLog` or `traceVerbose` instead of `console.log`
- **Error Handling**: Track error state to avoid duplicate notifications
- **Documentation**: Add clear docstrings to public functions

### Testing
Run unit tests with the different configurations in the "Run and Debug" panel

`Run Extension` builds the extension through `npm: watch`. `Unit Tests` uses `npm: watch-tests`
to compile its TypeScript; the `npm: unittest` task depends on that same watcher.
Real-host smoke/E2E/integration launch configurations need both builds (`tasks: build`).

#### Python installer end-to-end tests (Windows)

The opt-in installer profile needs an already-installed Python Install Manager and uv. It never
bootstraps those tools. Build the extension and tests, and provide PET at
`python-env-tools\bin\pet.exe` (a generated, ignored dependency) before running the profile:

```powershell
npm run compile-tests
npm run compile
npm run smoke-test
npm run installer-e2e-test
```

This profile performs real runtime installations and package execution. Its driver creates a
marked, unique temporary root and separate VS Code user-data and installed-extension directories.
It does not load companion extensions from another test profile. PyManager receives a
per-command configuration that isolates its runtime, download, log and alias directories and
disables registry/Start-menu registrations. The uv installation uses an isolated directory with
`--no-bin` and `--no-registry`. Do not point the fixture at an existing user directory.
Automatic missing-Python prompts are disabled only in this owned test profile, so its first
installation does not require a pre-existing Python interpreter or interactive consent.

The profile requires **23 scenarios in the first host and 3 after restart**, with no skipped tests.
It prints each scenario's result and duration, and writes detailed `.host-report-install.json` and
`.host-report-reload.json` files inside the fixture. A missing, partial, or failed run is not success.

| Coverage | What runs |
|---|---|
| Runtime installation | Real PyManager installation, an approved update of a selected runtime, downgrade refusal, registry-independent Global discovery, and an isolated uv installation. |
| Native acquisition and cancellation | Real catalogue/runtime queries and Python probes; reuse and concurrent requests; picker cancellation; invalid/exact-version conflicts; cancellation before preflight, during preflight/postflight/probing, and at installation completion. Dialog answers and cancellation timing are controlled, not manually clicked. |
| Script workflows | A local wheel import; paths with spaces and Unicode; concurrent shared-cache setup; dependency edits; neighboring-file isolation; missing-wheel failure; execution in an actual integrated terminal. |
| Project venvs | Public API creation, package execution and removal with uv and standard-library venv backends. The tests verify `sys._base_executable` and `pyvenv.cfg`, not just that creation returned an object. |
| Restart and removal | A new VS Code process restores Global/per-script/shared-cache selections from disk; removal invalidates shared associations without deleting scripts or the base Python; setup rebuilds a working environment. |

The live workflows exercise the loaded extension through its commands and public API. The
controlled-native suite uses compiled source modules with real child processes; it does not mock
the manager's output or pretend that cancellation during an idempotent install tests interrupted
download/extraction. Mutations in that suite are restricted to the already-installed fixture release
with the isolated configuration. Native children must close before a scenario finishes.

The Python-output helper waits for process exit **and** both output streams to finish before parsing
results. Script-edit scenarios wait for the saved metadata's setup CodeLens instead of racing save
events. `python-envs.alwaysUseUv` is machine-scoped, so backend tests change it only in the fixture's
isolated **User** settings and restore it afterward; Workspace settings cannot override it.

PyManager remains installed throughout the profile. Absent-manager/non-Windows routing, empty-machine
startup, synthetic failures and other architectures are covered separately by unit tests, not by
physical platform runs here. The profile does not verify Python/Pylance companion UI, debugger
behavior, bulk-picker/clear-cache confirmation clicks, or cancellation during destructive extraction.

The driver uses a temporary test-runner extension in an ordinary development host: VS Code's
`--extensionTestsPath` mode deliberately keeps Memento storage in memory, so it cannot verify
cross-process persistence. User data, installed extensions and shared application data are all
isolated inside the fixture; secret storage is in memory.

Each host has a fifteen-minute outer limit; individual scenarios also have bounded timeouts.
Successful fixtures (including their reports) are removed after VS Code exits, so redirect the
command's output to a log if you need to keep the per-scenario results. A failed run retains its printed fixture
location for diagnosis, since an interrupted installer may still be doing background work. Confirm
that its processes have stopped before removing that specific directory.

## Contributor License Agreement (CLA)

This project requires contributors to sign a Contributor License Agreement (CLA). When you submit a pull request, a CLA bot will automatically check if you need to provide a CLA and guide you through the process. You only need to do this once across all Microsoft repositories.

## Code of Conduct

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/). For more information, see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with questions.

## Public API package (`@vscode/python-environments`)

The npm package under [`api/`](./api) is the public API facade other extensions consume. Its sources — `api/src/main.ts`, `api/src/types.ts`, and `api/src/publicErrors.ts` — are **copies** of [`src/api.ts`](./src/api.ts), [`src/types.ts`](./src/types.ts), and [`src/publicErrors.ts`](./src/publicErrors.ts) respectively — the single sources of truth — and are **not committed** (see [`api/.gitignore`](./api/.gitignore)).

- Edit the public API only in `src/api.ts` (the runtime facade: `PythonEnvironments.api()` helper and `EXTENSION_ID`), `src/types.ts` (public contracts: interfaces, types, enums), and `src/publicErrors.ts` (concrete public error classes and type guards). `api/src/*.ts` files are build artifacts — never edit or commit them.
- `api/src/main.ts`, `api/src/types.ts`, and `api/src/publicErrors.ts` are produced by the publish pipeline ([`build/azure-pipeline.npm.yml`](./build/azure-pipeline.npm.yml)), which copies `src/api.ts` to `api/src/main.ts`, `src/types.ts` to `api/src/types.ts`, and `src/publicErrors.ts` to `api/src/publicErrors.ts` before compiling. The api package is therefore built in CI only; to build it locally, copy the files first (e.g. `cp src/api.ts api/src/main.ts && cp src/types.ts api/src/types.ts && cp src/publicErrors.ts api/src/publicErrors.ts`).
- `src/api.ts`, `src/types.ts`, and `src/publicErrors.ts` are validated on every PR by the extension's own lint and TypeScript compile.
- **Versioning and compatibility:** the published package version in [`api/package.json`](./api/package.json) is maintained independently of the extension version in [`package.json`](./package.json) — the two do not need to match. Compatibility is based on the API shape exported by the installed Python Environments extension at runtime. Package updates must preserve backwards-compatible contracts unless the API package version intentionally communicates a breaking change; consumers should treat newly added members as optional when they may run against older installed extension versions. Any PR that edits `src/api.ts`, `src/types.ts`, or `src/publicErrors.ts` must bump `api/package.json` (use the `skip api version` label to bypass) and add an entry to [`api/CHANGELOG.md`](./api/CHANGELOG.md) (use the `skip api changelog` label to bypass).

## Questions or Issues?

- **Questions**: Start a [discussion](https://github.com/microsoft/vscode-python/discussions/categories/q-a)
- **Bugs**: File an [issue](https://github.com/microsoft/vscode-python-environments/issues)
- **Feature Requests**: Start a [discussion](https://github.com/microsoft/vscode-python/discussions/categories/ideas)

## Additional Resources

- [Development Process](https://github.com/Microsoft/vscode-python/blob/main/CONTRIBUTING.md#development-process)
- [API Documentation](./src/api.ts)
- [Project Documentation](./docs/projects-api-reference.md)

Thank you for contributing! 🎉
