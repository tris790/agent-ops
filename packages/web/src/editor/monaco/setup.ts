// Import Monaco's core editor only (not the `monaco-editor` barrel, which would
// register every language's grammar and balloon the bundle). We then register
// just the languages agent-ops targets. Real intelligence comes from LSP (Step 7);
// these grammars only provide syntax highlighting.
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";

// Syntax-highlighting grammars for our supported languages (+ common config files).
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js";
import "monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution.js";
import "monaco-editor/esm/vs/basic-languages/go/go.contribution.js";
import "monaco-editor/esm/vs/basic-languages/rust/rust.contribution.js";
import "monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution.js";
import "monaco-editor/esm/vs/basic-languages/python/python.contribution.js";
import "monaco-editor/esm/vs/basic-languages/java/java.contribution.js";
import "monaco-editor/esm/vs/basic-languages/ruby/ruby.contribution.js";
import "monaco-editor/esm/vs/basic-languages/php/php.contribution.js";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js";
import "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution.js";
import "monaco-editor/esm/vs/basic-languages/shell/shell.contribution.js";
import "monaco-editor/esm/vs/basic-languages/html/html.contribution.js";
import "monaco-editor/esm/vs/basic-languages/css/css.contribution.js";
import "monaco-editor/esm/vs/basic-languages/scss/scss.contribution.js";
import "monaco-editor/esm/vs/basic-languages/less/less.contribution.js";
import "monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.contribution.js";
import "monaco-editor/esm/vs/language/json/monaco.contribution.js";

// Vite-friendly worker wiring. We use the editor worker for everything; the
// language-specific workers would conflict with the real LSP servers we connect
// in Step 7. Syntax highlighting (Monarch) works without language workers.
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

let configured = false;

/**
 * Dark theme tuned to match the app's palette (see styles.css :root). Keeping the
 * editor background identical to the app chrome avoids a jarring seam at the diff
 * pane edges.
 */
const THEME = "agent-ops-dark";

/** Idempotently configure Monaco's environment + dark theme. Call before creating any editor. */
export function setupMonaco(): typeof monaco {
  if (configured) return monaco;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (self as any).MonacoEnvironment = {
    getWorker() {
      return new EditorWorker();
    },
  };
  monaco.editor.defineTheme(THEME, {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#0d1117",
      "editorGutter.background": "#0d1117",
      "editor.lineHighlightBackground": "#161b22",
      "editorLineNumber.foreground": "#484f58",
      "editorLineNumber.activeForeground": "#8b949e",
      // diff colors that read well on the dark background
      "diffEditor.insertedTextBackground": "#3fb95025",
      "diffEditor.removedTextBackground": "#f8514925",
      "diffEditor.insertedLineBackground": "#3fb95018",
      "diffEditor.removedLineBackground": "#f8514918",
    },
  });
  monaco.editor.setTheme(THEME);

  // Intercept cross-file navigation (go-to-definition into another file). Monaco's
  // default opener can't open files we manage, so we route to the host-provided
  // navigation handler, which opens the target in the browse view.
  monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selection) {
      const handler = navigationHandler;
      if (!handler) return false;
      // resource is a worktree-absolute file:// URI; convert back to repo-relative.
      const path = resource.path.replace(workspaceRootPath, "") || resource.path;
      const line = selection && "startLineNumber" in selection ? selection.startLineNumber : 1;
      return handler(path.startsWith("/") ? path : "/" + path, line);
    },
  });

  // Exposed for e2e/diagnostics probing of LSP wiring (harmless in production).
  (self as unknown as { __monaco?: typeof monaco }).__monaco = monaco;
  configured = true;
  return monaco;
}

/**
 * Adds LSP navigation keybindings that don't collide with the browser/OS.
 * Monaco's defaults (F12, Shift+F12, Alt+F12) are eaten by devtools/OS, so we add
 * friendlier ones and keep Ctrl/Cmd-click for go-to-definition:
 *   - go to definition:   `g d` chord, and F12 (kept for muscle memory where free)
 *   - peek definition:    Ctrl/Cmd+F12 is unreliable -> use `g D`
 *   - find references:    `g r`, and Shift+F12
 *   - go to type/impl:     `g t` / `g i`
 * Ctrl/Cmd+Click already triggers go-to-def via Monaco's gotoLocation handler.
 */
export function applyNavKeybindings(ed: {
  addAction: (a: monaco.editor.IActionDescriptor) => void;
  getAction: (id: string) => { run: () => void } | null;
}): void {
  const K = monaco.KeyCode;
  const M = monaco.KeyMod;
  const chord = (a: number, b: number) => M.chord(a, b);
  const G = K.KeyG;

  ed.addAction({
    id: "agentops.goToDefinition",
    label: "Go to Definition",
    keybindings: [chord(G, K.KeyD)],
    run: () => ed.getAction("editor.action.revealDefinition")?.run(),
  });
  ed.addAction({
    id: "agentops.peekDefinition",
    label: "Peek Definition",
    keybindings: [chord(G, K.KeyP)],
    run: () => ed.getAction("editor.action.peekDefinition")?.run(),
  });
  ed.addAction({
    id: "agentops.findReferences",
    label: "Find References",
    keybindings: [chord(G, K.KeyR)],
    run: () => ed.getAction("editor.action.referenceSearch.trigger")?.run(),
  });
  ed.addAction({
    id: "agentops.goToTypeDefinition",
    label: "Go to Type Definition",
    keybindings: [chord(G, K.KeyT)],
    run: () => ed.getAction("editor.action.goToTypeDefinition")?.run(),
  });
  ed.addAction({
    id: "agentops.goToImplementation",
    label: "Go to Implementation",
    keybindings: [chord(G, K.KeyI)],
    run: () => ed.getAction("editor.action.goToImplementation")?.run(),
  });
}

/** Host navigation handler + workspace root, set by the active editor. */
let navigationHandler: ((path: string, line: number) => boolean) | null = null;
let workspaceRootPath = "";

export function setNavigation(
  handler: ((path: string, line: number) => boolean) | null,
  rootUri: string,
): void {
  navigationHandler = handler;
  workspaceRootPath = rootUri.replace(/^file:\/\//, "");
}

export { THEME as MONACO_THEME };
