import * as cp from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

// ─── Constants ────────────────────────────────────────────────────────────────

/** HTML comment marker that denotes the beginning of the injected block inside workbench.html. */
const INJECTION_START = "<!-- cursor-auto-hide:start -->";

/** HTML comment marker that denotes the end of the injected block inside workbench.html. */
const INJECTION_END = "<!-- cursor-auto-hide:end -->";

/** `globalState` key used to persist the currently injected hide-delay value (in seconds). */
const STATE_DELAY = "cursorAutoHide.injectedDelay";

/** `globalState` key used to persist whether the injection is currently active. */
const STATE_ENABLED = "cursorAutoHide.injected";

// ─── Module state ─────────────────────────────────────────────────────────────

/** VS Code output channel used for all extension-level log messages. */
let outputChannel: vscode.OutputChannel | undefined;

/** Disposable for the active `onDidChangeConfiguration` listener. Replaced on every re-registration. */
let configDisposable: vscode.Disposable | undefined;

/** Filename of the external JavaScript file written next to workbench.html. */
const SCRIPT_FILENAME = "cursor-auto-hide.js";

/** Filename of the runtime configuration JSON file read by the injected script. */
const CONFIG_FILENAME = "cursor-auto-hide-config.json";

// ─── Entry Points ─────────────────────────────────────────────────────────────

/**
 * Called by VS Code when the extension is first activated.
 *
 * Creates the output channel, then runs the full injection setup pipeline.
 * Any unhandled error is caught, logged to the output channel, and surfaced
 * to the user as an error notification.
 *
 * @param ctx - The extension context provided by VS Code, used for subscription
 *   management and persistent global state storage.
 */
export function activate(ctx: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel("Cursor Auto Hide");
  ctx.subscriptions.push(outputChannel);

  setup(ctx).catch((err: unknown) => {
    log(`activate error: ${String(err)}`);
    vscode.window.showErrorMessage(`Cursor Auto Hide: ${String(err)}`);
  });
}

/**
 * Called by VS Code when the extension is deactivated or the editor is closing.
 *
 * Disposes the configuration-change listener and the output channel to prevent
 * resource leaks. After disposal, `outputChannel` is set to `undefined` so
 * subsequent log calls are silently ignored.
 */
export function deactivate(): void {
  configDisposable?.dispose();
  outputChannel?.dispose();
  outputChannel = undefined;
}

// ─── Core Logic ───────────────────────────────────────────────────────────────

/**
 * Main setup routine that evaluates the current extension configuration and
 * synchronises the state of the HTML injection accordingly.
 *
 * Execution flow:
 * 1. Reads `enabled` and `delay` from the VS Code workspace configuration.
 * 2. If the extension is disabled, removes any existing injection and returns.
 * 3. Resolves the path to VS Code's `workbench.html`; warns and returns if not found.
 * 4. Compares the on-disk HTML, JS, and config files against the expected content.
 * 5. If everything is already up to date, fixes checksums/integrity storage defensively
 *    and returns without writing anything.
 * 6. Otherwise, delegates to {@link applyInjection} to write the necessary files.
 * 7. Registers a configuration-change listener so subsequent setting changes
 *    automatically re-trigger `setup`.
 *
 * @param ctx - The extension context used for global state persistence.
 */
