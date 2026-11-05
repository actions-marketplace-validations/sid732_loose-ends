import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import fg from "fast-glob";
import { toRelative } from "./paths.js";

export interface PackageJson {
  name?: string;
  main?: string;
  module?: string;
  browser?: string | Record<string, string | false>;
  types?: string;
  bin?: string | Record<string, string>;
  exports?: unknown;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
  /** Node.js subpath imports (`#internal/*`). */
  imports?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface WorkspacePackage {
  name: string;
  /** Directory relative to the project root ("" for the root package). */
  dir: string;
  manifest: PackageJson;
}

export function readPackageJson(path: string): PackageJson | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PackageJson;
  } catch {
    return undefined;
  }
}

/** Discover the root package and every workspace package (npm, yarn, pnpm). */
export function discoverPackages(root: string): WorkspacePackage[] {
  const rootManifest = readPackageJson(join(root, "package.json"));
  const out: WorkspacePackage[] = [];
  if (rootManifest) out.push({ name: rootManifest.name ?? "", dir: "", manifest: rootManifest });

  const patterns = new Set<string>();
  const ws = rootManifest?.workspaces;
  for (const p of Array.isArray(ws) ? ws : ws?.packages ?? []) patterns.add(p);
  for (const p of readPnpmWorkspace(root)) patterns.add(p);
  if (patterns.size === 0) return out;

  const include = [...patterns].filter((p) => !p.startsWith("!")).map((p) => `${p.replace(/\/$/, "")}/package.json`);
  const exclude = [...patterns].filter((p) => p.startsWith("!")).map((p) => `${p.slice(1).replace(/\/$/, "")}/package.json`);
  const manifests = fg.sync(include, { cwd: root, ignore: ["**/node_modules/**", ...exclude], onlyFiles: true });
  for (const rel of manifests.sort()) {
    const manifest = readPackageJson(join(root, rel));
    if (!manifest) continue;
    const dir = toRelative(root, dirname(join(root, rel)));
    out.push({ name: manifest.name ?? dir, dir, manifest });
  }
  return out;
}

/** Minimal reader for the `packages:` list in pnpm-workspace.yaml. */
function readPnpmWorkspace(root: string): string[] {
  const file = join(root, "pnpm-workspace.yaml");
  if (!existsSync(file)) return [];
  const out: string[] = [];
  let inPackages = false;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "");
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const match = /^\s*-\s*['"]?([^'"]+?)['"]?\s*$/.exec(line);
      if (match?.[1]) out.push(match[1]);
      else if (/^\S/.test(line)) inPackages = false;
    }
  }
  return out;
}

const CONDITION_ORDER = ["source", "development", "import", "module", "node", "require", "default", "browser"];

/**
 * Resolve the target of a package.json `exports` field for a subpath like
 * "." or "./utils". Supports string, condition objects, and `*` patterns.
 */
export function resolveExports(exportsField: unknown, subpath: string, importsField = false): string[] {
  if (exportsField === undefined || exportsField === null) return [];
  if (typeof exportsField === "string" || Array.isArray(exportsField)) {
    return subpath === "." ? flattenTarget(exportsField) : [];
  }
  if (typeof exportsField !== "object") return [];
  const map = exportsField as Record<string, unknown>;
  const keys = Object.keys(map);
  const isSubpathMap = importsField || keys.some((k) => k.startsWith("."));
  if (!isSubpathMap) return subpath === "." ? flattenTarget(map) : [];
  if (subpath in map) return flattenTarget(map[subpath]);
  for (const key of keys) {
    const star = key.indexOf("*");
    if (star === -1) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (subpath.startsWith(prefix) && subpath.endsWith(suffix) && subpath.length >= prefix.length + suffix.length) {
      const matched = subpath.slice(prefix.length, subpath.length - suffix.length);
      return flattenTarget(map[key]).map((t) => t.replace(/\*/g, matched));
    }
  }
  return [];
}

/** All concrete file targets of an exports entry, in condition priority order. */
export function flattenTarget(target: unknown): string[] {
  if (typeof target === "string") return [target];
  if (Array.isArray(target)) return target.flatMap(flattenTarget);
  if (target && typeof target === "object") {
    const map = target as Record<string, unknown>;
    const keys = Object.keys(map).sort((a, b) => rank(a) - rank(b));
    return keys.filter((k) => k !== "types").flatMap((k) => flattenTarget(map[k]));
  }
  return [];
}

function rank(condition: string): number {
  const i = CONDITION_ORDER.indexOf(condition);
  return i === -1 ? CONDITION_ORDER.length : i;
}

/** Every entry file declared by a manifest: main, module, bin, and exports. */
export function manifestEntries(manifest: PackageJson): string[] {
  const out = new Set<string>();
  for (const key of ["main", "module"] as const) {
    if (typeof manifest[key] === "string") out.add(manifest[key] as string);
  }
  if (typeof manifest.browser === "string") out.add(manifest.browser);
  if (typeof manifest.bin === "string") out.add(manifest.bin);
  else if (manifest.bin) for (const v of Object.values(manifest.bin)) out.add(v);
  collectExportTargets(manifest.exports, out);
  return [...out];
}

function collectExportTargets(field: unknown, out: Set<string>) {
  if (typeof field === "string") out.add(field);
  else if (Array.isArray(field)) field.forEach((f) => collectExportTargets(f, out));
  else if (field && typeof field === "object") {
    for (const [key, value] of Object.entries(field as Record<string, unknown>)) {
      if (key === "types") continue;
      collectExportTargets(value, out);
    }
  }
}
