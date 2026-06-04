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
 * plus ripgrep search over the worktree. Reached from a PR (browses its checked-out
 * source). Opening a file here also backs go-to-definition into unmodified files.
 */
export function Browse({
  org,
  repositoryId,
  pullRequestId,
  path,
  line,
  onOpenFile,
}: {
  org: string;
  repositoryId: string;
  pullRequestId: number;
  path?: string;
  line?: number;
  onOpenFile: (path: string, line?: number) => void;
}) {
  const selected = path ?? null;
  const revealLine = line;
  const lsp = useLsp(org, repositoryId, pullRequestId);
  const open = (p: string, l?: number) => onOpenFile(p, l);

  return (
    <div className="browse">
      <Resizable storageKey="browseSidebarWidth" defaultWidth={340} min={220} max={640}>
        <div className="browse-sidebar">
          <SearchBox org={org} repositoryId={repositoryId} pullRequestId={pullRequestId} onOpen={open} />
          <TreeView
            org={org}
            repositoryId={repositoryId}
            pullRequestId={pullRequestId}
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
            pullRequestId={pullRequestId}
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
  pullRequestId,
  selected,
  onSelect,
}: {
  org: string;
  repositoryId: string;
  pullRequestId: number;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  return (
    <div className="tree">
      <TreeLevel
        org={org}
        repositoryId={repositoryId}
        pullRequestId={pullRequestId}
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
  pullRequestId,
  dir,
  depth,
  selected,
  onSelect,
}: {
  org: string;
  repositoryId: string;
  pullRequestId: number;
  dir: string;
  depth: number;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ["tree", org, repositoryId, pullRequestId, dir],
    queryFn: () => api.tree(org, repositoryId, pullRequestId, dir),
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
              pullRequestId={pullRequestId}
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
  pullRequestId,
  path,
  revealLine,
  descriptorFor,
  onNavigate,
}: {
  org: string;
  repositoryId: string;
  pullRequestId: number;
  path: string;
  revealLine?: number;
  descriptorFor: (path: string) => Promise<LspDescriptor | null>;
  onNavigate: (path: string, line?: number) => void;
}) {
  const file = useQuery({
    queryKey: ["browseFile", org, repositoryId, pullRequestId, path],
    queryFn: () => api.browseFile(org, repositoryId, pullRequestId, path),
  });
  const [descriptor, setDescriptor] = useState<LspDescriptor | null>(null);
  useEffect(() => {
    let cancelled = false;
    setDescriptor(null);
    descriptorFor(path).then((d) => !cancelled && setDescriptor(d)).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [path, descriptorFor]);

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
          lsp={descriptor ?? undefined}
          revealLine={revealLine}
          onNavigate={onNavigate}
        />
      </div>
    </div>
  );
}

function SearchBox({
  org,
  repositoryId,
  pullRequestId,
  onOpen,
}: {
  org: string;
  repositoryId: string;
  pullRequestId: number;
  onOpen: (path: string, line?: number) => void;
}) {
  const [q, setQ] = useState("");
  const [submitted, setSubmitted] = useState("");
  const results = useQuery({
    queryKey: ["search", org, repositoryId, pullRequestId, submitted],
    queryFn: () => api.search(org, repositoryId, pullRequestId, submitted),
    enabled: submitted.length > 1,
  });

  const grouped = useMemo(() => {
    const m = new Map<string, SearchHit[]>();
    for (const h of results.data?.hits ?? []) {
      const arr = m.get(h.path) ?? [];
      arr.push(h);
      m.set(h.path, arr);
    }
    return [...m.entries()];
  }, [results.data]);

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