async function setup(ctx: vscode.ExtensionContext): Promise<void> {
  const { enabled, delay } = getConfig();

  if (!enabled) {
    await ensureNoInjection(ctx);
    registerConfigListener(ctx);
    return;
  }

  const htmlPath = getWorkbenchHtmlPath();
  if (!htmlPath) {
    vscode.window.showWarningMessage(
      "Cursor Auto Hide: Could not find VS Code's workbench HTML. Only desktop VS Code is supported.",
    );
    registerConfigListener(ctx);
    return;
  }

  const jsPath = path.join(path.dirname(htmlPath), SCRIPT_FILENAME);
  const configPath = path.join(path.dirname(htmlPath), CONFIG_FILENAME);
  const fixedJs = buildInjectionScript();
  const expectedConfig = buildConfigJson(delay * 1000);
  const htmlCorrect = hasCorrectHtmlInjection(htmlPath);
  const jsCorrect = fs.existsSync(jsPath) && fs.readFileSync(jsPath, "utf8") === fixedJs;
  const configCorrect =
    fs.existsSync(configPath) && fs.readFileSync(configPath, "utf8") === expectedConfig;

  if (htmlCorrect && jsCorrect && configCorrect) {
    log("Injection up to date — feature active");
    // Defensive: always keep product.json SHA256 and integrityService storage in sync
    try {
      const html = fs.readFileSync(htmlPath, "utf8");
      fixChecksum(htmlPath, html);
    } catch {
      /* non-critical */
    }
    fixIntegrityServiceStorage();
    registerConfigListener(ctx);
    return;
  }

  await applyInjection(
    ctx,
    htmlPath,
    jsPath,
    configPath,
    delay,
    fixedJs,
    expectedConfig,
    htmlCorrect,
    jsCorrect,
  );
  registerConfigListener(ctx);
}

// `ctx.subscriptions` へのpushは初回のみ。再登録時はdispose+差し替えのみで
// subscriptionsへのpushは行わない（deactivate()のconfigDisposable?.dispose()で解放）

/**
 * Guards against pushing more than one wrapper into `ctx.subscriptions`.
 * Set to `true` after the first call to {@link registerConfigListener}.
 */
let configRegistered = false;

/**
 * Registers (or re-registers) the `onDidChangeConfiguration` listener that
 * triggers a fresh {@link setup} run whenever a `cursorAutoHide.*` setting changes.
 *
 * - Any previously registered listener is disposed before creating a new one,
 *   ensuring only one active listener exists at a time.
 * - A cleanup wrapper is pushed into `ctx.subscriptions` only on the first call
 *   so that VS Code's deactivation path can dispose the listener reliably.
 *
 * @param ctx - The extension context whose `subscriptions` array receives the
 *   one-time cleanup entry.
 */
function registerConfigListener(ctx: vscode.ExtensionContext): void {
  configDisposable?.dispose();
  configDisposable = vscode.workspace.onDidChangeConfiguration(async (e) => {
    if (!e.affectsConfiguration("cursorAutoHide")) return;
    configDisposable?.dispose();
    await setup(ctx);
  });
  if (!configRegistered) {
    ctx.subscriptions.push({ dispose: () => configDisposable?.dispose() });
    configRegistered = true;
  }
}

// ─── Injection Lifecycle ──────────────────────────────────────────────────────

/**
 * Writes the injection files to VS Code's application directory and prompts
 * the user to reload or fully restart the editor.
 *
 * Behaviour depends on what changed:
 * - **HTML or JS changed** (first install or migration): rewrites `workbench.html`,
 *   updates `product.json` checksums, writes the external JS file, and prompts the
 *   user to *quit and restart* VS Code (a full restart is required because the
 *   main-process checksum cache is stale after an HTML change).
 * - **Config only changed** (delay update): only writes `cursor-auto-hide-config.json`
 *   and prompts for a *window reload* — HTML/JS/SHA-256 are untouched so a lightweight
 *   reload is sufficient.
 *
 * In both cases `globalState` is updated and the integrity-service SQLite entry is
 * patched to suppress the "Your installation appears corrupt" warning.
 *
 * @param ctx - The extension context used for global state persistence.
 * @param htmlPath - Absolute path to VS Code's `workbench.html`.
 * @param jsPath - Absolute path where the injected JS file should be written.
 * @param configPath - Absolute path where the runtime config JSON should be written.
 * @param delay - Hide delay in seconds, stored in global state for reference.
 * @param fixedJs - The full content of the injected JS file to write.
 * @param newConfig - The serialised JSON content to write to the config file.
 * @param htmlAlreadyCorrect - Whether `workbench.html` already contains the expected injection.
 * @param jsAlreadyCorrect - Whether the external JS file already matches `fixedJs`.
 */
