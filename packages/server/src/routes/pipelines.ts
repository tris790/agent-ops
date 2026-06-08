import { json, BadRequestError, parseBody } from "../http.js";
import { z } from "zod";
import { AdoClient } from "../ado/client.js";
import { PatTokenProvider } from "../ado/token-provider.js";
import { listProjects } from "../ado/api.js";
import {
  listPipelines,
  listRuns,
  queueRun,
  getRunLogs,
  getPipelineParameters,
} from "../ado/pipelines.js";
import { cached } from "../store/cache.js";

/** Pipelines routes: projects, pipelines, runs, queue, and run logs. */

const tokens = new PatTokenProvider();
const now = () => Date.now();

function client(url: URL): AdoClient {
  return AdoClient.forOrg(url.searchParams.get("org") ?? "", tokens);
}
function required(url: URL, name: string): string {
  const v = url.searchParams.get(name);
  if (!v) throw new BadRequestError(`missing required query param: ${name}`);
  return v;
}

const queueRequest = z.object({
  org: z.string(),
  project: z.string(),
  pipelineId: z.number(),
  refName: z.string().optional(),
  templateParameters: z.record(z.string()).optional(),
});

export async function handlePipelineRoutes(req: Request, url: URL): Promise<Response | null> {
  // GET /api/projects?org=  (pipelines are project-scoped) — cached 10m
  if (url.pathname === "/api/projects" && req.method === "GET") {
    const org = required(url, "org");
    const projects = await cached(`projects:${org}`, 10 * 60_000, now(), () =>
      listProjects(client(url)),
    );
    return json({ projects });
  }

  // GET /api/pipelines?org=&project=
  if (url.pathname === "/api/pipelines" && req.method === "GET") {
    const project = required(url, "project");
    return json({ pipelines: await listPipelines(client(url), project) });
  }

  // GET /api/pipelines/parameters?org=&project=&pipelineId=
  // Declared runtime template parameters + the repo's default branch.
  if (url.pathname === "/api/pipelines/parameters" && req.method === "GET") {
    const project = required(url, "project");
    const pipelineId = Number(required(url, "pipelineId"));
    return json(await getPipelineParameters(client(url), project, pipelineId));
  }

  // GET /api/pipelines/runs?org=&project=&pipelineId=
  if (url.pathname === "/api/pipelines/runs" && req.method === "GET") {
    const project = required(url, "project");
    const pipelineId = Number(required(url, "pipelineId"));
    return json({ runs: await listRuns(client(url), project, pipelineId) });
  }

  // GET /api/pipelines/logs?org=&project=&pipelineId=&runId=
  if (url.pathname === "/api/pipelines/logs" && req.method === "GET") {
    const project = required(url, "project");
    const pipelineId = Number(required(url, "pipelineId"));
    const runId = Number(required(url, "runId"));
    const logs = await getRunLogs(client(url), project, pipelineId, runId);
    return json({ logs });
  }

  // POST /api/pipelines/queue  { org, project, pipelineId, refName? }
  if (url.pathname === "/api/pipelines/queue" && req.method === "POST") {
    const b = await parseBody(req, queueRequest);
    const run = await queueRun(
      AdoClient.forOrg(b.org, tokens),
      b.project,
      b.pipelineId,
      b.refName,
      b.templateParameters,
    );
    return json(run);
  }

  return null;
}
