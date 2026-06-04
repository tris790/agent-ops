/**
 * Editor abstraction — the seam that keeps Monaco swappable.
 *
 * The rest of the app talks to a `DiffView` / `CodeView` through these props and
 * the `EditorApi` handle. A different engine (e.g. CodeMirror) only needs to
 * provide new React components implementing the same contract; nothing else —
 * and crucially no backend code — changes. LSP wiring (Step 7) is expressed here
 * as a transport-neutral `lsp` descriptor, not a Monaco-specific object.
 */

export type DiffLayout =
  | "side-by-side" // two panes, old vs new
  | "inline" //        unified single column
  | "whole-file" //    full file shown, changes highlighted (not just hunks)
  | "word"; //         like side-by-side but with intra-line (word) diff emphasis

/** Language id used for syntax highlighting (derived from file extension). */
export type LanguageId = string;

export interface DiffViewProps {
  /** Stable file path; also used to build the model URI for LSP (Step 7). */
  path: string;
  language: LanguageId;
  /** Left (base) content; null when the file is newly added. */
  original: string | null;
  /** Right (proposed) content; null when the file is deleted. */
  modified: string | null;
  layout: DiffLayout;
  /**
   * Worktree root file:// URI, if known. Used to build a stable model URI up front
   * (independent of the async `lsp` descriptor) so the editor isn't recreated when
   * LSP attaches. Falls back to a path-only URI when absent.
   */
  rootUri?: string;
  /** Optional WS endpoint for an LSP server scoped to this file's repo (Step 7). */
  lsp?: LspDescriptor;
  /** Notifies the host of the diff stats once computed (added/removed lines). */
  onStats?: (stats: DiffStats) => void;
  /**
   * Called when the user follows a go-to-definition/reference into a file.
   * `path` is repo-relative (leading slash). The host opens it in a code viewer.
   * Returning false lets the editor fall back to its default (in-pane) behavior.
   */
  onNavigate?: (path: string, line: number) => boolean | void;

  /** Inline comment threads anchored to lines on the right (new) side of this file. */
  inlineComments?: InlineComment[];
  /** Create a new thread on the right-side line. */
  onAddComment?: (line: number, content: string) => void;

  /**
   * Search matches to highlight on the modified (right) pane. Positions are
   * 1-based, in the modified document's coordinates. The view also highlights the
   * same query text on the original (left) pane by re-finding it client-side.
   */
  searchMatches?: SearchMatch[];
  /** Scroll this match into view (and emphasize it). Bumps re-reveal on change. */
  revealMatch?: { line: number; column: number };
}

/** A search match span on one line (1-based, modified-document coordinates). */
export interface SearchMatch {
  line: number;
  column: number;
  endColumn: number;
}

/** A comment thread anchored to a specific right-side line, for inline display. */
export interface InlineComment {
  threadId: number;
  line: number;
  resolved: boolean;
  comments: { author: string; content: string }[];
}

export interface CodeViewProps {
  path: string;
  language: LanguageId;
  content: string;
  /** Read-only by default; PR code browse is non-editing. */
  readOnly?: boolean;
  lsp?: LspDescriptor;
  /** Scroll this 1-based line into view (e.g. a go-to-definition landing point). */
  revealLine?: number;
  /** Follow a go-to-definition/reference into another file (repo-relative path). */
  onNavigate?: (path: string, line: number) => boolean | void;
}

export interface DiffStats {
  added: number;
  removed: number;
}

/** Transport-neutral description of an LSP connection (filled in Step 7). */
export interface LspDescriptor {
  /** WebSocket URL of the backend bridge, e.g. /lsp/<worktreeId>/<lang>. */
  url: string;
  language: LanguageId;
  /** Absolute file:// root the language server indexes (the worktree path). */
  rootUri: string;
}

/** Imperative handle a host can use to drive the editor (scroll, layout, etc.). */
export interface EditorApi {
  /** Recompute layout (e.g. after a container resize). */
  relayout(): void;
  /** Scroll a given 1-based line into view. */
  revealLine(line: number): void;
}
