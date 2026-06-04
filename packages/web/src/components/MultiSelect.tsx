import { useState, useRef, useEffect } from "react";

export interface Option {
  value: string;
  label: string;
}

/**
 * A compact multi-select dropdown used for the home-screen filters (users, repos,
 * statuses). Shows a count badge when active; selections are controlled by the
 * parent so they can be persisted.
 */
export function MultiSelect({
  label,
  options,
  selected,
  onChange,
  searchable = false,
}: {
  label: string;
  options: Option[];
  selected: string[];
  onChange: (next: string[]) => void;
  searchable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const toggle = (value: string) => {
    onChange(
      selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value],
    );
  };

  const visible = filter
    ? options.filter((o) => o.label.toLowerCase().includes(filter.toLowerCase()))
    : options;

  return (
    <div className="ms" ref={ref}>
      <button
        type="button"
        className={selected.length ? "ms-trigger active" : "ms-trigger"}
        onClick={() => setOpen((o) => !o)}
      >
        {label}
        {selected.length > 0 && <span className="ms-badge">{selected.length}</span>}
        <span className="ms-caret">▾</span>
      </button>
      {open && (
        <div className="ms-menu">
          {searchable && (
            <input
              className="ms-search"
              placeholder="Filter…"
              value={filter}
              autoFocus
              onChange={(e) => setFilter(e.target.value)}
            />
          )}
          <div className="ms-options">
            {visible.map((o) => (
              <label key={o.value} className="ms-option">
                <input
                  type="checkbox"
                  checked={selected.includes(o.value)}
                  onChange={() => toggle(o.value)}
                />
                <span>{o.label}</span>
              </label>
            ))}
            {visible.length === 0 && <div className="ms-empty">No matches</div>}
          </div>
          {selected.length > 0 && (
            <button type="button" className="ms-clear" onClick={() => onChange([])}>
              Clear
            </button>
          )}
        </div>
      )}
    </div>
  );
}
