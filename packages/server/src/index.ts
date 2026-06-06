import { config, ensureDirs } from "./config.js";
import { db } from "./store/db.js";
import { sseResponse } from "./events.js";
import { handleOrgRoutes } from "./routes/orgs.js";
import { handleAdoRoutes } from "./routes/ado.js";
import { handlePrRoutes } from "./routes/pr.js";
import { handleReviewRoutes } from "./routes/review.js";
import { handleLspRoutes } from "./routes/lsp.js";
import { handleBrowseRoutes } from "./routes/browse.js";
import { handleSearchRoutes } from "./routes/search.js";
import { handlePipelineRoutes } from "./routes/pipelines.js";
import { subscribe, sendToServer, hasSession } from "./lsp/manager.js";
import { serveStatic } from "./static.js";
import { AuthRequiredError, BadRequestError, errorResponse, json } from "./http.js";

/**
 * agent-ops backend entrypoint. One Bun server hosts the REST API (`/api/*`),
 * the SSE event stream (`/events`), the static SPA, and the LSP WebSocket bridge
 * (`/lsp?key=<session>`), which pipes JSON-RPC between the browser and a spawned
 * language server.
 */

ensureDirs();
db(); // open + migrate the database at boot

/** Per-socket state: which LSP session it's bridging + its unsubscribe fn. */
interface WsData {
  sessionKey: string;
  unsubscribe?: () => void;
}

const server = Bun.serve<WsData>({
  port: config.port,
  hostname: config.host,
  idleTimeout: 0, // allow long-lived SSE/WS connections
  async fetch(req, srv) {
    const url = new URL(req.url);

    try {
      // LSP WebSocket bridge: /lsp?key=<worktreeId::lang>
      if (url.pathname === "/lsp") {
        const sessionKey = url.searchParams.get("key") ?? "";
        if (!hasSession(sessionKey)) {
          return errorResponse("lsp/no-session", "call /api/lsp/session first", 409);
        }
        const ok = srv.upgrade(req, { data: { sessionKey } });
        return ok ? undefined : new Response("upgrade failed", { status: 400 });
      }

      if (url.pathname === "/api/health") {
        return json({ ok: true, version: "0.1.0" });
      }

      if (url.pathname === "/events") {
        return sseResponse(req.signal);
      }

      if (url.pathname.startsWith("/api/")) {
        const handled =
          (await handleOrgRoutes(req, url)) ??
          (await handleAdoRoutes(req, url)) ??
          (await handleReviewRoutes(req, url)) ??
          (await handleLspRoutes(req, url)) ??
          (await handleBrowseRoutes(req, url)) ??
          (await handleSearchRoutes(req, url)) ??
          (await handlePipelineRoutes(req, url)) ??
          (await handlePrRoutes(req, url));
        if (handled) return handled;
        return errorResponse("not-found", `no route for ${req.method} ${url.pathname}`, 404);
      }

      // everything else -> SPA
      return await serveStatic(url);
    } catch (err) {
      return toErrorResponse(err);
    }
  },
  websocket: {
    open(ws) {
      // Forward messages from the language server to this browser socket.
      ws.data.unsubscribe = subscribe(ws.data.sessionKey, (msg) => {
        ws.send(JSON.stringify(msg));
      });
    },
    message(ws, raw) {
      // Forward browser JSON-RPC requests to the language server.
      try {
        const msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
        sendToServer(ws.data.sessionKey, msg);
      } catch {
        /* ignore malformed client frame */
      }
    },
    close(ws) {
      ws.data.unsubscribe?.();
    },
  },
});

function toErrorResponse(err: unknown): Response {
  if (err instanceof AuthRequiredError) {
    return errorResponse("auth/required", "a personal access token is required", 401, {
      org: err.org,
    });
  }
  if (err instanceof BadRequestError) {
    return errorResponse("bad-request", err.message, 400);
  }
  console.error("[agent-ops] unhandled error:", err);
  const message = err instanceof Error ? err.message : "internal error";
  return errorResponse("internal", message, 500);
}

console.log(`agent-ops backend listening on http://${config.host}:${server.port}`);
