import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import fg from "fast-glob";
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
  if (names.includes("@sveltejs/kit")) out.add("sveltekit");
  if (names.includes("astro")) out.add("astro");
  if (names.includes("@nestjs/core")) out.add("nest");
  if (names.includes("@react-router/dev")) out.add("react-router");
  if (names.includes("vitepress")) out.add("vitepress");
  if (names.includes("nuxt") || names.includes("nuxt3")) out.add("nuxt");
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

/** SvelteKit: route files, hooks, params matchers, and service workers are loaded by the framework. */
export const svelteKitRoots: RootProvider = {
  name: "sveltekit",
  discover(ctx) {
    eachPackage(ctx, "sveltekit", (pkg) => {
      const globs = [
        [join2(pkg.dir, "src/routes/**/+*.{svelte,ts,js}"), "SvelteKit route file"],
        [join2(pkg.dir, "src/{hooks,hooks.client,hooks.server,hooks.universal,service-worker}.{ts,js}"), "SvelteKit hook"],
        [join2(pkg.dir, "src/{hooks,service-worker}/index.{ts,js}"), "SvelteKit hook"],
        [join2(pkg.dir, "src/params/*.{ts,js}"), "SvelteKit param matcher"],
        [join2(pkg.dir, "svelte.config.{js,mjs,ts}"), "SvelteKit config"],
      ];
      for (const [glob, reason] of globs) {
        const match = createMatcher([glob!]);
        for (const file of ctx.files.filter(match)) {
          if (/\.(test|spec)\./.test(file)) continue;
          ctx.addFile(file, { kind: reason!.endsWith("config") ? "tooling" : "production", source: "framework:sveltekit", reason: reason! });
        }
      }
    });
  },
};

/** Astro: pages, middleware, content config, and actions are loaded by the framework. */
export const astroRoots: RootProvider = {
  name: "astro",
  discover(ctx) {
    eachPackage(ctx, "astro", (pkg) => {
      const globs = [
        [join2(pkg.dir, "src/pages/**/*.{astro,md,mdx,ts,js}"), "Astro page"],
        [join2(pkg.dir, "src/{middleware,content.config,content/config,actions/index}.{ts,js}"), "Astro special file"],
        [join2(pkg.dir, "astro.config.{js,mjs,ts,mts}"), "Astro config"],
      ];
      for (const [glob, reason] of globs) {
        const match = createMatcher([glob!]);
        for (const file of ctx.files.filter(match)) {
          if (/\.(test|spec)\./.test(file)) continue;
          ctx.addFile(file, { kind: reason!.endsWith("config") ? "tooling" : "production", source: "framework:astro", reason: reason! });
        }
      }
    });
  },
};

/** NestJS: the Nest CLI builds and starts `sourceRoot/entryFile` from nest-cli.json (default `src/main`). */
export const nestRoots: RootProvider = {
  name: "nest",
  discover(ctx) {
    eachPackage(ctx, "nest", (pkg) => {
      let sourceRoot = "src";
      let entryFile = "main";
      const extra: string[] = [];
      try {
        const cli = JSON.parse(readFileSync(join(ctx.config.root, pkg.dir, "nest-cli.json"), "utf8"));
        sourceRoot = cli.sourceRoot ?? sourceRoot;
        entryFile = cli.entryFile ?? entryFile;
        for (const project of Object.values(cli.projects ?? {}) as Array<{ sourceRoot?: string; entryFile?: string }>) {
          if (project.sourceRoot) extra.push(`${project.sourceRoot}/${project.entryFile ?? "main"}`);
        }
      } catch {
        // No nest-cli.json: the defaults apply.
      }
      for (const entry of [`${sourceRoot}/${entryFile}`, ...extra]) {
        const match = createMatcher([join2(pkg.dir, `${entry}.{ts,js}`)]);
        for (const file of ctx.files.filter(match)) ctx.addFile(file, { kind: "production", source: "framework:nest", reason: "NestJS entry file (nest-cli.json)" });
      }
    });
  },
};

