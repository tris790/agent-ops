import { useRef, useState, useEffect, type ReactNode } from "react";

/**
 * A panel with a draggable right edge for horizontal resizing. Width persists to
 * localStorage under `storageKey` so the user's sizing sticks across sessions.
 */
export function Resizable({
  storageKey,
  defaultWidth,
  min = 180,
  max = 720,
  children,
}: {
  storageKey: string;
  defaultWidth: number;
  min?: number;
  max?: number;
  children: ReactNode;
}) {
  const [width, setWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem(storageKey));
    return saved >= min && saved <= max ? saved : defaultWidth;
  });
  const dragging = useRef(false);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const next = Math.min(max, Math.max(min, e.clientX - containerLeft.current));
      setWidth(next);
    };
    const onUp = () => {
      if (dragging.current) {
        dragging.current = false;
        document.body.style.cursor = "";
        localStorage.setItem(storageKey, String(widthRef.current));
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [min, max, storageKey]);

  // Track latest width + the panel's left edge for delta math.
  const widthRef = useRef(width);
  widthRef.current = width;
  const containerLeft = useRef(0);
  const ref = useRef<HTMLDivElement>(null);

  return (
    <div className="resizable" ref={ref} style={{ width }}>
      {children}
      <div
        className="resizable-handle"
        onMouseDown={() => {
          dragging.current = true;
          containerLeft.current = ref.current?.getBoundingClientRect().left ?? 0;
          document.body.style.cursor = "col-resize";
        }}
      />
    </div>
  );
}
