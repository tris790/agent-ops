import { z } from "zod";
import { adoPipeline, adoRun, type AdoPipeline, type AdoRun } from "@agent-ops/shared";
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

/** Queues a new run of a pipeline (optionally on a specific branch ref). */
export async function queueRun(
  client: AdoClient,
  project: string,
  pipelineId: number,
  refName?: string,
): Promise<AdoRun> {
  const body = refName
    ? { resources: { repositories: { self: { refName } } } }
    : {};
  return client.send("POST", `${proj(project)}_apis/pipelines/${pipelineId}/runs`, body, adoRun);
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
