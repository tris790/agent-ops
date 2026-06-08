# Todo

## Done
- [x] support https://www.dev.azure.com/<ORG>  (normalizeOrgBaseUrl)
- [x] LSP errors surfaced in the server log — generic `window/showMessage` +
      `window/logMessage` (Error/Warning) are now printed, plus louder crash-exit
      logs. This is where a failed `dotnet restore` against a private NuGet feed
      shows up. (server-only, per request)
- [x] Repository dropdown: filter by project first, then repo (CodePicker drill-down)
- [x] User/repo/pipeline dropdowns: fast fuzzy search + virtualization (no lag at 1-2k)
- [x] Install-LSP pills → single dropdown with per-language install actions
- [x] Queuing pipeline: branch picker + typed runtime template parameters
      (boolean→checkbox, enum→select, string/number→text), seeded with defaults
- [x] Pipeline search: project filter + fast fuzzy search + virtualized list

## Still open / follow-ups
- User filter currently lists whatever `/api/users` returns merged with PR authors.
  If the full 1-2k AD directory isn't coming back, that's a server data-completeness
  task (Graph users paging), not the dropdown — verify against the real org.
- Pipeline parameter parsing is a minimal hand-rolled YAML reader (no dep). It covers
  the common `parameters:` block; exotic shapes (object/step params, anchors) fall
  back to branch-only. Revisit if a real pipeline doesn't surface its params.
- Pipeline branch field is free-text (defaults to the repo's default branch). Could
  add branch autocomplete later if useful.
