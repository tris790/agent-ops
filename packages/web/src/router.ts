import { useEffect, useState, useCallback } from "react";

/**
 * Minimal hash-based router. Hash routing keeps a local SPA shareable and
 * back/forward-correct without any server route config. The hash encodes the
 * screen plus, for the PR view, the open file and line so a URL restores the
 * exact place (and is shareable).
 *
 * Routes:
 *   #/                                     review queue
 *   #/config                               org/PAT config
 *   #/:repoId/pr/:prId?mode=&file=&line=   PR view (mode: diff|browse)
 *   #/code/:repoId/:ref?file=&line=        standalone code browse (ref = branch)
 */

export interface Route {
  screen: "queue" | "config" | "pr" | "pipelines" | "code";
  repoId?: string;
  prId?: number;
  /** Branch name for the code-browse screen (may contain "/"; URL-encoded in hash). */
  ref?: string;
  mode?: "diff" | "browse";
  file?: string;
  line?: number;
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, "") || "/";
  const [path = "/", queryStr] = raw.split("?");
  const query = new URLSearchParams(queryStr ?? "");
  const segs = path.split("/").filter(Boolean);

  if (segs[0] === "config") return { screen: "config" };
  if (segs[0] === "pipelines") return { screen: "pipelines" };

  // /code/:repoId/:ref  (ref is a single URL-encoded segment so "feature/x" survives)
  if (segs[0] === "code" && segs.length >= 3) {
    return {
      screen: "code",
      repoId: decodeURIComponent(segs[1]!),
      ref: decodeURIComponent(segs[2]!),
      file: query.get("file") ?? undefined,
      line: query.get("line") ? Number(query.get("line")) : undefined,
    };
  }

  // /:repoId/pr/:prId
  if (segs.length >= 3 && segs[1] === "pr") {
    return {
      screen: "pr",
      repoId: decodeURIComponent(segs[0]!),
      prId: Number(segs[2]),
      mode: query.get("mode") === "browse" ? "browse" : "diff",
      file: query.get("file") ?? undefined,
      line: query.get("line") ? Number(query.get("line")) : undefined,
    };
  }

  return { screen: "queue" };
}

export function buildHash(r: Route): string {
  if (r.screen === "config") return "#/config";
  if (r.screen === "pipelines") return "#/pipelines";
  if (r.screen === "code" && r.repoId && r.ref) {
    const q = new URLSearchParams();
    if (r.file) q.set("file", r.file);
    if (r.line) q.set("line", String(r.line));
    const qs = q.toString();
    return `#/code/${encodeURIComponent(r.repoId)}/${encodeURIComponent(r.ref)}${qs ? "?" + qs : ""}`;
  }
  if (r.screen === "pr" && r.repoId && r.prId) {
    const q = new URLSearchParams();
    if (r.mode && r.mode !== "diff") q.set("mode", r.mode);
    if (r.file) q.set("file", r.file);
    if (r.line) q.set("line", String(r.line));
    const qs = q.toString();
    return `#/${encodeURIComponent(r.repoId)}/pr/${r.prId}${qs ? "?" + qs : ""}`;
  }
  return "#/";
}

/** Subscribes to the current route and provides navigation helpers. */
export function useRoute(): {
  route: Route;
  navigate: (r: Route, opts?: { replace?: boolean }) => void;
  back: () => void;
} {
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));

  useEffect(() => {
    const onHash = () => setRoute(parseHash(location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const navigate = useCallback((r: Route, opts?: { replace?: boolean }) => {
    const h = buildHash(r);
    if (opts?.replace) location.replace(h);
    else location.hash = h;
  }, []);

  const back = useCallback(() => history.back(), []);

  return { route, navigate, back };
}