async function applyInjection(
  ctx: vscode.ExtensionContext,
  htmlPath: string,
  jsPath: string,
  configPath: string,
  delay: number,
  fixedJs: string,
  newConfig: string,
  htmlAlreadyCorrect: boolean,
  jsAlreadyCorrect: boolean,
): Promise<void> {
  try {
    const needsHtmlOrJsUpdate = !htmlAlreadyCorrect || !jsAlreadyCorrect;

    if (needsHtmlOrJsUpdate) {
      // HTML or fixed JS needs to be written (first install or migration)
      let html = fs.readFileSync(htmlPath, "utf8");
      html = stripInjection(html);
      const injection = buildFileInjection();
      html = html.replace("</head>", `${INJECTION_START}\n${injection}\n${INJECTION_END}\n</head>`);
      fs.writeFileSync(htmlPath, html, "utf8");
      fixChecksum(htmlPath, html);
      fs.writeFileSync(jsPath, fixedJs, "utf8");
      log("HTML + JS injection updated");
    }

    // Always write config (delay may have changed); config is read at runtime via fetch
    fs.writeFileSync(configPath, newConfig, "utf8");
    log(`Config updated (delay=${delay}s)`);

    await ctx.globalState.update(STATE_DELAY, delay);
    await ctx.globalState.update(STATE_ENABLED, true);
    fixIntegrityServiceStorage();

    if (needsHtmlOrJsUpdate) {
      // HTML changed → main-process checksum cache is stale → full restart needed
      const action = await vscode.window.showInformationMessage(
        "Cursor Auto Hide: Applied. Please quit and restart VS Code to activate.",
        "Quit VS Code",
      );
      if (action === "Quit VS Code") {
        await vscode.commands.executeCommand("workbench.action.quit");
      }
    } else {
      // Only config changed (delay update) → safe to reload (HTML/JS/SHA256 unchanged)
      const action = await vscode.window.showInformationMessage(
        "Cursor Auto Hide: Settings updated. Reload to apply.",
        "Reload Now",
      );
      if (action === "Reload Now") {
        await vscode.commands.executeCommand("workbench.action.reloadWindow");
      }
    }
  } catch (e) {
    const msg = `Failed to apply injection: ${String(e)}`;
    log(msg);
    vscode.window.showErrorMessage(`Cursor Auto Hide: ${msg}`);
  }
}

/**
 * Removes a previously applied injection from `workbench.html` when the
 * extension is disabled via settings.
 *
 * Steps performed:
 * 1. Resolves `workbench.html`; returns early if not found or not injected.
 * 2. Strips the injection block from the HTML and rewrites the file.
 * 3. Updates `product.json` checksums to match the cleaned HTML.
 * 4. Deletes the external JS and config files if they exist.
 * 5. Clears the `STATE_ENABLED` and `STATE_DELAY` global state keys.
 * 6. Prompts the user to quit and restart VS Code to complete deactivation.
 *
 * @param ctx - The extension context used to clear persistent global state.
 */
async function ensureNoInjection(ctx: vscode.ExtensionContext): Promise<void> {
  const htmlPath = getWorkbenchHtmlPath();
  if (!htmlPath || !isInjectionPresent(htmlPath)) return;

  try {
    let html = fs.readFileSync(htmlPath, "utf8");
    html = stripInjection(html);
    fs.writeFileSync(htmlPath, html, "utf8");
    fixChecksum(htmlPath, html);

    // Remove the external JS and config files
    const jsPath = path.join(path.dirname(htmlPath), SCRIPT_FILENAME);
    if (fs.existsSync(jsPath)) fs.unlinkSync(jsPath);
    const configPath = path.join(path.dirname(htmlPath), CONFIG_FILENAME);
    if (fs.existsSync(configPath)) fs.unlinkSync(configPath);

    await ctx.globalState.update(STATE_ENABLED, false);
    await ctx.globalState.update(STATE_DELAY, undefined);
    log("Injection removed");

    const action = await vscode.window.showInformationMessage(
      "Cursor Auto Hide: Disabled. Quit and restart VS Code to fully deactivate.",
      "Quit VS Code",
    );
    if (action === "Quit VS Code") {
      await vscode.commands.executeCommand("workbench.action.quit");
    }
  } catch (e) {
    log(`Failed to remove injection: ${String(e)}`);
  }
}

