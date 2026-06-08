import { z } from "zod";
import {
  adoPipeline,
  adoRun,
  type AdoPipeline,
  type AdoPipelineParameter,
  type AdoRun,
} from "@agent-ops/shared";
import type { AdoClient } from "./client.js";

/**
 * Azure DevOps Pipelines operations (project-scoped `_apis/pipelines/...`):
 * list pipelines, list/get runs, queue a run, and fetch a run's logs.
 */

const proj = (project: string) => `${encodeURIComponent(project)}/`;

export async function listPipelines(client: AdoClient, project: string): Promise<AdoPipeline[]> {
  return client.getList(`${proj(project)}_apis/pipelines`, adoPipeline);
}

export async function listRuns(
  client: AdoClient,
  project: string,
  pipelineId: number,
): Promise<AdoRun[]> {
  return client.getList(`${proj(project)}_apis/pipelines/${pipelineId}/runs`, adoRun);
}

export async function getRun(
  client: AdoClient,
  project: string,
  pipelineId: number,
  runId: number,
): Promise<AdoRun> {
  return client.getOne(`${proj(project)}_apis/pipelines/${pipelineId}/runs/${runId}`, adoRun);
}

/** Queues a new run of a pipeline (optionally on a branch ref, with template params). */
export async function queueRun(
  client: AdoClient,
  project: string,
  pipelineId: number,
  refName?: string,
  templateParameters?: Record<string, string>,
): Promise<AdoRun> {
  const body: Record<string, unknown> = {};
  if (refName) body.resources = { repositories: { self: { refName } } };
  if (templateParameters && Object.keys(templateParameters).length > 0) {
    body.templateParameters = templateParameters;
  }
  return client.send("POST", `${proj(project)}_apis/pipelines/${pipelineId}/runs`, body, adoRun);
}

