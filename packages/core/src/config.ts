import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DormantRule, FindingKind, FrameworkName, LooseEndsConfig, Suppression } from "./types.js";

export const CONFIG_FILES = ["loose-ends.config.json", ".loose-endsrc.json"] as const;

export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;

export const DEFAULT_INCLUDE = ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"];

export const DEFAULT_EXCLUDE = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/coverage/**",
  "**/.next/**",
  "**/.turbo/**",
  "**/.git/**",
  "**/.cache/**",
  "**/.vercel/**",
  "**/.netlify/**",
  "**/.output/**",
  "**/.yarn/**",
  "**/.pnpm-store/**",
  "**/storybook-static/**",
  "**/*.d.ts",
  "**/*.min.js",
];

export const DEFAULT_TEST_PATTERNS = [
  "**/*.{test,spec}.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
  "**/__tests__/**",
  "**/__mocks__/**",
  "**/test/**",
  "**/tests/**",
  "**/e2e/**",
  "**/*.stories.{ts,tsx,js,jsx,mdx}",
  "**/fixtures/**",
];

export const DEFAULT_FAIL_ON: FindingKind[] = [
  "orphaned-addition",
  "newly-orphaned",
  "superseded",
  "invalid-suppression",
];

const FINDING_KINDS: readonly FindingKind[] = [
  "orphaned-addition",
  "test-only-addition",
  "newly-orphaned",
  "newly-test-only",
  "superseded",
  "unused-dependency",
  "uncertain",
  "invalid-suppression",
];

const FRAMEWORKS: readonly FrameworkName[] = ["node", "next", "react", "express", "vite", "jest", "vitest", "storybook"];

export class ConfigError extends Error {
  constructor(message: string, readonly source?: string) {
    super(source ? `${source}: ${message}` : message);
    this.name = "ConfigError";
  }
}

export function defaultConfig(root: string): LooseEndsConfig {
  return {
    root: resolve(root),
    include: [...DEFAULT_INCLUDE],
    exclude: [...DEFAULT_EXCLUDE],
    entries: [],
    testPatterns: [...DEFAULT_TEST_PATTERNS],
    frameworks: "auto",
    dormant: [],
    suppressions: [],
    checks: [],
    failOn: [...DEFAULT_FAIL_ON],
    dependencies: true,
  };
}

/**
 * Load configuration for a project root. Looks for `loose-ends.config.json`,
 * `.loose-endsrc.json`, then a `looseEnds` key in package.json.
 */
export function loadConfig(root: string, overrides: Partial<LooseEndsConfig> = {}): LooseEndsConfig {
  const absRoot = resolve(root);
  const found = findConfig(absRoot);
  const base = defaultConfig(absRoot);
  const merged = found ? mergeConfig(base, parseConfig(found.raw, found.path), found.path) : base;
  return { ...merged, ...stripUndefined(overrides), root: absRoot };
}

function findConfig(root: string): { path: string; raw: unknown } | undefined {
  for (const name of CONFIG_FILES) {
    const path = join(root, name);
    if (existsSync(path)) return { path, raw: readJson(path) };
  }
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = readJson(pkgPath) as Record<string, unknown>;
    if (pkg && typeof pkg === "object" && "looseEnds" in pkg) {
      return { path: `${pkgPath}#looseEnds`, raw: pkg.looseEnds };
    }
  }
  return undefined;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ConfigError(`invalid JSON (${(error as Error).message})`, path);
  }
}

type RawConfig = Partial<Omit<LooseEndsConfig, "root" | "source">> & {
  extendInclude?: string[];
  extendExclude?: string[];
  extendTestPatterns?: string[];
};

