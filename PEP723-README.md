# Try PEP 723 inline scripts in VS Code

PEP 723 lets a Python script list its Python version and dependencies **inside the file itself**. VS Code can then set up an environment for that script, without you manually creating a `.venv` or installing each package.

## 1. Get the right extensions

Use the **Python Environments build shared by the team that includes this feature**. If it is provided as a `.vsix` file, install it using **Extensions: Install from VSIX...** in the Command Palette.

Also use compatible **Python** and **Pylance** extension builds. Older versions may create the environment successfully but not use it correctly for running the file or checking imports. If an update notification appears after setup, update the named extensions and reload VS Code.

For the easiest first try, have **Python 3.11 or newer** installed and an internet connection for downloading packages. You do not need to install the example's packages yourself.

## 2. Turn on the feature

Open a new, empty folder in VS Code so you can experiment without changing an existing project.

Open the Command Palette with **Ctrl+Shift+P** on Windows/Linux or **Cmd+Shift+P** on macOS. Run **Preferences: Open User Settings (JSON)** and add these entries to your existing settings:

```json
{
    "python.useEnvironmentsExtension": true,
    "python-envs.inlineScripts.enabled": true
}
```

Keep your other settings; do not replace the whole file with this example.

Then run **Developer: Reload Window**.

**Note:** `python-envs.inlineScripts.enabled` is currently an internal preview setting. VS Code may underline it as an unknown setting; that is expected for this build. Reloading is required.

## 3. Create a sample script

Create a file named `hello_inline.py` inside the folder, paste this code, and **save it**:

```python
# /// script
# requires-python = ">=3.11"
# dependencies = ["rich"]
# ///

import sys
from rich import print

print("[bold green]PEP 723 is working![/bold green]")
print("Python:", sys.executable)
print("Version:", sys.version.split()[0])
```

The comment block says: "This script needs Python 3.11 or newer and the `rich` package." Keep both `# ///` markers exactly as shown, with the block near the top of the file.

**What you should see:** a small **Set up environment for this script** link above the comment block. The link is shown for saved files, so save again if you have unsaved edits.

Simply opening the file does not install its dependencies; you choose when to start setup.

## 4. Set up the environment

Click **Set up environment for this script**.

VS Code will look for a compatible Python, create or reuse a cached environment, and install the declared dependencies. If a suitable Python is missing, it may ask permission to install one; read the prompt before approving.

When setup finishes, you should briefly see **Script environment ready (Python ...)**. That message disappears after a few seconds; this is normal. The setup link should also disappear while the saved script has a valid environment.

With compatible Python and Pylance builds, the file should now use its script environment. If `rich` previously had a missing-import warning, that warning should clear after analysis updates.

## 5. Run it

Keep `hello_inline.py` open and run **Python: Run Python File in Terminal** from the Command Palette.

You should see:

```text
PEP 723 is working!
Python: <path to the script environment's Python>
Version: <a compatible Python version>
```

The first line should be green. The Python path should point into the extension's cached script environment, typically containing **`script-envs-v1`**. You should not need a `.venv` folder beside the script.

Use the Python extension's **Run Python File in Terminal** command for this check. Manually typing `python hello_inline.py` in an existing terminal may use that terminal's old interpreter instead.


## 6. Set up several scripts at once

If your folder contains several PEP 723 scripts, you do not have to open each file and click its setup link separately.

1. Save the scripts you want to try. Each should have its own `# /// script` block.
2. Open the Command Palette and run **Python Envs: Set Up Environments for Inline Script Files**.
3. Choose the scripts from the list. Scripts that need setup are selected by default; scripts with a valid environment are marked **environment already set up** and are not selected by default.
4. Confirm your selection and wait for setup to finish. Read and approve any installation prompts you want to proceed with.

VS Code sets up the selected scripts one after another and reports how many succeeded. This command prepares their environments; it does **not** run the scripts. Open a script and use **Python: Run Python File in Terminal** when you are ready to run it.

If you cancel an in-progress installation, the remaining scripts in that batch are not started.

## 7. Clear the cached script environments

Use **Python Envs: Clear Inline Script Environment Cache** when you want a fresh start or want to repeat the setup experience from scratch.

1. Wait for any environment setup to finish, and stop scripts using the cached environments.
2. Open the Command Palette and run **Python Envs: Clear Inline Script Environment Cache**.
3. Read the confirmation and choose **Clear Cache** if you want to proceed.

**This clears all cached inline-script environments in the extension's cache, not just the active script's environment.** It also forgets their saved script associations and removes managed inline-script project entries from settings. Other scripts sharing those cached environments will need setup again.

Your `.py` files and their dependency blocks stay in place. The command does not uninstall your base Python installation.

After clearing, the setup link should appear again for scripts that need an environment. You can set them up individually or use the bulk setup command above. Packages may need to be downloaded again.

## Turn off the preview

Set `python-envs.inlineScripts.enabled` to `false` and run **Developer: Reload Window**.
