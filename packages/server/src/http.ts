import { apiError } from "@agent-ops/shared";
import type { z } from "zod";

/** Small helpers for JSON responses, errors, and request-body validation. */

export function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
}

export function errorResponse(
  code: string,
  message: string,
  status: number,
  extra?: { org?: string },
): Response {
  const body = apiError.parse({ error: { code, message, ...extra } });
  return json(body, { status });
}

/** Raised by handlers to short-circuit with an auth/required error the SPA can act on. */
export class AuthRequiredError extends Error {
  constructor(public readonly org: string) {
    super(`auth required for org ${org}`);
  }
}

/** Parses + validates a JSON request body against a schema, returning its output type. */
export async function parseBody<S extends z.ZodTypeAny>(
  req: Request,
  schema: S,
): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new BadRequestError("invalid JSON body");
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new BadRequestError(result.error.issues.map((i) => i.message).join("; "));
  }
  return result.data;
}

export class BadRequestError extends Error {}
