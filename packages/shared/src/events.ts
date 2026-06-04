import { z } from "zod";

/**
 * Server-pushed events over the `/events` stream and related WS channels:
 * git clone/checkout progress, LSP server install progress, PR freshness, and
 * the auth-required prompt trigger.
 */

export const gitProgressEvent = z.object({
  type: z.literal("git/progress"),
  worktreeId: z.string(),
  phase: z.enum(["cloning", "fetching", "checkingOut", "ready", "error"]),
  /** 0..1 when known. */
  progress: z.number().min(0).max(1).optional(),
  message: z.string().optional(),
});
export type GitProgressEvent = z.infer<typeof gitProgressEvent>;

export const lspInstallRequiredEvent = z.object({
  type: z.literal("lsp/install-required"),
  worktreeId: z.string(),
  language: z.string(), // typescript | go | rust | cpp | csharp
  serverName: z.string(),
});
export type LspInstallRequiredEvent = z.infer<typeof lspInstallRequiredEvent>;

export const lspInstallProgressEvent = z.object({
  type: z.literal("lsp/install-progress"),
  language: z.string(),
  phase: z.enum(["downloading", "extracting", "ready", "error"]),
  progress: z.number().min(0).max(1).optional(),
  message: z.string().optional(),
});
export type LspInstallProgressEvent = z.infer<typeof lspInstallProgressEvent>;

export const lspStatusEvent = z.object({
  type: z.literal("lsp/status"),
  worktreeId: z.string(),
  language: z.string(),
  /** Whether cross-file navigation is ready (server indexed the workspace). */
  navReady: z.boolean(),
});
export type LspStatusEvent = z.infer<typeof lspStatusEvent>;

export const prActivityEvent = z.object({
  type: z.literal("pr/activity"),
  org: z.string(),
  repositoryId: z.string(),
  pullRequestId: z.number(),
  /** New threads/comments/pushes detected since last poll. */
  hasNewActivity: z.boolean(),
});
export type PrActivityEvent = z.infer<typeof prActivityEvent>;

export const authRequiredEvent = z.object({
  type: z.literal("auth/required"),
  org: z.string(),
});
export type AuthRequiredEvent = z.infer<typeof authRequiredEvent>;

export const serverEvent = z.discriminatedUnion("type", [
  gitProgressEvent,
  lspInstallRequiredEvent,
  lspInstallProgressEvent,
  lspStatusEvent,
  prActivityEvent,
  authRequiredEvent,
]);
export type ServerEvent = z.infer<typeof serverEvent>;