/**
 * React Router framework mode: root, entry files, and `routes.ts` live in the
 * app directory (`appDirectory` in react-router.config, default `app`). Route
 * modules are named by path strings in routes.ts, or found by `flatRoutes()`.
 */
export const reactRouterRoots: RootProvider = {
  name: "react-router",
  discover(ctx) {
    eachPackage(ctx, "react-router", (pkg) => {
      let appDir = "app";
      for (const name of ["react-router.config.ts", "react-router.config.js"]) {
        const abs = join(ctx.config.root, pkg.dir, name);
        if (!existsSync(abs)) continue;
        appDir = /appDirectory\s*:\s*["'`]([^"'`]+)["'`]/.exec(readFileSync(abs, "utf8"))?.[1]?.replace(/^\.\//, "") ?? appDir;
        ctx.addFile(join2(pkg.dir, name), { kind: "tooling", source: "framework:react-router", reason: "React Router config" });
      }
      const base = join2(pkg.dir, appDir);
      const add = (file: string, reason: string) => ctx.addFile(file, { kind: "production", source: "framework:react-router", reason }, NEXT_ROUTE_EXPORTS);
      for (const file of ctx.files.filter(createMatcher([`${base}/{root,routes,entry.client,entry.server,entry.rsc,entry.ssr}.${EXT}`]))) add(file, "React Router app file");
      const routesFile = ctx.files.find(createMatcher([`${base}/routes.${EXT}`]));
      if (!routesFile) return;
      const text = readFileSync(join(ctx.config.root, routesFile), "utf8");
      if (/flatRoutes\s*\(/.test(text)) {
        for (const file of ctx.files.filter(createMatcher([`${base}/routes/**/*.${EXT}`]))) add(file, "React Router route module (flatRoutes)");
      }
      for (const m of text.matchAll(/["'`]([^"'`\s]+\.(?:tsx?|jsx?|mdx))["'`]/g)) {
        const file = posix.normalize(posix.join(base, m[1]!));
        if (ctx.files.includes(file)) add(file, "React Router route module (routes.ts)");
      }
    });
  },
};

/** Nuxt: these directories are auto-imported or file-routed, so nothing imports them explicitly. */
export const nuxtRoots: RootProvider = {
  name: "nuxt",
  discover(ctx) {
    eachPackage(ctx, "nuxt", (pkg) => {
      const dirs = "{components,pages,layouts,composables,utils,plugins,middleware,server,modules}";
      const globs = [`${dirs}/**/*.{vue,${EXT.slice(1, -1)}}`, `app/${dirs}/**/*.{vue,${EXT.slice(1, -1)}}`, `{,app/}{app,error}.vue`, `{,app/}app.config.{ts,js}`];
      const match = createMatcher(globs.map((g) => join2(pkg.dir, g)));
      for (const file of ctx.files.filter(match)) {
        if (/\.(test|spec)\./.test(file)) continue;
        ctx.addFile(file, { kind: "production", source: "framework:nuxt", reason: "Nuxt auto-imported or file-routed file" });
      }
      for (const file of ctx.files.filter(createMatcher([join2(pkg.dir, "nuxt.config.{ts,js,mjs}")]))) {
        ctx.addFile(file, { kind: "tooling", source: "framework:nuxt", reason: "Nuxt config" });
      }
    });
  },
};

/** VitePress: the site config and the theme entry are loaded by the dev server. */
export const vitePressRoots: RootProvider = {
  name: "vitepress",
  discover(ctx) {
    eachPackage(ctx, "vitepress", (pkg) => {
      const match = createMatcher([join2(pkg.dir, `**/.vitepress/{config,theme/index}.{ts,js,mts,mjs}`)]);
      for (const file of ctx.files.filter(match)) ctx.addFile(file, { kind: "production", source: "framework:vitepress", reason: "VitePress config or theme entry" });
      // Markdown pages import components in `<script setup>`; pages are not parsed, so their relative imports become roots.
      for (const md of fg.sync(join2(pkg.dir, "**/*.md"), { cwd: ctx.config.root, ignore: ["**/node_modules/**"] })) {
        const text = readFileSync(join(ctx.config.root, md), "utf8");
        for (const m of text.matchAll(/\bfrom\s+["'](\.{1,2}\/[^"']+)["']/g)) {
          const file = posix.normalize(posix.join(posix.dirname(md), m[1]!));
          if (ctx.files.includes(file)) ctx.addFile(file, { kind: "production", source: "framework:vitepress", reason: `imported by ${md}` });
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

/** React Email renders every template in its emails folder (`emails/`, or `--dir` in a script). */
export const reactEmailRoots: RootProvider = {
  name: "react-email",
  discover(ctx) {
    for (const pkg of ctx.build.resolver.packages) {
      const deps = { ...pkg.manifest.dependencies, ...pkg.manifest.devDependencies };
      if (!("react-email" in deps)) continue;
      const dirs = new Set(["emails"]);
      for (const script of Object.values(pkg.manifest.scripts ?? {})) {
        const m = /\bemail\s+(?:dev|build|export|preview)\b.*?--dir[\s=]+["']?([\w./-]+)/.exec(script);
        if (m) dirs.add(m[1]!.replace(/^\.\//, "").replace(/\/$/, ""));
      }
      const match = createMatcher([...dirs].map((d) => join2(pkg.dir, `${d}/**/*.${EXT}`)));
      for (const file of ctx.files.filter(match)) ctx.addFile(file, { kind: "production", source: "framework:react-email", reason: "React Email template" }, "all");
    }
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

/**
 * Vite, Next.js, and Create React App serve `public/` as-is, so scripts there
 * (service workers, analytics snippets) are loaded by URL, not by import.
 */
export const publicDirRoots: RootProvider = {
  name: "public-dir",
  discover(ctx) {
    const dirs = ctx.build.resolver.packages.map((p) => p.dir);
    if (dirs.length === 0) dirs.push("");
    const match = createMatcher(dirs.map((dir) => join2(dir, "public/**/*.{js,mjs,cjs}")));
    for (const file of ctx.files.filter(match)) ctx.addScript(file, { kind: "production", source: "public-dir", reason: "served from public/" });
  },
};

/** Scripts that GitHub Actions workflows run (`node scripts/release.mjs`, `require('./.github/workflows/check.js')`). */
export const workflowScriptRoots: RootProvider = {
  name: "workflow-scripts",
  discover(ctx) {
    const files = new Set(ctx.files);
    let workflows: string[];
    try {
      workflows = readdirSync(join(ctx.config.root, ".github/workflows")).filter((f) => /\.ya?ml$/.test(f));
    } catch {
      return;
    }
    for (const name of workflows) {
      // `paths:` filters list files that trigger a workflow, not files it runs.
      let filterIndent = -1;
      const lines: string[] = [];
      for (const line of readText(join(ctx.config.root, ".github/workflows", name)).split(/\r?\n/)) {
        const indent = line.search(/\S/);
        if (filterIndent !== -1 && (indent > filterIndent || indent === -1 || (indent === filterIndent && /^\s*-/.test(line)))) continue;
        filterIndent = /^\s*(paths|paths-ignore):/.test(line) ? indent : -1;
        if (filterIndent === -1) lines.push(line);
      }
      for (const m of lines.join("\n").matchAll(/[\w./-]+\.(?:[cm]?[jt]s)\b/g)) {
        const rel = posix.normalize(m[0].replace(/^\.\//, ""));
        for (const candidate of [rel, posix.join(".github/workflows", rel)]) {
          if (files.has(candidate)) ctx.addFile(candidate, { kind: "tooling", source: `.github/workflows/${name}`, reason: `run by the ${name} workflow` });
        }
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

export const FRAMEWORK_PROVIDERS: RootProvider[] = [nextRoots, viteRoots, svelteKitRoots, astroRoots, nestRoots, reactRouterRoots, vitePressRoots, nuxtRoots, storybookRoots, serverlessRoots, reactEmailRoots, docusaurusRoots, webExtensionRoots, publicDirRoots, workflowScriptRoots, toolConfigRoots];

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