// ─── HTML File Helpers ────────────────────────────────────────────────────────

/**
 * Resolves the absolute path to VS Code's `workbench.html` by probing a list
 * of known candidate locations across different VS Code versions and variants.
 *
 * Candidates checked (in order):
 * 1. `electron-browser/workbench/workbench.html` — modern VS Code (1.70+)
 * 2. `electron-sandbox/workbench/workbench.html` — sandboxed variant
 * 3. `vs/workbench/workbench.desktop.main.html`  — legacy fallback
 *
 * All candidates are logged regardless of existence to aid debugging.
 *
 * @returns The path of the first existing candidate, or `undefined` if none exist
 *   (e.g., when running in a web/remote context where the file is not present).
 */
function getWorkbenchHtmlPath(): string | undefined {
  const candidates = [
    // Primary: modern VS Code (1.70+)
    path.join(
      vscode.env.appRoot,
      "out",
      "vs",
      "code",
      "electron-browser",
      "workbench",
      "workbench.html",
    ),
    // Sandboxed variant
    path.join(
      vscode.env.appRoot,
      "out",
      "vs",
      "code",
      "electron-sandbox",
      "workbench",
      "workbench.html",
    ),
    // Legacy fallback
    path.join(vscode.env.appRoot, "out", "vs", "workbench", "workbench.desktop.main.html"),
  ];
  log(`appRoot=${vscode.env.appRoot}`);
  for (const c of candidates) log(`  candidate: ${c} exists=${fs.existsSync(c)}`);
  return candidates.find((p) => fs.existsSync(p));
}

/**
 * Checks whether the injection start marker is present in `workbench.html`.
 *
 * @param htmlPath - Absolute path to `workbench.html`.
 * @returns `true` if the file contains {@link INJECTION_START}, `false` otherwise
 *   (including when the file cannot be read).
 */
function isInjectionPresent(htmlPath: string): boolean {
  try {
    return fs.readFileSync(htmlPath, "utf8").includes(INJECTION_START);
  } catch {
    return false;
  }
}

/**
 * Verifies that `workbench.html` already contains the exact injection block
 * that would be written by the current version of the extension.
 *
 * Used by {@link setup} to skip unnecessary file writes when the injection is
 * already up to date (e.g., after a pure delay-only config change).
 *
 * @param htmlPath - Absolute path to `workbench.html`.
 * @returns `true` if the file contains both the injection start marker and the
 *   expected injection content, `false` otherwise (including read errors).
 */
function hasCorrectHtmlInjection(htmlPath: string): boolean {
  try {
    const html = fs.readFileSync(htmlPath, "utf8");
    const expectedInjection = buildFileInjection();
    return html.includes(INJECTION_START) && html.includes(expectedInjection);
  } catch {
    return false;
  }
}

/**
 * Removes all injection blocks (delimited by {@link INJECTION_START} /
 * {@link INJECTION_END}) from the given HTML string.
 *
 * Uses a non-greedy `[\s\S]*?` pattern so multiple blocks are each stripped
 * independently. A trailing newline after the end marker is also consumed.
 *
 * @param html - The raw HTML string from which to strip injections.
 * @returns The HTML string with all injection blocks removed.
 */
