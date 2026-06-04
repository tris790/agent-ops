import type { ServerEvent } from "@agent-ops/shared";

/**
 * In-process pub/sub for server-pushed events, exposed to the SPA as an SSE
 * stream at `/events`. Git/LSP/freshness/auth code calls `emit`; the route
 * subscribes each connected client.
 */

type Subscriber = (event: ServerEvent) => void;

const subscribers = new Set<Subscriber>();

export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function emit(event: ServerEvent): void {
  for (const fn of subscribers) {
    try {
      fn(event);
    } catch {
      // a slow/broken subscriber must not break the emitter
    }
  }
}

/** Builds an SSE Response that streams emitted events until the client disconnects. */
export function sseResponse(signal: AbortSignal): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      const send = (event: ServerEvent) => {
        controller.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      const unsub = subscribe(send);
      // keep-alive comment every 25s so proxies/browsers don't drop idle streams
      const ka = setInterval(() => controller.enqueue(enc.encode(": keep-alive\n\n")), 25_000);
      const cleanup = () => {
        clearInterval(ka);
        unsub();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      signal.addEventListener("abort", cleanup);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
