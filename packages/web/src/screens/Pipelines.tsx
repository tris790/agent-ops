import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdoPipeline, AdoRun, AdoPipelineParameter } from "@agent-ops/shared";
import { api } from "../api/client.js";
import { fuzzyFilter } from "../lib/fuzzy.js";
import { useVirtualList } from "../components/useVirtualList.js";

/** Fixed row height (li height + margin-bottom) — must match `.pipeline-list li` in styles.css. */
const ROW_H = 66;

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
  const [search, setSearch] = useState("");

  // Fuzzy-match name and folder so "ci/build" or "bld" both find the pipeline.
  const filtered = useMemo(
    () =>
      fuzzyFilter(pipelines.data?.pipelines ?? [], search, (p) =>
        `${p.folder && p.folder !== "\\" ? p.folder + " " : ""}${p.name}`,
      ),
    [pipelines.data, search],
  );
  const { scrollRef, onScroll, range, topPad, bottomPad } = useVirtualList<HTMLUListElement>(
    filtered.length,
    ROW_H,
  );

  if (pipelines.isLoading) return <p>Loading pipelines…</p>;
  if (!pipelines.data?.pipelines.length) return <p className="empty">No pipelines in {project}.</p>;

  return (
    <div className="pipeline-layout">
      <div className="pipeline-pane">
        <input
          className="pipeline-search"
          placeholder="Search pipelines…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="pipeline-count">
          {filtered.length} of {pipelines.data.pipelines.length}
        </div>
        <ul className="pipeline-list" ref={scrollRef} onScroll={onScroll}>
          <li style={{ height: topPad, margin: 0, padding: 0, border: "none", background: "none" }} />
          {filtered.slice(range.start, range.end).map((p) => (
            <li
              key={p.id}
              className={selected?.id === p.id ? "sel" : ""}
              onClick={() => setSelected(p)}
            >
              <span className="pipeline-name">{p.name}</span>
              {p.folder && p.folder !== "\\" && <span className="pipeline-folder">{p.folder}</span>}
            </li>
          ))}
          <li style={{ height: bottomPad, margin: 0, padding: 0, border: "none", background: "none" }} />
          {filtered.length === 0 && <li className="empty">No pipelines match.</li>}
        </ul>
      </div>
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
  const [showForm, setShowForm] = useState(false);

  return (
    <div className="runs-view">
      <div className="runs-head">
        <h2>{pipeline.name}</h2>
        <button className="btn-primary" onClick={() => setShowForm((s) => !s)}>
          {showForm ? "Cancel" : "Run pipeline"}
        </button>
      </div>
      {showForm && (
        <QueueForm
          org={org}
          project={project}
          pipeline={pipeline}
          onQueued={() => {
            setShowForm(false);
            void qc.invalidateQueries({ queryKey: ["runs", org, project, pipeline.id] });
          }}
        />
      )}
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

/**
 * Queue form: pick a branch and fill in the pipeline's declared runtime
 * parameters (typed inputs), then queue the run. Parameters and the default
 * branch are fetched lazily when the form opens.
 */
function QueueForm({
  org,
  project,
  pipeline,
  onQueued,
}: {
  org: string;
  project: string;
  pipeline: AdoPipeline;
  onQueued: () => void;
}) {
  const params = useQuery({
    queryKey: ["pipeline-params", org, project, pipeline.id],
    queryFn: () => api.pipelineParameters(org, project, pipeline.id),
  });

  const [branch, setBranch] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});

  // Seed branch + parameter defaults once the schema arrives.
  useEffect(() => {
    if (!params.data) return;
    if (params.data.defaultBranch) setBranch((b) => b || params.data!.defaultBranch!);
    const seed: Record<string, string> = {};
    for (const p of params.data.parameters) if (p.default !== undefined) seed[p.name] = p.default;
    setValues((v) => ({ ...seed, ...v }));
  }, [params.data]);

  const queue = useMutation({
    mutationFn: () => {
      const refName = branch.trim()
        ? branch.startsWith("refs/")
          ? branch.trim()
          : `refs/heads/${branch.trim()}`
        : undefined;
      const tp = Object.keys(values).length ? values : undefined;
      return api.queuePipeline(org, project, pipeline.id, refName, tp);
    },
    onSuccess: onQueued,
  });

  const set = (name: string, value: string) => setValues((v) => ({ ...v, [name]: value }));

  return (
    <div className="queue-form">
      <label className="queue-field">
        <span>Branch</span>
        <input
          placeholder={params.data?.defaultBranch ?? "main"}
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
        />
      </label>

      {params.isLoading && <p className="queue-hint">Loading parameters…</p>}
      {params.data?.parameters.map((p) => (
        <label key={p.name} className="queue-field">
          <span>
            {p.name}
            <em className="queue-type"> ({p.type})</em>
          </span>
          <ParamInput param={p} value={values[p.name] ?? ""} onChange={(v) => set(p.name, v)} />
        </label>
      ))}

      {queue.isError && <p className="err">{(queue.error as Error).message}</p>}
      <button
        className="btn-primary"
        disabled={queue.isPending}
        onClick={() => queue.mutate()}
      >
        {queue.isPending ? "Queuing…" : "Queue run"}
      </button>
    </div>
  );
}

/** Renders a typed input for a pipeline parameter (bool→checkbox, enum→select). */
function ParamInput({
  param,
  value,
  onChange,
}: {
  param: AdoPipelineParameter;
  value: string;
  onChange: (value: string) => void;
}) {
  if (param.type === "boolean") {
    return (
      <input
        type="checkbox"
        checked={value === "true"}
        onChange={(e) => onChange(e.target.checked ? "true" : "false")}
      />
    );
  }
  if (param.allowed && param.allowed.length > 0) {
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {param.allowed.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      type={param.type === "number" ? "number" : "text"}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
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
