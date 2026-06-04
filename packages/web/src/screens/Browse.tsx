import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { SearchHit, TreeNode } from "@agent-ops/shared";
import { api } from "../api/client.js";
import { useLsp } from "../api/useLsp.js";
import { CodeView } from "../editor/index.js";
import type { LspDescriptor } from "../editor/types.js";
import { languageForPath } from "../editor/language.js";
import { useEffect } from "react";
import { Resizable } from "../components/Resizable.js";

/**
 * Code browse: a lazily-expanding file tree + read-only LSP-enabled file viewer,
 * plus ripgrep search over the repo's worktree. Worktree-agnostic — it reads
 * whatever ref the host (a PR or the standalone Code tab) has checked out, keyed
 * for caching by `worktreeRef` (a commit SHA or branch name). The host must ensure
 * the worktree is at the right ref before/while this renders.
 */
export function Browse({
  org,
  repositoryId,
  worktreeRef,
  ensure,
  path,
  line,
  onOpenFile,
}: {
  org: string;
  repositoryId: string;
  /** Stable cache-key segment for the checked-out ref (commit SHA or branch). */
  worktreeRef: string;
  /** Ensures the worktree is checked out at the desired ref; drives LSP readiness. */
  ensure: () => Promise<{ path: string }>;
  path?: string;
  line?: number;
  onOpenFile: (path: string, line?: number) => void;
}) {
  const selected = path ?? null;
  const revealLine = line;
  const lsp = useLsp(org, repositoryId, ensure, worktreeRef);
  const open = (p: string, l?: number) => onOpenFile(p, l);

  return (
    <div className="browse">
      <Resizable storageKey="browseSidebarWidth" defaultWidth={340} min={220} max={640}>
        <div className="browse-sidebar">
          <SearchBox
            org={org}
            repositoryId={repositoryId}
            worktreeRef={worktreeRef}
            onOpen={open}
          />
          <TreeView
            org={org}
            repositoryId={repositoryId}
            worktreeRef={worktreeRef}
            selected={selected}
            onSelect={(p) => open(p)}
          />
        </div>
      </Resizable>
      <div className="browse-main">
        {selected ? (
          <FileViewer
            org={org}
            repositoryId={repositoryId}
            worktreeRef={worktreeRef}
            path={selected}
            revealLine={revealLine}
            descriptorFor={lsp.descriptorFor}
            onNavigate={open}
          />
        ) : (
          <div className="editor-loading">Select a file to view.</div>
        )}
      </div>
    </div>
  );
}

/** Lazily-expanding folder tree. */
function TreeView({
  org,
  repositoryId,
  worktreeRef,
  selected,
  onSelect,
}: {
  org: string;
  repositoryId: string;
  worktreeRef: string;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  return (
    <div className="tree">
      <TreeLevel
        org={org}
        repositoryId={repositoryId}
        worktreeRef={worktreeRef}
        dir="/"
        depth={0}
        selected={selected}
        onSelect={onSelect}
      />
    </div>
  );
}

function TreeLevel({
  org,
  repositoryId,
  worktreeRef,
  dir,
  depth,
  selected,
  onSelect,
}: {
  org: string;
  repositoryId: string;
  worktreeRef: string;
  dir: string;
  depth: number;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ["tree", org, repositoryId, worktreeRef, dir],
    queryFn: () => api.tree(org, repositoryId, dir),
  });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  if (isLoading) return <div className="tree-loading" style={{ paddingLeft: depth * 12 + 8 }}>…</div>;

  return (
    <ul className="tree-level">
      {(data?.nodes ?? []).map((node: TreeNode) => (
        <li key={node.path}>
          <div
            className={`tree-row ${node.path === selected ? "sel" : ""}`}
            style={{ paddingLeft: depth * 12 + 8 }}
            onClick={() => {
              if (node.isFolder) {
                setExpanded((e) => {
                  const n = new Set(e);
                  n.has(node.path) ? n.delete(node.path) : n.add(node.path);
                  return n;
                });
              } else {
                onSelect(node.path);
              }
            }}
          >
            <span className="tree-icon">{node.isFolder ? (expanded.has(node.path) ? "▾" : "▸") : "·"}</span>
            <span className="tree-name">{node.name}</span>
          </div>
          {node.isFolder && expanded.has(node.path) && (
            <TreeLevel
              org={org}
              repositoryId={repositoryId}
              worktreeRef={worktreeRef}
              dir={node.path}
              depth={depth + 1}
              selected={selected}
              onSelect={onSelect}
            />
          )}
        </li>
      ))}
    </ul>
  );
}

