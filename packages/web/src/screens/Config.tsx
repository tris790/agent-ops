import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { normalizeOrgBaseUrl, type OrgConfig } from "@agent-ops/shared";
import { api } from "../api/client.js";

/**
 * Organization configuration: set the org's base URL + PAT. Single-org — saving
 * here is how the user points agent-ops at their Azure DevOps. The PAT is stored
 * locally and never echoed back.
 */
export function Config({ current }: { current: OrgConfig | null }) {
  const qc = useQueryClient();
  const [name, setName] = useState(current?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(current?.baseUrl ?? "");
  const [pat, setPat] = useState("");
  const hasSavedToken = Boolean(current?.hasToken && name.trim() === current.name);
  const canSave = Boolean(name.trim() && baseUrl.trim() && (pat.trim() || hasSavedToken));

  useEffect(() => {
    if (!current) return;
    setName(current.name);
    setBaseUrl(current.baseUrl);
    setPat("");
  }, [current?.name, current?.baseUrl]);

  const save = useMutation({
    mutationFn: () => api.setToken(name.trim(), baseUrl.trim(), pat.trim() || undefined),
    onSuccess: () => {
      setPat("");
      void qc.invalidateQueries();
    },
  });

  return (
    <div className="config">
      <h1>Organization</h1>
      <p className="hint">
        Point agent-ops at your Azure DevOps organization. Your PAT is stored locally in{" "}
        <code>data/agent-ops.db</code> and never leaves this machine. Generate one at{" "}
        <code>https://&lt;org&gt;.visualstudio.com/_usersSettings/tokens</code> with at least{" "}
        <strong>Code (Read &amp; Write)</strong>.
      </p>

      <form
        className="config-form"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <label>
          Organization name
          <input
            placeholder="e.g. tris790"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          Base URL
          <input
            placeholder="https://tris790.visualstudio.com"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            onBlur={() => {
              if (!baseUrl && name) setBaseUrl(`https://${name}.visualstudio.com`);
              else if (baseUrl) setBaseUrl(normalizeOrgBaseUrl(baseUrl));
            }}
          />
        </label>
        <label>
          Personal access token
          <input
            type="password"
            placeholder={hasSavedToken ? "Paste a new PAT to replace the saved one" : "Paste your PAT"}
            value={pat}
            onChange={(e) => setPat(e.target.value)}
          />
          {hasSavedToken && !pat && <span className="token-status">Token saved locally.</span>}
        </label>
        <button type="submit" disabled={!canSave || save.isPending}>
          {save.isPending ? "Saving…" : "Save"}
        </button>
        {save.isError && <span className="err">{(save.error as Error).message}</span>}
        {save.isSuccess && <span className="ok-msg">Saved.</span>}
      </form>
    </div>
  );
}
