import { join, normalize } from "node:path";
import { paths } from "./config.js";

/**
 * Serves the built SPA from packages/web/dist with SPA fallback (any non-file
 * path returns index.html so client-side routing works). In dev, the SPA is
 * served by Vite instead; if dist is missing we return a friendly hint.
 */
export async function serveStatic(url: URL): Promise<Response> {
  const rel = url.pathname === "/" ? "/index.html" : url.pathname;
  // prevent path traversal
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(paths.webDist, safe);

  const file = Bun.file(filePath);
  if (await file.exists()) {
    return new Response(file);
  }

  // SPA fallback to index.html
  const index = Bun.file(join(paths.webDist, "index.html"));
  if (await index.exists()) {
    return new Response(index, { headers: { "Content-Type": "text/html" } });
  }

  return new Response(
    "agent-ops: web build not found. Run `bun run dev` (Vite dev server) or `bun run build` first.",
    { status: 503, headers: { "Content-Type": "text/plain" } },
  );
}
