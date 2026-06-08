import { useCallback, useLayoutEffect, useRef, useState, type UIEvent } from "react";

/**
 * Minimal fixed-row windowing for long scrollable lists (no dependency). Renders
 * only the rows in view (plus a small overscan), with top/bottom spacer heights
 * that preserve the scrollbar. Use when an option list can hold 1000s of rows.
 *
 * Usage:
 *   const { scrollRef, onScroll, range, topPad, bottomPad } = useVirtualList(items.length, ROW_H);
 *   <div ref={scrollRef} onScroll={onScroll} style={{ overflow: "auto" }}>
 *     <div style={{ height: topPad }} />
 *     {items.slice(range.start, range.end).map(...)}
 *     <div style={{ height: bottomPad }} />
 *   </div>
 */
export function useVirtualList<E extends HTMLElement = HTMLDivElement>(
  count: number,
  rowHeight: number,
  overscan = 6,
) {
  const scrollRef = useRef<E>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);

  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (el) setViewport(el.clientHeight);
  }, []);

  // Measure the viewport once it's mounted (and whenever the count changes, which
  // is when the list re-opens or is re-filtered).
  useLayoutEffect(() => {
    measure();
  }, [measure, count]);

  const onScroll = useCallback((e: UIEvent<E>) => {
    setScrollTop(e.currentTarget.scrollTop);
  }, []);

  const visibleRows = viewport > 0 ? Math.ceil(viewport / rowHeight) : count;
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(count, start + visibleRows + overscan * 2);

  return {
    scrollRef,
    onScroll,
    range: { start, end },
    topPad: start * rowHeight,
    bottomPad: Math.max(0, (count - end) * rowHeight),
    /** Scroll a given row index into view (for keyboard navigation). */
    scrollToIndex: (index: number) => {
      const el = scrollRef.current;
      if (!el) return;
      const top = index * rowHeight;
      const bottom = top + rowHeight;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
    },
  };
}