function FileViewer({
  org,
  repositoryId,
  worktreeRef,
  path,
  revealLine,
  descriptorFor,
  onNavigate,
}: {
  org: string;
  repositoryId: string;
  worktreeRef: string;
  path: string;
  revealLine?: number;
  descriptorFor: (path: string) => Promise<LspDescriptor | null>;
  onNavigate: (path: string, line?: number) => void;
}) {
  const externalMetadataSource = isMetadataSourcePath(path);
  const file = useQuery({
    queryKey: ["browseFile", org, repositoryId, worktreeRef, path],
    queryFn: () => api.browseFile(org, repositoryId, path),
  });
  const [descriptor, setDescriptor] = useState<LspDescriptor | null>(null);
  useEffect(() => {
    let cancelled = false;
    setDescriptor(null);
    if (externalMetadataSource) return () => {
      cancelled = true;
    };
    descriptorFor(path).then((d) => !cancelled && setDescriptor(d)).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [path, descriptorFor, externalMetadataSource]);

  if (file.isLoading) return <div className="editor-loading">Loading…</div>;
  if (file.data?.binary) return <div className="editor-loading">Binary file.</div>;

  return (
    <div className="file-viewer">
      <div className="file-viewer-path">{path.replace(/^\//, "")}</div>
      <div className="file-viewer-editor">
        <CodeView
          path={path}
          language={languageForPath(path)}
          content={file.data?.content ?? ""}
          lsp={externalMetadataSource ? undefined : descriptor ?? undefined}
          revealLine={revealLine}
          onNavigate={onNavigate}
        />
      </div>
    </div>
  );
}

function isMetadataSourcePath(path: string): boolean {
  return path.startsWith("/tmp/MetadataAsSource/");
}

function SearchBox({
  org,
  repositoryId,
  worktreeRef,
  onOpen,
}: {
  org: string;
  repositoryId: string;
  worktreeRef: string;
  onOpen: (path: string, line?: number) => void;
}) {
  const [q, setQ] = useState("");
  const [submitted, setSubmitted] = useState("");
  const results = useQuery({
    queryKey: ["search", org, repositoryId, worktreeRef, submitted],
    queryFn: () => api.search(org, repositoryId, submitted),
    enabled: submitted.length > 1,
  });

  const grouped = useMemo(() => groupHitsByFile(results.data?.hits ?? []), [results.data]);

  return (
    <div className="search-box">
      <input
        className="search-input"
        placeholder="Search code…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && setSubmitted(q)}
      />
      {submitted && (
        <div className="search-results">
          {results.isLoading && <div className="search-status">Searching…</div>}
          {results.data && (
            <div className="search-status">
              {results.data.hits.length} hit{results.data.hits.length === 1 ? "" : "s"}
            </div>
          )}
          {grouped.map(([file, hits]) => (
            <div key={file} className="search-file">
              <div className="search-file-name">{file.replace(/^\//, "")}</div>
              {hits.map((h, i) => (
                <div
                  key={i}
                  className="search-hit"
                  onClick={() => onOpen(h.path, h.line)}
                  title={`${file}:${h.line}`}
                >
                  <span className="search-line-no">{h.line}</span>
                  <span className="search-preview">{h.preview.trim()}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Groups search hits by file path, preserving first-seen order. */
export function groupHitsByFile(hits: SearchHit[]): [string, SearchHit[]][] {
  const m = new Map<string, SearchHit[]>();
  for (const h of hits) {
    const arr = m.get(h.path) ?? [];
    arr.push(h);
    m.set(h.path, arr);
  }
  return [...m.entries()];
}
