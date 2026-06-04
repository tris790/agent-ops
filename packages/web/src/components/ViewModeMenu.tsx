import { useEffect, useRef, useState } from "react";

export type FileViewMode = "tree" | "list";

/** Reads/writes the persisted tree-vs-list preference. */
export function useFileViewMode(key = "fileViewMode"): [FileViewMode, (m: FileViewMode) => void] {
  const [mode, setMode] = useState<FileViewMode>(
    () => (localStorage.getItem(key) as FileViewMode) || "tree",
  );
  const set = (m: FileViewMode) => {
    setMode(m);
    localStorage.setItem(key, m);
  };
  return [mode, set];
}

/** A vertical-ellipsis (⋮) menu to switch between tree and list file views. */
export function ViewModeMenu({
  mode,
  onChange,
}: {
  mode: FileViewMode;
  onChange: (m: FileViewMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div className="vmenu" ref={ref}>
      <button className="vmenu-trigger" onClick={() => setOpen((o) => !o)} title="View options">
        ⋮
      </button>
      {open && (
        <div className="vmenu-pop">
          <button
            className={mode === "tree" ? "active" : ""}
            onClick={() => {
              onChange("tree");
              setOpen(false);
            }}
          >
            Tree view
          </button>
          <button
            className={mode === "list" ? "active" : ""}
            onClick={() => {
              onChange("list");
              setOpen(false);
            }}
          >
            List view
          </button>
        </div>
      )}
    </div>
  );
}