function stripInjection(html: string): string {
  return html.replace(
    new RegExp(`${escapeRegExp(INJECTION_START)}[\\s\\S]*?${escapeRegExp(INJECTION_END)}\\n?`, "g"),
    "",
  );
}

/**
 * Escapes all special RegExp metacharacters in a string so it can be safely
 * embedded inside a `RegExp` constructor without unintended pattern matching.
 *
 * @param s - The raw string to escape.
 * @returns The escaped string with all metacharacters prefixed by `\`.
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builds the HTML fragment that is inserted inside `<head>` during injection.
 *
 * The fragment consists of:
 * - An inline `<style>` element (id `cursor-auto-hide-style`) containing the
 *   CSS generated by {@link buildCSS}.
 * - A `<script>` element (id `cursor-auto-hide-script`) that loads the
 *   external JS file from {@link SCRIPT_FILENAME}.
 *
 * @returns The complete HTML string to embed between the injection markers.
 */
function buildFileInjection(): string {
  return (
    `<style id="cursor-auto-hide-style">\n${buildCSS()}\n</style>\n` +
    `<script src="./${SCRIPT_FILENAME}" id="cursor-auto-hide-script"></script>`
  );
}

// ─── Integrity Service Storage Fix (prevents "corrupt installation" warning) ───
/**
 * Updates VS Code's integrityService SQLite entry so the "Your installation appears corrupt"
 * notification is suppressed even when isPure() returns false (e.g., after Reload Window).
 * Uses Python3 subprocess since there's no direct SQLite API in the extension host.
 */
function fixIntegrityServiceStorage(): void {
  try {
    const productJsonPath = path.join(vscode.env.appRoot, "product.json");
    const productJson = JSON.parse(fs.readFileSync(productJsonPath, "utf8")) as {
      commit?: string;
      nameLong?: string;
    };
    const commit = productJson.commit;
    if (!commit) return;

    const appFolder = (productJson.nameLong ?? "Visual Studio Code").includes("Insiders")
      ? "Code - Insiders"
      : "Code";
    const dbPath = getStateDbPath(appFolder);
    if (!fs.existsSync(dbPath)) {
      log(`State DB not found: ${dbPath}`);
      return;
    }

    const newValue = JSON.stringify({ dontShowPrompt: true, commit });
    const py = [
      "import sqlite3,sys",
      "db=sqlite3.connect(sys.argv[1],timeout=3)",
      "c=db.cursor()",
      "c.execute('SELECT value FROM ItemTable WHERE key=\"integrityService\"')",
      "r=c.fetchone()",
      "v=sys.argv[2]",
      "c.execute('UPDATE ItemTable SET value=? WHERE key=\"integrityService\"',(v,)) if r else c.execute('INSERT INTO ItemTable(key,value) VALUES(\"integrityService\",?)',(v,))",
      "db.commit()",
      "db.close()",
    ].join(";");

    cp.execFileSync("python3", ["-c", py, dbPath, newValue], {
      timeout: 5000,
      stdio: "ignore", // prevent SIGPIPE
    });
    log(`Integrity storage fixed (commit=${commit.slice(0, 8)}…)`);
  } catch (e) {
    log(`Integrity storage fix skipped: ${String(e)}`);
  }
}

/**
 * Returns the platform-specific absolute path to VS Code's `state.vscdb` SQLite
 * database, which stores the `integrityService` key used by the corruption warning.
 *
 * Path conventions:
 * - **macOS**: `~/Library/Application Support/<appFolder>/User/globalStorage/state.vscdb`
 * - **Windows**: `%APPDATA%\<appFolder>\User\globalStorage\state.vscdb`
 * - **Linux / other**: `~/.config/<appFolder>/User/globalStorage/state.vscdb`
 *
 * @param appFolder - The VS Code application folder name (e.g., `"Code"` or
 *   `"Code - Insiders"`), derived from `product.json`.
 * @returns The absolute path to `state.vscdb` for the current platform.
 */
