import { existsSync, readFileSync } from "node:fs";
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

/** Vite loads `<script type="module" src>` from index.html files. */
export const viteRoots: RootProvider = {
  name: "vite",
  discover(ctx) {
    eachPackage(ctx, "vite", (pkg) => {
      for (const html of ["index.html", "src/index.html", "public/index.html"]) {
        const abs = join(ctx.config.root, pkg.dir, html);
        if (!existsSync(abs)) continue;
        const text = readFileSync(abs, "utf8");
        for (const match of text.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/g)) {
          const src = match[1]!;
          if (/^(https?:)?\/\//.test(src)) continue;
          const rel = src.startsWith("/") ? src.slice(1) : posix.join(posix.dirname(html), src);
          const file = ctx.build.resolver.resolveEntry(pkg.dir, rel);
          if (file) ctx.addFile(file, { kind: "production", source: "framework:vite", reason: `script in ${join2(pkg.dir, html)}` }, "all");
        }
      }
    });
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
    }
  },
};

export const FRAMEWORK_PROVIDERS: RootProvider[] = [nextRoots, viteRoots, storybookRoots, serverlessRoots, toolConfigRoots];

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
