import { useEffect, useRef } from "react";
import type { editor } from "monaco-editor";
import { setupMonaco, MONACO_THEME, setNavigation, applyNavKeybindings } from "./setup.js";
import { attachLsp } from "./lspClient.js";
import type { CodeViewProps } from "../types.js";

/**
 * Read-only single-file Monaco view with LSP (hover/def/refs/diagnostics). Used by
 * code browse and to display go-to-definition targets in unmodified files. Shares
 * the editor abstraction so it can be swapped alongside the diff view.
 */
export function MonacoCodeView({
  path,
  language,
  content,
  lsp,
  revealLine,
  onNavigate,
}: CodeViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<editor.ITextModel | null>(null);

  const rootPath = lsp ? lsp.rootUri.replace(/^file:\/\//, "") : "";
  const uri = lsp
    ? `file://${rootPath}${path.startsWith("/") ? path : "/" + path}`
    : `file://${path}`;

  useEffect(() => {
    const monaco = setupMonaco();
    const host = hostRef.current;
    if (!host) return;

    const ed = monaco.editor.create(host, {
      theme: MONACO_THEME,
      readOnly: true,
      automaticLayout: true,
      scrollBeyondLastLine: false,
      minimap: { enabled: true },
      fontSize: 13,
    });
    editorRef.current = ed;

    const existing = monaco.editor.getModel(monaco.Uri.parse(uri));
    const model = existing ?? monaco.editor.createModel(content, language, monaco.Uri.parse(uri));
    if (existing) existing.setValue(content);
    ed.setModel(model);
    modelRef.current = model;
    applyNavKeybindings(ed);

    let detach: (() => void) | undefined;
    let cancelled = false;
    if (lsp) {
      void attachLsp(monaco, lsp, model).then((d) => (cancelled ? d() : (detach = d)));
      if (onNavigate) setNavigation((p, line) => onNavigate(p, line) !== false, lsp.rootUri);
    }

    return () => {
      cancelled = true;
      detach?.();
      ed.dispose();
      // Only dispose models we created (not ones shared via the model cache).
      if (!existing) model.dispose();
      editorRef.current = null;
      modelRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uri, language]);

  // Update content when it changes for the same file.
  useEffect(() => {
    modelRef.current?.setValue(content);
  }, [content]);

  // Reveal a target line (e.g. a go-to-definition landing point).
  useEffect(() => {
    if (revealLine && editorRef.current) {
      editorRef.current.revealLineInCenter(revealLine);
      editorRef.current.setPosition({ lineNumber: revealLine, column: 1 });
    }
  }, [revealLine]);

  return <div className="monaco-code" ref={hostRef} />;
}
