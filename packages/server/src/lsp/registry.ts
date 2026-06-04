import { join } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { paths } from "../config.js";

/**
 * Registry of supported language servers: how to detect a project's language,
 * where the server binary lives under `lsp/<lang>/`, and how to install it.
 *
 * Servers are self-contained in the project's `lsp/` dir (not the system PATH),
 * so installs are reproducible and the app can manage them via the UI prompt.
 */

export type Lang =
  | "typescript"
  | "go"
  | "rust"
  | "cpp"
  | "csharp"
  | "python"
  | "java"
  | "ruby"
  | "php"
  | "bash"
  | "yaml"
  | "json"
  | "html"
  | "css"
  | "dockerfile";

export interface ServerSpec {
  lang: Lang;
  /** Human label for the install prompt. */
  serverName: string;
  /** Monaco language ids this server handles. */
  languageIds: string[];
  /** File extensions that map to this language. */
  extensions: string[];
  /** Project marker files that indicate this language is present. */
  markers: string[];
  /** Resolves the server launch command if installed under `lsp/<lang>/`, else null. */
  resolve(): Promise<ServerLaunch | null>;
  /** Installs the server into `lsp/<lang>/`. Streams progress via the callback. */
  install(onProgress: (phase: string, msg?: string) => void): Promise<void>;
}

export interface ServerLaunch {
  command: string;
  args: string[];
  /** Extra env for the child process. */
  env?: Record<string, string>;
}

const lspDir = (lang: Lang) => join(paths.lsp, lang);
const isWin = process.platform === "win32";
const binName = (name: string) => (isWin ? `${name}.cmd` : name);
const npmBin = (lang: Lang, name: string) => join(lspDir(lang), "node_modules", ".bin", binName(name));
const toolBin = (lang: Lang, name: string) => join(lspDir(lang), binName(name));

async function which(name: string): Promise<string | null> {
  try {
    const proc = Bun.spawn([isWin ? "where" : "which", name], { stdout: "pipe" });
    const out = (await new Response(proc.stdout).text()).trim().split(/\r?\n/)[0];
    if ((await proc.exited) === 0 && out) return out;
  } catch {
    /* absent */
  }
  return null;
}

/** Runs an install command, streaming a coarse progress signal. */
async function run(
  cmd: string[],
  cwd: string,
  onProgress: (phase: string, msg?: string) => void,
  options?: { env?: Record<string, string> },
): Promise<void> {
  await mkdir(cwd, { recursive: true });
  onProgress("downloading", cmd.join(" "));
  let proc;
  try {
    proc = Bun.spawn(cmd, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...(options?.env ?? {}) },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`install failed (${cmd[0]}): ${message}`);
  }
  const code = await proc.exited;
  if (code !== 0) {
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    const details = [err, out].map((s) => s.trim()).filter(Boolean).join("\n");
    throw new Error(`install failed (${cmd[0]}): ${details.slice(0, 500)}`);
  }
}

async function installNpmTool(
  lang: Lang,
  packages: string[],
  onProgress: (phase: string, msg?: string) => void,
): Promise<void> {
  const dir = lspDir(lang);
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, "package.json"), JSON.stringify({ name: `agent-ops-lsp-${lang}` }));
  await run(["bun", "add", "--no-save", ...packages], dir, onProgress);
  onProgress("ready");
}

/**
 * TypeScript — installed via a local npm prefix into lsp/typescript/.
 * Binary lands at lsp/typescript/node_modules/.bin/typescript-language-server.
 */
const typescriptSpec: ServerSpec = {
  lang: "typescript",
  serverName: "typescript-language-server",
  languageIds: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
  extensions: ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"],
  markers: ["tsconfig.json", "jsconfig.json", "package.json"],
  async resolve() {
    const bin = npmBin("typescript", "typescript-language-server");
    if (!existsSync(bin)) return null;
    return { command: bin, args: ["--stdio"] };
  },
  async install(onProgress) {
    await installNpmTool("typescript", ["typescript-language-server", "typescript"], onProgress);
  },
};

