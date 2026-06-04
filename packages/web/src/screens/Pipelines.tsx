import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdoPipeline, AdoRun } from "@agent-ops/shared";
import { api } from "../api/client.js";

/**
 * Pipelines: pick a project, see its pipelines, drill into runs (live status),
 * view a run's logs, and queue a new run. Polls runs while one is in progress.
 */
export function Pipelines({ org }: { org: string }) {
  const projects = useQuery({ queryKey: ["projects", org], queryFn: () => api.projects(org) });
  const [project, setProject] = useState<string | null>(null);
  const active = project ?? projects.data?.projects[0]?.name ?? null;

  return (
    <div className="pipelines">
      <div className="pipelines-head">
        <h1>Pipelines</h1>
        {projects.data && projects.data.projects.length > 1 && (
          <select value={active ?? ""} onChange={(e) => setProject(e.target.value)}>
            {projects.data.projects.map((p) => (
              <option key={p.id} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
        )}
      </div>
      {active ? <PipelineList org={org} project={active} /> : <p className="empty">No projects.</p>}
    </div>
  );
}

function PipelineList({ org, project }: { org: string; project: string }) {
  const pipelines = useQuery({
    queryKey: ["pipelines", org, project],
    queryFn: () => api.pipelines(org, project),
  });
  const [selected, setSelected] = useState<AdoPipeline | null>(null);

  if (pipelines.isLoading) return <p>Loading pipelines…</p>;
  if (!pipelines.data?.pipelines.length) return <p className="empty">No pipelines in {project}.</p>;

  return (
    <div className="pipeline-layout">
      <ul className="pipeline-list">
        {pipelines.data.pipelines.map((p) => (
          <li
            key={p.id}
            className={selected?.id === p.id ? "sel" : ""}
            onClick={() => setSelected(p)}
          >
            <span className="pipeline-name">{p.name}</span>
            {p.folder && p.folder !== "\\" && <span className="pipeline-folder">{p.folder}</span>}
          </li>
        ))}
      </ul>
      <div className="pipeline-detail">
        {selected ? (
          <RunsView org={org} project={project} pipeline={selected} />
        ) : (
          <p className="empty">Select a pipeline.</p>
        )}
      </div>
    </div>
  );
}

function RunsView({
  org,
  project,
  pipeline,
}: {
  org: string;
  project: string;
  pipeline: AdoPipeline;
}) {
  const qc = useQueryClient();
  const runs = useQuery({
    queryKey: ["runs", org, project, pipeline.id],
    queryFn: () => api.pipelineRuns(org, project, pipeline.id),
    // Poll while any run is in progress so live status updates.
    refetchInterval: (q) =>
      q.state.data?.runs.some((r) => r.state === "inProgress") ? 5000 : false,
  });
  const [openRun, setOpenRun] = useState<number | null>(null);

  const queue = useMutation({
    mutationFn: () => api.queuePipeline(org, project, pipeline.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["runs", org, project, pipeline.id] }),
  });

  return (
    <div className="runs-view">
      <div className="runs-head">
        <h2>{pipeline.name}</h2>
        <button className="btn-primary" disabled={queue.isPending} onClick={() => queue.mutate()}>
          {queue.isPending ? "Queuing…" : "Run pipeline"}
        </button>
      </div>
      {queue.isError && <p className="err">{(queue.error as Error).message}</p>}
      {runs.isLoading && <p>Loading runs…</p>}
      {runs.data?.runs.length === 0 && <p className="empty">No runs yet.</p>}
      <ul className="run-list">
        {runs.data?.runs.map((r) => (
          <RunRow
            key={r.id}
            run={r}
            open={openRun === r.id}
            onToggle={() => setOpenRun(openRun === r.id ? null : r.id)}
            org={org}
            project={project}
            pipelineId={pipeline.id}
          />
        ))}
      </ul>
    </div>
  );
}

function RunRow({
  run,
  open,
  onToggle,
  org,
  project,
  pipelineId,
}: {
  run: AdoRun;
  open: boolean;
  onToggle: () => void;
  org: string;
  project: string;
  pipelineId: number;
}) {
  const logs = useQuery({
    queryKey: ["runlogs", org, project, pipelineId, run.id],
    queryFn: () => api.pipelineLogs(org, project, pipelineId, run.id),
    enabled: open,
  });

  return (
    <li className="run-row">
      <div className="run-summary" onClick={onToggle}>
        <span className={`run-status ${run.result ?? run.state ?? ""}`}>
          {statusIcon(run.state, run.result)}
        </span>
        <span className="run-name">{run.name ?? `Run ${run.id}`}</span>
        <span className="run-meta">
          {run.createdDate ? new Date(run.createdDate).toLocaleString() : ""}
        </span>
        <span className="run-caret">{open ? "▾" : "▸"}</span>
      </div>
      {open && (
        <div className="run-logs">
          {logs.isLoading && <p className="empty">Loading logs…</p>}
          {logs.data && <pre>{logs.data.logs || "(no logs)"}</pre>}
        </div>
      )}
    </li>
  );
}

function statusIcon(state?: string, result?: string): string {
  if (state === "inProgress") return "●";
  if (result === "succeeded") return "✓";
  if (result === "failed") return "✕";
  if (result === "canceled") return "⊘";
  return "•";
}