/** Validate an untyped config object. Throws ConfigError with a precise message. */
export function parseConfig(raw: unknown, source?: string): RawConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError("config must be a JSON object", source);
  }
  const input = raw as Record<string, unknown>;
  const out: RawConfig = {};
  const known = new Set([
    "$schema",
    "include",
    "exclude",
    "extendInclude",
    "extendExclude",
    "entries",
    "testPatterns",
    "extendTestPatterns",
    "frameworks",
    "dormant",
    "suppressions",
    "checks",
    "failOn",
    "tsconfig",
    "coverage",
    "dependencies",
  ]);
  for (const key of Object.keys(input)) {
    if (!known.has(key)) throw new ConfigError(`unknown option "${key}"`, source);
  }

  for (const key of ["include", "exclude", "extendInclude", "extendExclude", "entries", "testPatterns", "extendTestPatterns", "checks"] as const) {
    if (key in input) out[key] = stringArray(input[key], key, source);
  }
  if ("frameworks" in input) {
    const value = input.frameworks;
    if (value === "auto") out.frameworks = "auto";
    else {
      const list = stringArray(value, "frameworks", source);
      for (const name of list) {
        if (!FRAMEWORKS.includes(name as FrameworkName)) {
          throw new ConfigError(`unknown framework "${name}" (expected one of ${FRAMEWORKS.join(", ")})`, source);
        }
      }
      out.frameworks = list as FrameworkName[];
    }
  }
  if ("failOn" in input) {
    const list = stringArray(input.failOn, "failOn", source);
    for (const kind of list) {
      if (!FINDING_KINDS.includes(kind as FindingKind)) throw new ConfigError(`unknown finding kind "${kind}" in failOn`, source);
    }
    out.failOn = list as FindingKind[];
  }
  if ("dormant" in input) out.dormant = ruleArray(input.dormant, "dormant", source).map(({ target, reason }) => ({ target, reason }) satisfies DormantRule);
  if ("suppressions" in input) {
    const rules = ruleArray(input.suppressions, "suppressions", source) as unknown as Suppression[];
    for (const rule of rules) {
      if (rule.kind !== undefined && !FINDING_KINDS.includes(rule.kind)) {
        throw new ConfigError(`unknown finding kind "${rule.kind}" in suppression for "${rule.target}"`, source);
      }
      if (rule.expires !== undefined && Number.isNaN(Date.parse(rule.expires))) {
        throw new ConfigError(`invalid expires date "${rule.expires}" in suppression for "${rule.target}"`, source);
      }
    }
    out.suppressions = rules;
  }
  for (const key of ["tsconfig", "coverage"] as const) {
    if (key in input) {
      if (typeof input[key] !== "string") throw new ConfigError(`"${key}" must be a string`, source);
      out[key] = input[key] as string;
    }
  }
  if ("dependencies" in input) {
    if (typeof input.dependencies !== "boolean") throw new ConfigError(`"dependencies" must be a boolean`, source);
    out.dependencies = input.dependencies;
  }
  return out;
}

function mergeConfig(base: LooseEndsConfig, raw: RawConfig, source: string): LooseEndsConfig {
  const { extendInclude, extendExclude, extendTestPatterns, ...rest } = raw;
  const merged: LooseEndsConfig = { ...base, ...stripUndefined(rest), source };
  if (extendInclude) merged.include = [...merged.include, ...extendInclude];
  if (extendExclude) merged.exclude = [...merged.exclude, ...extendExclude];
  if (extendTestPatterns) merged.testPatterns = [...merged.testPatterns, ...extendTestPatterns];
  return merged;
}

function stringArray(value: unknown, key: string, source?: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ConfigError(`"${key}" must be an array of strings`, source);
  }
  return value as string[];
}

function ruleArray(value: unknown, key: string, source?: string): Array<{ target: string; reason: string } & Record<string, unknown>> {
  if (!Array.isArray(value)) throw new ConfigError(`"${key}" must be an array`, source);
  return value.map((item, index) => {
    if (!item || typeof item !== "object") throw new ConfigError(`${key}[${index}] must be an object`, source);
    const rule = item as Record<string, unknown>;
    if (typeof rule.target !== "string" || rule.target.length === 0) {
      throw new ConfigError(`${key}[${index}].target must be a non-empty string`, source);
    }
    if (typeof rule.reason !== "string" || rule.reason.trim().length === 0) {
      throw new ConfigError(`${key}[${index}] ("${rule.target}") needs a reason`, source);
    }
    return rule as { target: string; reason: string } & Record<string, unknown>;
  });
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
