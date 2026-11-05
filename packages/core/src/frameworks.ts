import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { createMatcher } from "./paths.js";
import type { RootContext, RootProvider } from "./roots.js";
import type { FrameworkName } from "./types.js";
import type { WorkspacePackage } from "./workspace.js";

const EXT = "{ts,tsx,js,jsx,mjs,cjs,mts,cts,mdx}";

/** Frameworks used by a package, judging by its dependencies. */
export function detectFrameworks(pkg: WorkspacePackage): Set<FrameworkName> {
  const deps = {
    ...pkg.manifest.dependencies,
    ...pkg.manifest.devDependencies,
    ...pkg.manifest.peerDependencies,
  };
  const names = Object.keys(deps);
  const out = new Set<FrameworkName>(["node"]);
  if (names.includes("next")) out.add("next");
  if (names.includes("react")) out.add("react");
  if (names.includes("express")) out.add("express");
  if (names.includes("vite")) out.add("vite");
  if (names.includes("jest")) out.add("jest");
  if (names.includes("vitest")) out.add("vitest");
  if (names.some((n) => n.startsWith("@storybook/") || n === "storybook")) out.add("storybook");
  return out;
}

function frameworksFor(ctx: RootContext, pkg: WorkspacePackage, rootFrameworks: Set<FrameworkName>): Set<FrameworkName> {
  if (ctx.config.frameworks !== "auto") return new Set(ctx.config.frameworks);
  const own = detectFrameworks(pkg);
  for (const f of rootFrameworks) own.add(f);
  return own;
}

const join2 = (dir: string, rel: string) => (dir ? `${dir}/${rel}` : rel);

/** Next.js special files that the framework loads by convention. */
const NEXT_APP_FILES = [
  "page",
  "layout",
  "template",
  "loading",
  "error",
  "global-error",
  "not-found",
  "forbidden",
  "unauthorized",
  "default",
  "route",
  "head",
  "opengraph-image",
  "twitter-image",
  "icon",
  "apple-icon",
  "sitemap",
  "robots",
  "manifest",
];

/** Exports Next.js reads from route modules. Other named exports are not roots. */
export const NEXT_ROUTE_EXPORTS = [
  "default",
  "metadata",
  "generateMetadata",
  "generateStaticParams",
  "generateViewport",
  "generateImageMetadata",
  "generateSitemaps",
  "viewport",
  "revalidate",
  "dynamic",
  "dynamicParams",
  "fetchCache",
  "runtime",
  "preferredRegion",
  "maxDuration",
  "experimental_ppr",
  "alt",
  "size",
  "contentType",
  "config",
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "getServerSideProps",
  "getStaticProps",
  "getStaticPaths",
  "getInitialProps",
  "reportWebVitals",
  "middleware",
  "proxy",
  "register",
  "onRequestError",
];

export const nextRoots: RootProvider = {
  name: "next",
  discover(ctx) {
    eachPackage(ctx, "next", (pkg) => {
      const dir = pkg.dir;
      const patterns: Array<[string, string]> = [];
      for (const base of ["app", "src/app"]) {
        patterns.push([join2(dir, `${base}/**/{${NEXT_APP_FILES.join(",")}}.${EXT}`), "Next.js app router file"]);
      }
      for (const base of ["pages", "src/pages"]) patterns.push([join2(dir, `${base}/**/*.${EXT}`), "Next.js pages router file"]);
      for (const base of ["", "src/"]) {
        patterns.push([join2(dir, `${base}{middleware,proxy,instrumentation,instrumentation-client}.${EXT}`), "Next.js special file"]);
      }
      patterns.push([join2(dir, `next.config.${EXT}`), "Next.js config"]);
      patterns.push([join2(dir, `mdx-components.${EXT}`), "Next.js MDX components"]);
      for (const [glob, reason] of patterns) {
        const match = createMatcher([glob]);
        const isConfig = reason.endsWith("config");
        for (const file of ctx.files.filter(match)) {
          if (/\.(test|spec)\./.test(file)) continue;
          ctx.addFile(file, { kind: isConfig ? "tooling" : "production", source: "framework:next", reason }, NEXT_ROUTE_EXPORTS);
        }
      }
    });
  },
};

