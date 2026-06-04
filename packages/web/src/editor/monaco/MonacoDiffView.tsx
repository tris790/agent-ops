import { useEffect, useRef, useState } from "react";
import type { editor } from "monaco-editor";
import { setupMonaco, MONACO_THEME, setNavigation, applyNavKeybindings } from "./setup.js";
import { attachLsp } from "./lspClient.js";
import type { DiffViewProps } from "../types.js";

/** localStorage key for the persisted side-by-side split ratio (original pane fraction). */
const DIFF_RATIO_KEY = "prDiffSplitRatio";

/**
 * Monaco implementation of the DiffView contract. Kept behind the editor
 * abstraction (../types) so it can be swapped for another engine without
 * touching the host (PR view) or the backend.
 *
 * Layout mapping:
 *   side-by-side / word / whole-file -> renderSideBySide = true
 *   inline                           -> renderSideBySide = false
 * "word" enables word-level intra-line diff; "whole-file" hides unchanged-region
 * collapsing so the entire file is shown with changes highlighted.
 */
export function MonacoDiffView({
  path,
  language,
  original,
  modified,
  layout,
  rootUri,
  lsp,
  onStats,
  onNavigate,
  inlineComments,
  onAddComment,
}: DiffViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<editor.IStandaloneDiffEditor | null>(null);
  const modelsRef = useRef<{ original: editor.ITextModel; modified: editor.ITextModel } | null>(
    null,
  );
  const decorationsRef = useRef<string[]>([]);
  // Line the user clicked the gutter on to open the inline composer (null = closed).
  const [composeLine, setComposeLine] = useState<number | null>(null);
  const onAddRef = useRef(onAddComment);
  onAddRef.current = onAddComment;
  // Latest content held in refs so the create-once effect can seed models without
  // listing content in its deps (which would recreate the editor on every load).
  const originalRef = useRef(original);
  originalRef.current = original;
  const modifiedRef = useRef(modified);
  modifiedRef.current = modified;

  // The modified model's URI must be the worktree-absolute path the language server
  // sees on disk, or go-to-def/diagnostics won't line up. We derive it from rootUri
  // (known up front), NOT the async lsp descriptor — so the URI is stable for the
  // file's lifetime and the editor isn't disposed+recreated when LSP attaches.
  const root = (rootUri ?? lsp?.rootUri ?? "").replace(/^file:\/\//, "");
  const modifiedUri = root
    ? `file://${root}${path.startsWith("/") ? path : "/" + path}`
    : `file://${path}`;

  // Create the diff editor once per file identity.
  useEffect(() => {
    const monaco = setupMonaco();
    const host = hostRef.current;
    if (!host) return;

    const savedRatio = Number(localStorage.getItem(DIFF_RATIO_KEY));
    const ed = monaco.editor.createDiffEditor(host, {
      theme: MONACO_THEME,
      automaticLayout: true,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: true,
      splitViewDefaultRatio: savedRatio > 0.1 && savedRatio < 0.9 ? savedRatio : 0.5,
      ignoreTrimWhitespace: false,
      renderOverviewRuler: true,
      scrollBeyondLastLine: false,
      minimap: { enabled: false },
      glyphMargin: true,
      fontSize: 13,
    });
    editorRef.current = ed;

    // Modified model uses the worktree-absolute file:// URI so the language server
    // resolves it; the base (original) side gets a sibling URI it won't index.
    // Reuse an existing model for this URI if one is lingering (e.g. created by the
    // code browser), else create it. Seed with current content so a freshly created
    // editor shows the file immediately without waiting for the content effect.
    const baseUri = monaco.Uri.parse(modifiedUri + ".base");
    const modUri = monaco.Uri.parse(modifiedUri);
    const original =
      monaco.editor.getModel(baseUri) ??
      monaco.editor.createModel(originalRef.current ?? "", language, baseUri);
    const modified =
      monaco.editor.getModel(modUri) ??
      monaco.editor.createModel(modifiedRef.current ?? "", language, modUri);
    original.setValue(originalRef.current ?? "");
    modified.setValue(modifiedRef.current ?? "");
    ed.setModel({ original, modified });
    modelsRef.current = { original, modified };
    const modEd = ed.getModifiedEditor();
    applyNavKeybindings(modEd);

    // Persist the side-by-side split ratio when the user drags the divider, so it
    // survives reloads. Monaco has no "sash moved" event, so we watch the original
    // pane's width relative to the host and save the ratio (debounced).
    const origEd = ed.getOriginalEditor();
    let ratioTimer: ReturnType<typeof setTimeout> | undefined;
    const layoutSub = origEd.onDidLayoutChange((info) => {
      const total = host.clientWidth;
      if (total <= 0) return;
      const ratio = info.width / total;
      if (ratio < 0.1 || ratio > 0.9) return;
      clearTimeout(ratioTimer);
      ratioTimer = setTimeout(() => localStorage.setItem(DIFF_RATIO_KEY, String(ratio)), 300);
    });

    // Click the line-number gutter on the modified side to comment on that line.
    const clickSub = modEd.onMouseDown((e) => {
      const t = e.target.type;
      if (
        (t === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS ||
          t === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) &&
        e.target.position
      ) {
        setComposeLine(e.target.position.lineNumber);
      }
    });

    const statsListener = ed.onDidUpdateDiff(() => {
      const changes = ed.getLineChanges() ?? [];
      let added = 0;
      let removed = 0;
      for (const c of changes) {
        if (c.modifiedEndLineNumber > 0)
          added += c.modifiedEndLineNumber - c.modifiedStartLineNumber + 1;
        if (c.originalEndLineNumber > 0)
          removed += c.originalEndLineNumber - c.originalStartLineNumber + 1;
      }
      onStats?.({ added, removed });
    });

    return () => {
      statsListener.dispose();
      clickSub.dispose();
      layoutSub.dispose();
      clearTimeout(ratioTimer);
      ed.dispose();
      original.dispose();
      modified.dispose();
      modelsRef.current = null;
      editorRef.current = null;
    };
    // Recreate only when the file identity or language changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, language, modifiedUri]);

  // Decorate lines that have inline comment threads with a glyph + line highlight.
  useEffect(() => {
    const models = modelsRef.current;
    const ed = editorRef.current;
    if (!models || !ed) return;
    const monaco = setupMonaco();
    const decos = (inlineComments ?? []).map((c) => ({
      range: new monaco.Range(c.line, 1, c.line, 1),
      options: {
        isWholeLine: true,
        glyphMarginClassName: c.resolved ? "comment-glyph resolved" : "comment-glyph",
        glyphMarginHoverMessage: {
          value: c.comments.map((m) => `**${m.author}**: ${m.content}`).join("\n\n"),
        },
        linesDecorationsClassName: "comment-line",
      },
    }));
    decorationsRef.current = models.modified.deltaDecorations(decorationsRef.current, decos);
  }, [inlineComments, modified]);

  // Close the composer when switching files.
  useEffect(() => setComposeLine(null), [modifiedUri]);

  // Attach LSP when a descriptor is provided: opens the modified doc on a shared
  // connection and ensures global providers (hover/def/refs) + diagnostics. The
  // disposer releases this file's ref on the shared connection.
  useEffect(() => {
    if (!lsp) return;
    const monaco = setupMonaco();
    const models = modelsRef.current;
    if (!models) return;
    let detach: (() => void) | undefined;
    let cancelled = false;
    void attachLsp(monaco, lsp, models.modified).then((d) => {
      if (cancelled) d();
      else detach = d;
    });
    // Route cross-file go-to-definition to the host navigation handler.
    if (onNavigate) setNavigation((p, line) => onNavigate(p, line) !== false, lsp.rootUri);
    return () => {
      cancelled = true;
      detach?.();
    };
  }, [lsp, modifiedUri, onNavigate]);

  // Update content when it arrives/changes.
  useEffect(() => {
    const models = modelsRef.current;
    if (!models) return;
    models.original.setValue(original ?? "");
    models.modified.setValue(modified ?? "");
  }, [original, modified]);

  // Apply layout option changes without recreating the editor.
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    ed.updateOptions({
      renderSideBySide: layout !== "inline",
      // whole-file: show the entire file rather than collapsing unchanged regions.
      hideUnchangedRegions: { enabled: layout !== "whole-file" },
      // word: emphasize intra-line changes.
      diffWordWrap: "off",
      renderMarginRevertIcon: false,
    } as editor.IDiffEditorOptions);
  }, [layout]);

  return (
    <div className="monaco-diff-wrap">
      <div className="monaco-diff" ref={hostRef} />
      {composeLine != null && onAddComment && (
        <InlineComposer
          line={composeLine}
          onCancel={() => setComposeLine(null)}
          onSubmit={(content) => {
            onAddRef.current?.(composeLine, content);
            setComposeLine(null);
          }}
        />
      )}
    </div>
  );
}

/** Small composer docked at the bottom of the diff for a new line comment. */
function InlineComposer({
  line,
  onSubmit,
  onCancel,
}: {
  line: number;
  onSubmit: (content: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  return (
    <div className="inline-composer">
      <div className="inline-composer-head">Comment on line {line}</div>
      <textarea
        className="composer-input"
        autoFocus
        placeholder="Leave a comment…"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && value.trim()) onSubmit(value.trim());
          if (e.key === "Escape") onCancel();
        }}
      />
      <div className="composer-actions">
        <button className="btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn-primary" disabled={!value.trim()} onClick={() => onSubmit(value.trim())}>
          Comment
        </button>
      </div>
    </div>
  );
}
