import { lazy, Suspense } from "react";
import type { DiffViewProps, CodeViewProps } from "./types.js";

/**
 * Editor registry + lazy loading. The host imports `DiffView` from here and never
 * references Monaco directly — this module is the single swap point. Monaco is
 * code-split so the review queue stays light; the editor bundle loads only when a
 * PR/file is opened.
 *
 * To swap engines: point these lazy imports at a different implementation of the
 * DiffViewProps/CodeViewProps contract.
 */

const LazyMonacoDiff = lazy(() =>
  import("./monaco/MonacoDiffView.js").then((m) => ({ default: m.MonacoDiffView })),
);
const LazyMonacoCode = lazy(() =>
  import("./monaco/MonacoCodeView.js").then((m) => ({ default: m.MonacoCodeView })),
);

export function DiffView(props: DiffViewProps) {
  return (
    <Suspense fallback={<div className="editor-loading">Loading editor…</div>}>
      <LazyMonacoDiff {...props} />
    </Suspense>
  );
}

export function CodeView(props: CodeViewProps) {
  return (
    <Suspense fallback={<div className="editor-loading">Loading editor…</div>}>
      <LazyMonacoCode {...props} />
    </Suspense>
  );
}

export type { DiffViewProps, CodeViewProps, DiffLayout, EditorApi } from "./types.js";