/** Mark every local `<script src>` in an HTML file as a production root. Returns false if the file is missing. */
function addHtmlScripts(ctx: RootContext, html: string, source: string, rootDir: string): boolean {
  const abs = join(ctx.config.root, html);
  if (!existsSync(abs)) return false;
  const dir = posix.dirname(html) === "." ? "" : posix.dirname(html);
  for (const match of readText(abs).matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/g)) {
    const src = match[1]!;
    if (/^(https?:)?\/\/|^(data|chrome|moz)[\w-]*:/.test(src)) continue;
    // A leading slash means the site or extension root.
    const file = src.startsWith("/") ? ctx.build.resolver.resolveEntry(rootDir, src.slice(1)) : ctx.build.resolver.resolveEntry(dir, src.replace(/^\.\//, ""));
    if (file) ctx.addFile(file, { kind: "production", source, reason: `script in ${html}` }, "all");
  }
  return true;
}

/** Vite loads `<script type="module" src>` from index.html files. */
export const viteRoots: RootProvider = {
  name: "vite",
  discover(ctx) {
    eachPackage(ctx, "vite", (pkg) => {
      for (const html of ["index.html", "src/index.html", "public/index.html"]) addHtmlScripts(ctx, join2(pkg.dir, html), "framework:vite", pkg.dir);
    });
  },
};

interface ExtensionManifest {
  manifest_version?: number;
  background?: { service_worker?: string; scripts?: string[]; page?: string };
  content_scripts?: Array<{ js?: string[] }>;
  action?: { default_popup?: string };
  browser_action?: { default_popup?: string };
  page_action?: { default_popup?: string };
  options_page?: string;
  options_ui?: { page?: string };
  devtools_page?: string;
  side_panel?: { default_path?: string };
  sidebar_action?: { default_panel?: string };
  chrome_url_overrides?: Record<string, string>;
  sandbox?: { pages?: string[] };
  user_scripts?: { api_script?: string };
  web_accessible_resources?: Array<string | { resources?: string[] }>;
}

/**
 * Browser extensions (Chrome, Firefox, Edge) are wired up by manifest.json:
 * background workers, content scripts, and HTML pages whose `<script>` tags
 * load the rest. No package.json is needed.
 */
export const webExtensionRoots: RootProvider = {
  name: "web-extension",
  discover(ctx) {
    const dirs = new Set<string>(ctx.build.resolver.packages.map((p) => p.dir));
    dirs.add("");
    for (const file of ctx.files) {
      for (let dir = posix.dirname(file); ; dir = posix.dirname(dir)) {
        dirs.add(dir === "." ? "" : dir);
        if (dir === "." || dir === "/" || dir === "") break;
      }
    }
    for (const dir of dirs) {
      const manifestPath = join2(dir, "manifest.json");
      const text = readText(join(ctx.config.root, manifestPath));
      if (!text.includes("manifest_version")) continue;
      let m: ExtensionManifest;
      try {
        m = JSON.parse(text) as ExtensionManifest;
      } catch {
        continue;
      }
      if (typeof m.manifest_version !== "number") continue;
      const source = "framework:web-extension";
      const scripts: string[] = [];
      const pages: string[] = [];
      const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
      if (str(m.background?.service_worker)) scripts.push(m.background!.service_worker!);
      for (const s of m.background?.scripts ?? []) if (str(s)) scripts.push(s);
      if (str(m.background?.page)) pages.push(m.background!.page!);
      for (const cs of m.content_scripts ?? []) for (const s of cs.js ?? []) if (str(s)) scripts.push(s);
      if (str(m.user_scripts?.api_script)) scripts.push(m.user_scripts!.api_script!);
      for (const p of [m.action?.default_popup, m.browser_action?.default_popup, m.page_action?.default_popup, m.options_page, m.options_ui?.page, m.devtools_page, m.side_panel?.default_path, m.sidebar_action?.default_panel, ...Object.values(m.chrome_url_overrides ?? {}), ...(m.sandbox?.pages ?? [])]) {
        if (str(p)) pages.push(p);
      }
      for (const w of m.web_accessible_resources ?? []) {
        for (const r of typeof w === "string" ? [w] : (w.resources ?? [])) {
          if (!str(r) || r.includes("*")) continue;
          if (/\.html?$/.test(r)) pages.push(r);
          else scripts.push(r);
        }
      }
      for (const s of scripts) {
        const file = ctx.build.resolver.resolveEntry(dir, s.replace(/^\.?\//, ""));
        if (file) ctx.addFile(file, { kind: "production", source, reason: `named in ${manifestPath}` }, "all");
      }
      for (const p of pages) addHtmlScripts(ctx, join2(dir, p.replace(/^\.?\//, "").replace(/[?#].*$/, "")), source, dir);
    }
  },
};

/** Storybook config directory. Stories themselves are matched by test patterns. */
export const storybookRoots: RootProvider = {
  name: "storybook",
  discover(ctx) {
    eachPackage(ctx, "storybook", (pkg) => {
      const match = createMatcher([join2(pkg.dir, `.storybook/*.${EXT}`)]);
      for (const file of ctx.files.filter(match)) ctx.addFile(file, { kind: "tooling", source: "framework:storybook", reason: "Storybook config" }, "all");
    });
  },
};

/** Serverless function directories used by Vercel and Netlify. */
export const serverlessRoots: RootProvider = {
  name: "serverless",
  discover(ctx) {
    for (const pkg of ctx.build.resolver.packages) {
      const sources: Array<[string, string]> = [];
      if (existsSync(join(ctx.config.root, pkg.dir, "vercel.json")) || "vercel" in (pkg.manifest.devDependencies ?? {})) {
        sources.push([join2(pkg.dir, `api/**/*.${EXT}`), "Vercel function"]);
      }
      if (existsSync(join(ctx.config.root, pkg.dir, "netlify.toml"))) {
        sources.push([join2(pkg.dir, `netlify/{functions,edge-functions}/**/*.${EXT}`), "Netlify function"]);
      }
      for (const [glob, reason] of sources) {
        const match = createMatcher([glob]);
        for (const file of ctx.files.filter(match)) ctx.addFile(file, { kind: "production", source: "framework:serverless", reason }, "all");
      }
    }
  },
};

/** Tool configuration files loaded by CLIs: vite.config.ts, eslint.config.js, .eslintrc.cjs, and so on. */
export const toolConfigRoots: RootProvider = {
  name: "tool-config",
  discover(ctx) {
    const dirs = ctx.build.resolver.packages.map((p) => p.dir);
    const globs = dirs.flatMap((dir) => [join2(dir, `*.config.${EXT}`), join2(dir, `.*rc.${EXT}`), join2(dir, `*.setup.${EXT}`), join2(dir, `.*.${EXT}`)]);
    const match = createMatcher(globs);
    for (const file of ctx.files.filter(match)) {
      ctx.addFile(file, { kind: "tooling", source: "tool-config", reason: "tool configuration file" }, "all");
      addConfigReferences(ctx, file, readText(join(ctx.config.root, file)));
    }
    // JSON configs (.oxlintrc.json, registry.json, .babelrc, ...) at each package root.
    for (const dir of dirs) {
      const abs = join(ctx.config.root, dir);
      let entries: string[] = [];
      try {
        entries = readdirSync(abs);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (!JSON_CONFIG.test(name) || JSON_SKIP.has(name)) continue;
        const path = join(abs, name);
        try {
          if (!statSync(path).isFile() || statSync(path).size > 8 * 1024 * 1024) continue;
        } catch {
          continue;
        }
        addConfigReferences(ctx, join2(dir, name), readText(path));
      }
    }
  },
};

const JSON_CONFIG = /^(\.[\w.-]+rc(\.json)?|[\w.-]+\.json)$/;
// Configs that name files without loading them (our own suppressions, knip ignore lists) are skipped.
const JSON_SKIP = new Set(["package.json", "package-lock.json", "composer.json", "tsconfig.json", "jsconfig.json", "loose-ends.config.json", ".loose-endsrc.json", "knip.json"]);
const TEST_CONFIG = /^(\.?(vitest|jest|playwright|cypress|karma|ava|mocha|wdio|web-test-runner)\b|\.mocharc)/;
const PATH_LIKE = /["'`]((?:\.{1,2}\/|[\w@-]+\/)[^"'`\s*{}$]{1,200}|[\w.-]+\.(?:[cm]?[jt]sx?))["'`]/g;

function readText(abs: string): string {
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return "";
  }
}

/**
 * Tools load files named in their config (`setupFiles: ["./setup.ts"]`,
 * plugin paths, service workers). String literals that resolve to project
 * files become roots: test roots for test-runner configs, tooling otherwise.
 */
export function addConfigReferences(ctx: RootContext, configFile: string, text: string): void {
  const dir = posix.dirname(configFile) === "." ? "" : posix.dirname(configFile);
  const kind = TEST_CONFIG.test(posix.basename(configFile)) ? "test" : "tooling";
  const seen = new Set<string>();
  for (const match of text.matchAll(PATH_LIKE)) {
    const literal = match[1]!.replace(/^\.\//, "");
    if (seen.has(literal) || /^(https?:|node:)/.test(literal)) continue;
    seen.add(literal);
    const file = ctx.build.resolver.resolveEntry(dir, literal);
    if (!file || file === configFile) continue;
    ctx.addFile(file, { kind, source: `config:${configFile}`, reason: `referenced by ${configFile}` }, "all");
  }
}

/** Docusaurus loads its config, sidebars, pages, and swizzled theme components by convention. */
export const docusaurusRoots: RootProvider = {
  name: "docusaurus",
  discover(ctx) {
    for (const pkg of ctx.build.resolver.packages) {
      const deps = { ...pkg.manifest.dependencies, ...pkg.manifest.devDependencies };
      if (!("@docusaurus/core" in deps)) continue;
      const match = createMatcher([
        join2(pkg.dir, `{docusaurus.config,sidebars}.${EXT}`),
        join2(pkg.dir, `src/pages/**/*.${EXT}`),
        join2(pkg.dir, `src/theme/**/*.${EXT}`),
        join2(pkg.dir, `src/clientModules/**/*.${EXT}`),
      ]);
      for (const file of ctx.files.filter(match)) {
        ctx.addFile(file, { kind: "production", source: "framework:docusaurus", reason: "Docusaurus convention file" }, "all");
        if (/docusaurus\.config\./.test(file)) addConfigReferences(ctx, file, readText(join(ctx.config.root, file)));
      }
    }
  },
};

export const FRAMEWORK_PROVIDERS: RootProvider[] = [nextRoots, viteRoots, storybookRoots, serverlessRoots, docusaurusRoots, webExtensionRoots, toolConfigRoots];

function eachPackage(ctx: RootContext, framework: FrameworkName, fn: (pkg: WorkspacePackage) => void) {
  const packages = ctx.build.resolver.packages;
  const rootPkg = packages.find((p) => p.dir === "");
  const rootFrameworks = rootPkg ? detectFrameworks(rootPkg) : new Set<FrameworkName>();
  if (packages.length === 0) {
    if (ctx.config.frameworks !== "auto" && ctx.config.frameworks.includes(framework)) {
      fn({ name: "", dir: "", manifest: {} });
    }
    return;
  }
  for (const pkg of packages) {
    const set = pkg.dir === "" ? frameworksFor(ctx, pkg, new Set()) : frameworksFor(ctx, pkg, rootFrameworks);
    if (set.has(framework)) fn(pkg);
  }
}