/** Go — `go install gopls` into a GOBIN under lsp/go/. */
const goSpec: ServerSpec = {
  lang: "go",
  serverName: "gopls",
  languageIds: ["go"],
  extensions: ["go"],
  markers: ["go.mod", "go.sum"],
  async resolve() {
    const bin = join(lspDir("go"), "bin", binName("gopls"));
    if (!existsSync(bin)) return null;
    return { command: bin, args: [] };
  },
  async install(onProgress) {
    const dir = lspDir("go");
    const bin = join(dir, "bin");
    await mkdir(bin, { recursive: true });
    await run(["go", "install", "golang.org/x/tools/gopls@latest"], dir, onProgress, {
      env: { GOBIN: bin },
    });
    onProgress("ready");
  },
};

/** Rust — `rustup component add rust-analyzer`; binary located via rustup. */
const rustSpec: ServerSpec = {
  lang: "rust",
  serverName: "rust-analyzer",
  languageIds: ["rust"],
  extensions: ["rs"],
  markers: ["Cargo.toml"],
  async resolve() {
    // rust-analyzer is installed system-wide via rustup; locate via `rustup which`.
    try {
      const proc = Bun.spawn(["rustup", "which", "rust-analyzer"], { stdout: "pipe" });
      const out = (await new Response(proc.stdout).text()).trim();
      if ((await proc.exited) === 0 && out && existsSync(out)) {
        return { command: out, args: [] };
      }
    } catch {
      /* rustup absent */
    }
    return null;
  },
  async install(onProgress) {
    await run(["rustup", "component", "add", "rust-analyzer"], paths.lsp, onProgress);
    onProgress("ready");
  },
};

/** C/C++ — clangd (expects system clangd or LLVM); needs compile_commands.json. */
const cppSpec: ServerSpec = {
  lang: "cpp",
  serverName: "clangd",
  languageIds: ["c", "cpp"],
  extensions: ["c", "h", "cc", "cpp", "cxx", "hpp", "hxx"],
  markers: ["compile_commands.json", "CMakeLists.txt", "Makefile"],
  async resolve() {
    const local = toolBin("cpp", "clangd");
    if (existsSync(local)) return { command: local, args: [] };
    const system = await which("clangd");
    if (system) return { command: system, args: [] };
    return null;
  },
  async install(onProgress) {
    // clangd ships with LLVM; we can't reliably download cross-platform here.
    onProgress("error", "Install clangd via your package manager (apt/brew/winget install clangd)");
    throw new Error("clangd must be installed via the system package manager");
  },
};

/** C# — Roslyn, matching VS Code's modern C# extension/C# Dev Kit direction. */
const csharpSpec: ServerSpec = {
  lang: "csharp",
  serverName: "roslyn-language-server",
  languageIds: ["csharp"],
  extensions: ["cs"],
  markers: ["*.csproj", "*.sln", "global.json"],
  async resolve() {
    // One C# server: Roslyn (Microsoft.CodeAnalysis.LanguageServer), the exact
    // engine behind VS Code's C# extension. The `roslyn-language-server` dotnet
    // tool wraps it. It speaks plain --stdio LSP; we drive the solution/project
    // load handshake ourselves (manager.bootstrapSession).
    const args = ["--stdio", "--logLevel", "Information"];
    const local = toolBin("csharp", "roslyn-language-server");
    if (existsSync(local)) return { command: local, args };
    const system = await which("roslyn-language-server");
    if (system) return { command: system, args };
    return null;
  },
  async install(onProgress) {
    // The roslyn-language-server tool lives on the Azure DevOps vs-impl feed, not
    // the default nuget.org — installing without that source fails. Pin it.
    const dir = lspDir("csharp");
    await mkdir(dir, { recursive: true });
    await run(
      [
        "dotnet",
        "tool",
        "install",
        "--tool-path",
        dir,
        "roslyn-language-server",
        "--prerelease",
      ],
      dir,
      onProgress,
    );
    onProgress("ready");
  },
};

/** Python — Pyright is Microsoft's open LSP and closest standalone Pylance peer. */
const pythonSpec: ServerSpec = {
  lang: "python",
  serverName: "pyright",
  languageIds: ["python"],
  extensions: ["py", "pyi"],
  markers: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile", "poetry.lock"],
  async resolve() {
    const bin = npmBin("python", "pyright-langserver");
    if (!existsSync(bin)) return null;
    return { command: bin, args: ["--stdio"] };
  },
  async install(onProgress) {
    await installNpmTool("python", ["pyright"], onProgress);
  },
};

