import { useState } from "react";
import { useActiveOrg, useIdentity } from "./api/useOrg.js";
import { ReviewQueue } from "./screens/ReviewQueue.js";
import { PrView } from "./screens/PrView.js";
import { Config } from "./screens/Config.js";
import { Pipelines } from "./screens/Pipelines.js";
import { CodeBrowser } from "./screens/CodeBrowser.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { useRoute } from "./router.js";

/**
 * App shell + hash routing. The URL is the source of truth for which screen is
 * shown (and, for the PR view, the open file + line), so back/forward work and
 * URLs are shareable. See router.ts for the scheme.
 */
export function App() {
  const { org, isLoading } = useActiveOrg();
  const me = useIdentity(org?.name);
  const { route, navigate } = useRoute();
  // Bumping this opens the command palette (used by the Code nav button to let the
  // user pick a repo+branch to browse).
  const [paletteSignal, setPaletteSignal] = useState(0);

  // No org configured, or token missing/expired -> force config.
  const needsConfig = !org || !org.hasToken || me.isError;
  const screen = needsConfig ? "config" : route.screen;

  return (
    <div>
      <header className="topbar">
        <div className="topbar-left">
          <span
            className="brand"
            onClick={() => navigate({ screen: "queue" })}
            style={{ cursor: "pointer" }}
          >
            agent-ops
          </span>
          {org && <span className="org-pill">{org.name}</span>}
        </div>
        <nav className="topbar-nav">
          <button
            className={screen === "queue" ? "nav-btn active" : "nav-btn"}
            onClick={() => navigate({ screen: "queue" })}
            disabled={needsConfig}
          >
            Review queue
          </button>
          <button
            className={screen === "pipelines" ? "nav-btn active" : "nav-btn"}
            onClick={() => navigate({ screen: "pipelines" })}
            disabled={needsConfig}
          >
            Pipelines
          </button>
          <button
            className={screen === "code" ? "nav-btn active" : "nav-btn"}
            onClick={() => {
              // No repo/branch chosen yet → open the palette to pick one.
              if (route.screen === "code" && route.repoId && route.ref) return;
              setPaletteSignal((s) => s + 1);
            }}
            disabled={needsConfig}
          >
            Code
          </button>
          <button
            className={screen === "config" ? "nav-btn active" : "nav-btn"}
            onClick={() => navigate({ screen: "config" })}
          >
            Config
          </button>
          {me.data?.displayName && <span className="me">{me.data.displayName}</span>}
        </nav>
      </header>

      <main className="content">
        {isLoading && <p>Loading…</p>}

        {screen === "config" && <Config current={org} />}

        {screen === "pipelines" && org && <Pipelines org={org.name} />}

        {screen === "queue" && org && me.data?.id && (
          <ReviewQueue
            org={org.name}
            meId={me.data.id}
            onOpenPr={(pr) =>
              navigate({ screen: "pr", repoId: pr.repository.id, prId: pr.pullRequestId })
            }
          />
        )}

        {screen === "code" && org && route.repoId && route.ref && (
          <CodeBrowser
            key={`${route.repoId}@${route.ref}`}
            org={org.name}
            repositoryId={route.repoId}
            refName={route.ref}
            route={route}
            navigate={navigate}
          />
        )}

        {screen === "pr" && org && me.data?.id && route.repoId && route.prId && (
          <PrView
            key={`${route.repoId}/${route.prId}`}
            org={org.name}
            repositoryId={route.repoId}
            pullRequestId={route.prId}
            meId={me.data.id}
            route={route}
            navigate={navigate}
            onBack={() => navigate({ screen: "queue" })}
          />
        )}
      </main>

      {org && me.data?.id && (
        <CommandPalette
          org={org.name}
          openSignal={paletteSignal}
          onOpenPr={(pr) =>
            navigate({ screen: "pr", repoId: pr.repository.id, prId: pr.pullRequestId })
          }
          onOpenRepo={() => navigate({ screen: "queue" })}
          onOpenCode={(repo, branch) =>
            navigate({ screen: "code", repoId: repo.id, ref: branch })
          }
        />
      )}
    </div>
  );
}