function getStateDbPath(appFolder: string): string {
  const home = os.homedir();
  switch (process.platform) {
    case "darwin":
      return path.join(
        home,
        "Library",
        "Application Support",
        appFolder,
        "User",
        "globalStorage",
        "state.vscdb",
      );
    case "win32":
      return path.join(
        process.env.APPDATA ?? home,
        appFolder,
        "User",
        "globalStorage",
        "state.vscdb",
      );
    default:
      return path.join(home, ".config", appFolder, "User", "globalStorage", "state.vscdb");
  }
}

// ─── Checksum Fix (prevents "corrupt installation" warning) ───────────────────

/**
 * Rewrites the SHA-256 checksum entry for `filePath` inside `product.json` so
 * that VS Code's `checksumService` considers the modified file legitimate.
 *
 * Algorithm:
 * 1. Reads `product.json` from `vscode.env.appRoot`.
 * 2. Derives the checksum key by computing the path of `filePath` relative to
 *    `appRoot` and stripping the leading `out/` segment (matching VS Code's
 *    internal key convention).
 * 3. Computes SHA-256 of the new file content, base64-encodes it, and removes
 *    trailing `=` padding characters (VS Code omits them).
 * 4. Replaces the old hash in `product.json` and writes the file back.
 *
 * The function is non-destructive on error: any exception is logged and silently
 * swallowed so that a checksum update failure never blocks the injection flow.
 *
 * @param filePath - Absolute path to the file whose checksum should be updated.
 * @param newContent - The new string content that has been (or will be) written
 *   to `filePath`, used to compute the updated SHA-256 hash.
 */