/** Java — Eclipse JDT LS, the server behind VS Code Java language support. */
const javaSpec: ServerSpec = {
  lang: "java",
  serverName: "jdtls",
  languageIds: ["java"],
  extensions: ["java"],
  markers: ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "gradlew", ".project"],
  async resolve() {
    const local = toolBin("java", "jdtls");
    if (existsSync(local)) return { command: local, args: [] };
    const system = await which("jdtls");
    if (system) return { command: system, args: [] };
    return null;
  },
  async install(onProgress) {
    onProgress("error", "Install Eclipse JDT LS as `jdtls` on PATH");
    throw new Error("jdtls must be installed via your system package manager or SDKMAN");
  },
};

/** Ruby — Shopify Ruby LSP, the current VS Code Ruby extension server. */
const rubySpec: ServerSpec = {
  lang: "ruby",
  serverName: "ruby-lsp",
  languageIds: ["ruby"],
  extensions: ["rb", "rake", "gemspec"],
  markers: ["Gemfile", ".ruby-version", "Rakefile"],
  async resolve() {
    const local = toolBin("ruby", "ruby-lsp");
    if (existsSync(local)) return { command: local, args: [] };
    const system = await which("ruby-lsp");
    if (system) return { command: system, args: [] };
    return null;
  },
  async install(onProgress) {
    const dir = lspDir("ruby");
    await mkdir(dir, { recursive: true });
    await run(["gem", "install", "--install-dir", dir, "--bindir", dir, "ruby-lsp"], dir, onProgress);
    onProgress("ready");
  },
};

/** PHP — Intelephense, the common VS Code PHP LSP. */
const phpSpec: ServerSpec = {
  lang: "php",
  serverName: "intelephense",
  languageIds: ["php"],
  extensions: ["php", "phtml"],
  markers: ["composer.json", "composer.lock"],
  async resolve() {
    const bin = npmBin("php", "intelephense");
    if (!existsSync(bin)) return null;
    return { command: bin, args: ["--stdio"] };
  },
  async install(onProgress) {
    await installNpmTool("php", ["intelephense"], onProgress);
  },
};

const bashSpec: ServerSpec = {
  lang: "bash",
  serverName: "bash-language-server",
  languageIds: ["shell"],
  extensions: ["sh", "bash", "zsh", "ksh"],
  markers: [".bashrc", ".zshrc"],
  async resolve() {
    const bin = npmBin("bash", "bash-language-server");
    if (!existsSync(bin)) return null;
    return { command: bin, args: ["start"] };
  },
  async install(onProgress) {
    await installNpmTool("bash", ["bash-language-server"], onProgress);
  },
};

const yamlSpec: ServerSpec = {
  lang: "yaml",
  serverName: "yaml-language-server",
  languageIds: ["yaml"],
  extensions: ["yaml", "yml"],
  markers: [".yamllint", ".prettierrc.yaml", ".prettierrc.yml"],
  async resolve() {
    const bin = npmBin("yaml", "yaml-language-server");
    if (!existsSync(bin)) return null;
    return { command: bin, args: ["--stdio"] };
  },
  async install(onProgress) {
    await installNpmTool("yaml", ["yaml-language-server"], onProgress);
  },
};

const jsonSpec: ServerSpec = {
  lang: "json",
  serverName: "vscode-json-language-server",
  languageIds: ["json"],
  extensions: ["json", "jsonc"],
  markers: [".prettierrc", ".eslintrc", "tsconfig.json", "jsconfig.json", "package.json"],
  async resolve() {
    const bin = npmBin("json", "vscode-json-language-server");
    if (!existsSync(bin)) return null;
    return { command: bin, args: ["--stdio"] };
  },
  async install(onProgress) {
    await installNpmTool("json", ["vscode-langservers-extracted"], onProgress);
  },
};