/** Pipeline definition: YAML config (path + repo) and the default branch. */
const pipelineDef = z
  .object({
    configuration: z
      .object({
        type: z.string().optional(),
        path: z.string().optional(),
        repository: z.object({ id: z.string() }).passthrough().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const itemContent = z.object({ content: z.string() }).passthrough();
const repoMeta = z.object({ defaultBranch: z.string().optional() }).passthrough();

export interface PipelineParameters {
  parameters: AdoPipelineParameter[];
  /** Short default branch name (e.g. "main"), best-effort. */
  defaultBranch?: string;
}

/**
 * Returns a YAML pipeline's declared runtime `parameters:` and its repo's default
 * branch, so the queue UI can render typed inputs and pre-fill the branch. We read
 * the pipeline's source YAML (via the Git items API) and parse only the top-level
 * `parameters:` block — no YAML dependency. Non-YAML (classic) pipelines or parse
 * failures yield an empty parameter list (the UI falls back to branch-only).
 */
export async function getPipelineParameters(
  client: AdoClient,
  project: string,
  pipelineId: number,
): Promise<PipelineParameters> {
  const def = await client.getOne(`${proj(project)}_apis/pipelines/${pipelineId}`, pipelineDef);
  const cfg = def.configuration;
  const repoId = cfg?.repository?.id;
  const yamlPath = cfg?.path;
  if (!repoId || !yamlPath) return { parameters: [] };

  let defaultBranch: string | undefined;
  const repo = await client
    .getOne(`${proj(project)}_apis/git/repositories/${repoId}`, repoMeta)
    .catch(() => null);
  if (repo?.defaultBranch) defaultBranch = repo.defaultBranch.replace(/^refs\/heads\//, "");

  const item = await client
    .getOne(`${proj(project)}_apis/git/repositories/${repoId}/items`, itemContent, {
      query: { path: yamlPath, $format: "text", includeContent: "true" },
    })
    .catch(() => null);
  if (!item?.content) return { parameters: [], defaultBranch };

  return { parameters: parseYamlParameters(item.content), defaultBranch };
}

/**
 * Minimal parser for an Azure Pipelines top-level `parameters:` block. Handles the
 * common shape:
 *
 *   parameters:
 *     - name: deployEnv
 *       type: string
 *       default: dev
 *       values:
 *         - dev
 *         - prod
 *
 * This is deliberately small (no YAML dep): it reads the block at column 0, splits
 * list entries, and pulls name/type/default/values. Anything it can't parse is
 * skipped, leaving the UI's branch-only path intact.
 */
export function parseYamlParameters(yaml: string): AdoPipelineParameter[] {
  const lines = yaml.split(/\r?\n/);
  // Find a top-level `parameters:` key (no indentation).
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^parameters:\s*$/.test(lines[i]!)) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return [];

  // Collect the block: lines until the next top-level (column-0, non-blank) key.
  const block: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") {
      block.push(line);
      continue;
    }
    if (/^\S/.test(line)) break; // dedent to column 0 ends the block
    block.push(line);
  }

  const params: AdoPipelineParameter[] = [];
  let current: Partial<AdoPipelineParameter> & { collectingValues?: boolean } = {};
  let valuesIndent = -1;

  const flush = () => {
    if (current.name && current.type) {
      params.push({
        name: current.name,
        type: current.type,
        default: current.default,
        allowed: current.allowed && current.allowed.length > 0 ? current.allowed : undefined,
      });
    }
    current = {};
    valuesIndent = -1;
  };

  for (const raw of block) {
    if (raw.trim() === "") continue;
    const indent = raw.length - raw.trimStart().length;
    const text = raw.trim();

    // A value under a `values:` list ("- dev"). Checked before the list-entry
    // case so an enum value isn't mistaken for a new parameter — it's deeper
    // than the `values:` key that opened the list.
    if (current.collectingValues && text.startsWith("-") && indent > valuesIndent) {
      const v = text.replace(/^-\s*/, "").trim();
      if (v) (current.allowed ??= []).push(stripQuotes(v));
      continue;
    }

    // A new list entry: "- name: x" or "-" then fields.
    if (text.startsWith("- ") || text === "-") {
      flush();
      const after = text.replace(/^-\s*/, "");
      if (after) applyField(current, after);
      continue;
    }

    if (text.startsWith("values:") || text.startsWith("- values:")) {
      current.collectingValues = true;
      valuesIndent = indent;
      continue;
    }

    current.collectingValues = false;
    applyField(current, text);
  }
  flush();
  return params;
}

function applyField(
  target: Partial<AdoPipelineParameter> & { collectingValues?: boolean },
  text: string,
): void {
  const m = /^(\w+):\s*(.*)$/.exec(text);
  if (!m) return;
  const key = m[1]!;
  const value = stripQuotes(m[2]!.trim());
  if (key === "name") target.name = value;
  else if (key === "type") target.type = value;
  else if (key === "default" && value !== "") target.default = value;
}

function stripQuotes(s: string): string {
  return s.replace(/^['"]|['"]$/g, "");
}

const logList = z
  .object({
    logs: z.array(z.object({ id: z.number(), lineCount: z.number().optional() }).passthrough()),
  })
  .passthrough();
const signedLog = z
  .object({ signedContent: z.object({ url: z.string() }).passthrough().optional() })
  .passthrough();

/** Concatenated plaintext logs for a run (fetched via time-limited signed URLs). */
export async function getRunLogs(
  client: AdoClient,
  project: string,
  pipelineId: number,
  runId: number,
): Promise<string> {
  const base = `${proj(project)}_apis/pipelines/${pipelineId}/runs/${runId}/logs`;
  const list = await client.getOne(base, logList);
  const chunks: string[] = [];
  for (const log of list.logs) {
    const signed = await client.getOne(`${base}/${log.id}`, signedLog, {
      query: { $expand: "signedContent" },
    });
    const url = signed.signedContent?.url;
    if (!url) continue;
    // The signed URL is anonymous + time-limited; fetch raw text directly.
    const text = await fetch(url).then((r) => r.text()).catch(() => "");
    if (text) chunks.push(text);
  }
  return chunks.join("\n");
}