function fixChecksum(filePath: string, newContent: string): void {
  try {
    const productJsonPath = path.join(vscode.env.appRoot, "product.json");
    const productJson = JSON.parse(fs.readFileSync(productJsonPath, "utf8")) as {
      checksums?: Record<string, string>;
    };
    const relPath = path.relative(vscode.env.appRoot, filePath).replace(/\\/g, "/");
    // product.json checksum keys omit the leading 'out/' segment
    const checksumKey = relPath.replace(/^out\//, "");
    if (productJson.checksums?.[checksumKey] !== undefined) {
      // VS Code checksumService uses SHA256 base64 without trailing '='
      const newHash = crypto
        .createHash("sha256")
        .update(Buffer.from(newContent))
        .digest("base64")
        .replace(/=+$/, "");
      const oldHash = productJson.checksums[checksumKey];
      productJson.checksums[checksumKey] = newHash;
      fs.writeFileSync(productJsonPath, JSON.stringify(productJson, null, "\t"), "utf8");
      log(`Checksum updated for ${checksumKey}: ${oldHash.slice(0, 8)}… → ${newHash.slice(0, 8)}…`);
    } else {
      log(`Checksum key not found in product.json: ${checksumKey}`);
    }
  } catch (e) {
    log(`Checksum update skipped: ${String(e)}`);
  }
}

// ─── Config ───────────────────────────────────────────────────────────────────

/**
 * Reads the extension's workspace configuration and returns the resolved values.
 *
 * - `enabled` defaults to `true` if the setting is absent.
 * - `delay` is clamped to the range `[1, 30]` seconds and rounded to the nearest
 *   integer; defaults to `3` if the setting is absent.
 *
 * @returns An object containing the boolean `enabled` flag and the numeric
 *   `delay` value (in seconds, clamped and rounded).
 */
function getConfig(): { enabled: boolean; delay: number } {
  const cfg = vscode.workspace.getConfiguration("cursorAutoHide");
  return {
    enabled: cfg.get<boolean>("enabled", true),
    delay: Math.min(30, Math.max(1, Math.round(cfg.get<number>("delay", 3)))),
  };
}

// ─── Logging ──────────────────────────────────────────────────────────────────

/**
 * Appends a prefixed message to the extension's output channel.
 *
 * All messages are prefixed with `[cursor-auto-hide]` for easy filtering.
 * If the output channel has not yet been created (or has already been disposed),
 * the call is silently ignored.
 *
 * @param msg - The message string to append.
 */
function log(msg: string): void {
  outputChannel?.appendLine(`[cursor-auto-hide] ${msg}`);
}

// ─── CSS ──────────────────────────────────────────────────────────────────────

/**
 * Generates the CSS string that is embedded in `workbench.html` to implement
 * the cursor-hiding behaviour.
 *
 * The CSS is structured in five layers applied when `<html>` has the class
 * `cursor-autohide-hidden`:
 *
 * 1. **Visual hide + event block** — sets `cursor: none` and
 *    `pointer-events: none` on the root and all descendants.
 * 2. **Monaco hover region suppression** — explicitly blocks pointer events on
 *    `.margin` and `.view-lines` to prevent new mouse-triggered hover widgets.
 * 3. **Hide already-rendered hover UI** — hides `.monaco-tooltip` and overflow
 *    content widgets that were rendered before the cursor was hidden.
 * 4. **Keyboard hover exemption** — restores `pointer-events: auto` on the
 *    overflow container so keyboard-triggered hovers (e.g., `editor.action.showHover`)
 *    can still appear.
 * 5. **Overlay exemptions** — keeps interactive UI elements (dialogs, menus,
 *    quick-input, inputs, etc.) fully interactive even while the cursor is hidden.
 *
 * @returns The trimmed CSS string ready to be embedded inside a `<style>` element.
 */
function buildCSS(): string {
  return `
/* === Cursor Auto Hide: Layer 1 — visual hide + event block === */
html.cursor-autohide-hidden,
html.cursor-autohide-hidden * {
  cursor: none !important;
  pointer-events: none !important;
}

/* === Cursor Auto Hide: Layer 2 — Monaco hover region suppression === */
html.cursor-autohide-hidden .monaco-editor .margin,
html.cursor-autohide-hidden .monaco-editor .view-lines {
  pointer-events: none !important;
}

/* === Cursor Auto Hide: Layer 3 — hide already-rendered hover UI === */
html.cursor-autohide-hidden .monaco-tooltip,
html.cursor-autohide-hidden .monaco-editor .overflowingContentWidgets > *:not(.monaco-resizable-hover) {
  display: none !important;
  visibility: hidden !important;
}

/* === Cursor Auto Hide: Keyboard Hover Exemption ===
   Restore pointer-events on the overflow container so Monaco can freely
   create and display keyboard-triggered hover widgets (editor.action.showHover).
   Mouse-triggered hovers are still blocked by pointer-events:none on .view-lines. */
html.cursor-autohide-hidden .monaco-editor .overflowingContentWidgets,
html.cursor-autohide-hidden .monaco-editor .overflowingContentWidgets * {
  pointer-events: auto !important;
}

/* === Cursor Auto Hide: Overlay Exemptions — keep UI interactive === */
html.cursor-autohide-hidden :is(
  [role="dialog"],
  [role="menu"],
  [role="menuitem"],
  [role="listbox"],
  [role="option"],
  .quick-input-widget,
  .notification-toast,
  .monaco-inputbox,
  input,
  textarea,
  select
),
html.cursor-autohide-hidden :is(
  [role="dialog"],
  [role="menu"],
  .quick-input-widget,
  .monaco-inputbox,
  input,
  textarea,
  select
) * {
  cursor: auto !important;
  pointer-events: auto !important;
}

`.trim();
}

// ─── Config JSON ──────────────────────────────────────────────────────────────

/**
 * Serialises the runtime configuration object to a JSON string that is written
 * to {@link CONFIG_FILENAME} and fetched by the injected script at startup.
 *
 * Keeping the delay in a separate file (rather than hardcoding it in the JS)
 * means a delay change only requires rewriting this config file, avoiding an
 * HTML/JS rewrite and a full VS Code restart.
 *
 * @param delayMs - The cursor-hide delay in **milliseconds**.
 * @returns A JSON string of the form `{"delayMs":<value>}`.
 */
function buildConfigJson(delayMs: number): string {
  return JSON.stringify({ delayMs });
}

// ─── Injected Script ──────────────────────────────────────────────────────────
/**
 * Fixed-content script — delay is NOT hardcoded here.
 * Fetches cursor-auto-hide-config.json at runtime with a ?t= cache-buster so that
 * "Reload Now" always picks up the latest delay without needing to change this file.
 */
function buildInjectionScript(): string {
  return `
(function () {
  if (window.__cursorAutoHide) window.__cursorAutoHide.destroy();

  const HTML = document.documentElement;
  const HIDDEN_CLASS = 'cursor-autohide-hidden';
  const DEFAULT_DELAY_MS = 3000;

  let timer = null;
  let mouseIsDown = false;

  function hide() {
    if (!mouseIsDown) {
      // Clean up any hover widget already shown (e.g., mouse-triggered before cursor hid).
      // Hover widgets shown after this point (keyboard-triggered) will appear normally,
      // since pointer-events:none prevents any NEW mouse-triggered hovers.
      document.querySelectorAll('.hover-widget').forEach(function(hw) {
        if (hw.style.display !== 'none') {
          hw.setAttribute('data-autohide-hidden', '1');
          hw.style.display = 'none';
        }
      });
      HTML.classList.add(HIDDEN_CLASS);
    }
  }

  function show() {
    // Restore hover widgets that we explicitly hid
    document.querySelectorAll('[data-autohide-hidden]').forEach(function(hw) {
      hw.style.display = '';
      hw.removeAttribute('data-autohide-hidden');
    });
    HTML.classList.remove(HIDDEN_CLASS);
  }

  function init(delayMs) {
    function onMove() {
      show();
      clearTimeout(timer);
      timer = setTimeout(hide, delayMs);
    }
    function onMouseDown() { mouseIsDown = true; show(); clearTimeout(timer); timer = null; }
    function onMouseUp() { mouseIsDown = false; onMove(); }
    function onWindowBlur() { mouseIsDown = false; }

    document.addEventListener('mousemove', onMove, { passive: true });
    document.addEventListener('mousedown', onMouseDown, { passive: true });
    document.addEventListener('mouseup', onMouseUp, { passive: true });
    window.addEventListener('blur', onWindowBlur, { passive: true });

    onMove();

    window.__cursorAutoHide = {
      destroy() {
        clearTimeout(timer);
        show();
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mousedown', onMouseDown);
        document.removeEventListener('mouseup', onMouseUp);
        window.removeEventListener('blur', onWindowBlur);
        window.__cursorAutoHide = null;
      },
    };
  }

  // Cache-buster ensures the latest delay is read even after "Reload Now"
  fetch('./cursor-auto-hide-config.json?t=' + Date.now())
    .then(function(r) { return r.json(); })
    .then(function(cfg) { init(cfg.delayMs || DEFAULT_DELAY_MS); })
    .catch(function() { init(DEFAULT_DELAY_MS); });

  // Auto-dismiss VS Code's "corrupt installation" warning by clicking "Don't Show Again".
  (function suppressCorruptWarning() {
    function tryDismiss(node) {
      if (node.nodeType !== 1) return;
      const text = node.textContent || '';
      if (!text.includes('corrupt')) return;
      const btns = node.querySelectorAll('.monaco-button, [role="button"], .action-label');
      for (const btn of btns) {
        if ((btn.textContent || '').includes('Show Again')) { btn.click(); break; }
      }
    }
    const obs = new MutationObserver(function(mutations) {
      for (const m of mutations)
        for (const node of m.addedNodes) tryDismiss(node);
    });
    function start() { obs.observe(document.body, { childList: true, subtree: true }); }
    document.body ? start() : document.addEventListener('DOMContentLoaded', start);
  })();
})();
`.trim();
}