const htmlSpec: ServerSpec = {
  lang: "html",
  serverName: "vscode-html-language-server",
  languageIds: ["html"],
  extensions: ["html", "htm"],
  markers: ["index.html"],
  async resolve() {
    const bin = npmBin("html", "vscode-html-language-server");
    if (!existsSync(bin)) return null;
    return { command: bin, args: ["--stdio"] };
  },
  async install(onProgress) {
    await installNpmTool("html", ["vscode-langservers-extracted"], onProgress);
  },
};

const cssSpec: ServerSpec = {
  lang: "css",
  serverName: "vscode-css-language-server",
  languageIds: ["css", "scss", "less"],
  extensions: ["css", "scss", "less"],
  markers: [".stylelintrc", ".stylelintrc.json"],
  async resolve() {
    const bin = npmBin("css", "vscode-css-language-server");
    if (!existsSync(bin)) return null;
    return { command: bin, args: ["--stdio"] };
  },
  async install(onProgress) {
    await installNpmTool("css", ["vscode-langservers-extracted"], onProgress);
  },
};

const dockerfileSpec: ServerSpec = {
  lang: "dockerfile",
  serverName: "docker-langserver",
  languageIds: ["dockerfile"],
  extensions: ["dockerfile"],
  markers: ["Dockerfile", "Containerfile"],
  async resolve() {
    const bin = npmBin("dockerfile", "docker-langserver");
    if (!existsSync(bin)) return null;
    return { command: bin, args: ["--stdio"] };
  },
  async install(onProgress) {
    await installNpmTool("dockerfile", ["dockerfile-language-server-nodejs"], onProgress);
  },
};

export const SERVERS: ServerSpec[] = [
  typescriptSpec,
  goSpec,
  rustSpec,
  cppSpec,
  csharpSpec,
  pythonSpec,
  javaSpec,
  rubySpec,
  phpSpec,
  bashSpec,
  yamlSpec,
  jsonSpec,
  htmlSpec,
  cssSpec,
  dockerfileSpec,
];

const byLang = new Map(SERVERS.map((s) => [s.lang, s]));
export const getServerSpec = (lang: Lang): ServerSpec | undefined => byLang.get(lang);

/**
 * Detects which languages are present in a worktree by scanning markers and a
 * sample of file extensions. Returns the distinct langs, most-relevant first.
 */
export async function detectLanguages(rootDir: string): Promise<Lang[]> {
  const present = new Set<Lang>();

  // Marker files (cheap, authoritative).
  const topLevel = await readdir(rootDir, { withFileTypes: true }).catch(() => []);
  const topNames = new Set(topLevel.filter((e) => e.isFile()).map((e) => e.name));
  for (const spec of SERVERS) {
    for (const marker of spec.markers) {
      if (marker.startsWith("*.")) {
        const ext = marker.slice(1);
        if ([...topNames].some((n) => n.endsWith(ext))) present.add(spec.lang);
      } else if (topNames.has(marker)) {
        present.add(spec.lang);
      }
    }
  }

  // Extension scan (bounded) for languages without a top-level marker.
  const extToLang = new Map<string, Lang>();
  for (const spec of SERVERS) for (const e of spec.extensions) extToLang.set(e, spec.lang);
  await scanExtensions(rootDir, extToLang, present, 0);

  return [...present];
}

/** Recursively sample file extensions, bounded in depth, skipping noise dirs. */
async function scanExtensions(
  dir: string,
  extToLang: Map<string, Lang>,
  out: Set<Lang>,
  depth: number,
): Promise<void> {
  if (depth > 6) return;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.isFile()) {
      const lower = e.name.toLowerCase();
      const ext =
        lower === "dockerfile" || lower === "containerfile" || lower.endsWith(".dockerfile")
          ? "dockerfile"
          : e.name.includes(".")
            ? e.name.split(".").pop()!.toLowerCase()
            : "";
      const lang = extToLang.get(ext);
      if (lang) out.add(lang);
    } else if (e.isDirectory()) {
      if (
        e.name === ".git" ||
        e.name === "node_modules" ||
        e.name === "vendor" ||
        e.name === "dist" ||
        e.name === "build" ||
        e.name === "target"
      ) {
        continue;
      }
      await scanExtensions(join(dir, e.name), extToLang, out, depth + 1);
    }
  }
}
