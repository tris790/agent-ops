import type { LanguageId } from "./types.js";

/** Maps a file path to a Monaco language id for syntax highlighting. */
const BY_EXT: Record<string, LanguageId> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  cs: "csharp",
  go: "go",
  rs: "rust",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  py: "python",
  java: "java",
  rb: "ruby",
  php: "php",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  ksh: "shell",
  yml: "yaml",
  yaml: "yaml",
  jsonc: "json",
  toml: "ini",
  ini: "ini",
  md: "markdown",
  markdown: "markdown",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  sql: "sql",
  xml: "xml",
  dockerfile: "dockerfile",
};

export function languageForPath(path: string): LanguageId {
  const base = path.split("/").pop() ?? path;
  const lower = base.toLowerCase();
  if (lower === "dockerfile" || lower === "containerfile" || lower.endsWith(".dockerfile"))
    return "dockerfile";
  const ext = base.includes(".") ? base.split(".").pop()!.toLowerCase() : "";
  return BY_EXT[ext] ?? "plaintext";
}
