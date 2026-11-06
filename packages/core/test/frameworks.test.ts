import { describe, expect, it } from "vitest";
import { buildGraph, discoverRoots, fileId, loadConfig, symbolId } from "@loose-ends/core";
import { project } from "./helpers/project.js";

function rootsOf(files: Record<string, string | object>) {
  const config = loadConfig(project(files));
  return discoverRoots(config, buildGraph(config)).map((r) => r.node);
}

describe("framework roots", () => {
  it("finds Next.js app and pages router files and their special exports", () => {
    const nodes = rootsOf({
      "package.json": { name: "web", dependencies: { next: "15.0.0", react: "19.0.0" } },
      "src/app/layout.tsx": "export default function Layout() {}\nexport const metadata = {};",
      "src/app/blog/[slug]/page.tsx": "export default function Page() {}\nexport function generateStaticParams() {}\nexport function helper() {}",
      "src/app/api/users/route.ts": "export async function GET() {}",
      "src/app/blog/card.tsx": "export function Card() {}",
      "pages/_app.tsx": "export default function App() {}",
      "middleware.ts": "export function middleware() {}\nexport const config = {};",
      "next.config.mjs": "export default {};",
    });
    expect(nodes).toEqual(
      expect.arrayContaining([
        fileId("src/app/layout.tsx"),
        symbolId("src/app/layout.tsx", "metadata"),
        symbolId("src/app/blog/[slug]/page.tsx", "generateStaticParams"),
        symbolId("src/app/api/users/route.ts", "GET"),
        fileId("pages/_app.tsx"),
        symbolId("middleware.ts", "middleware"),
        fileId("next.config.mjs"),
      ]),
    );
    expect(nodes).not.toContain(symbolId("src/app/blog/[slug]/page.tsx", "helper"));
    expect(nodes).not.toContain(fileId("src/app/blog/card.tsx"));
  });

  it("only applies Next.js rules to packages that use Next.js", () => {
    const nodes = rootsOf({ "package.json": { name: "lib", main: "index.js" }, "index.js": "", "app/page.tsx": "" });
    expect(nodes).not.toContain(fileId("app/page.tsx"));
  });

  it("reads Vite index.html script tags", () => {
    const nodes = rootsOf({
      "package.json": { name: "spa", devDependencies: { vite: "6.0.0" } },
      "index.html": `<html><body><script type="module" src="/src/main.tsx"></script></body></html>`,
      "src/main.tsx": "",
      "vite.config.ts": "export default {};",
    });
    expect(nodes).toEqual(expect.arrayContaining([fileId("src/main.tsx"), fileId("vite.config.ts")]));
  });

  it("finds serverless functions and tool configs", () => {
    const nodes = rootsOf({
      "package.json": { name: "fn", main: "index.js" },
      "index.js": "",
      "vercel.json": {},
      "api/hello.ts": "export default function handler() {}",
      "eslint.config.js": "export default [];",
      ".prettierrc.cjs": "module.exports = {};",
    });
    expect(nodes).toEqual(expect.arrayContaining([fileId("api/hello.ts"), fileId("eslint.config.js"), fileId(".prettierrc.cjs")]));
  });

  it("applies frameworks per workspace package", () => {
    const nodes = rootsOf({
      "package.json": { name: "mono", workspaces: ["apps/*"] },
      "apps/site/package.json": { name: "site", dependencies: { next: "15.0.0" } },
      "apps/site/app/page.tsx": "export default function Page() {}",
      "apps/api/package.json": { name: "api", main: "src/index.ts" },
      "apps/api/src/index.ts": "",
      "apps/api/app/page.tsx": "",
    });
    expect(nodes).toContain(fileId("apps/site/app/page.tsx"));
    expect(nodes).not.toContain(fileId("apps/api/app/page.tsx"));
  });
});

describe("config references", () => {
  it("roots files named in tool config strings", () => {
    const config = loadConfig(
      project({
        "package.json": { name: "app", main: "src/index.ts" },
        "src/index.ts": "",
        "vitest.config.ts": `export default { test: { setupFiles: ["./setupTests.ts"], globalSetup: "test/global.ts" } };`,
        "vite.config.mts": `export default { plugins: [pwa({ swSrc: "src/service-worker.js" })] };`,
        ".oxlintrc.json": { jsPlugins: ["./tools/lint-plugin.ts"] },
        "setupTests.ts": "",
        "test/global.ts": "",
        "src/service-worker.js": "",
        "tools/lint-plugin.ts": "",
        "src/unused.ts": "",
      }),
    );
    const roots = discoverRoots(config, buildGraph(config));
    const kind = (p: string) => roots.find((r) => r.node === fileId(p))?.kind;
    expect(kind("setupTests.ts")).toBe("test");
    expect(kind("test/global.ts")).toBe("test");
    expect(kind("src/service-worker.js")).toBe("tooling");
    expect(kind("tools/lint-plugin.ts")).toBe("tooling");
    expect(kind("src/unused.ts")).toBeUndefined();
  });

  it("finds Docusaurus convention files", () => {
    const nodes = rootsOf({
      "package.json": { name: "docs", dependencies: { "@docusaurus/core": "3" } },
      "docusaurus.config.js": `module.exports = { themeConfig: {}, presets: [["classic", { docs: { sidebarPath: "./sidebars.js" } }]] };`,
      "sidebars.js": "module.exports = {};",
      "src/pages/index.tsx": "export default function Home() {}",
      "src/theme/Root.js": "export default function Root() {}",
      "src/components/Unused.js": "",
    });
    expect(nodes).toEqual(expect.arrayContaining([fileId("sidebars.js"), fileId("src/pages/index.tsx"), fileId("src/theme/Root.js")]));
    expect(nodes).not.toContain(fileId("src/components/Unused.js"));
  });

  it("finds browser extension scripts from manifest.json and the HTML pages it names", () => {
    const nodes = rootsOf({
      "extension/manifest.json": {
        manifest_version: 3,
        background: { service_worker: "background.js" },
        content_scripts: [{ matches: ["https://*/*"], js: ["content.js"] }],
        action: { default_popup: "popup.html" },
        options_ui: { page: "options/index.html" },
        web_accessible_resources: [{ resources: ["inject.js", "images/*"], matches: ["<all_urls>"] }],
      },
      "extension/popup.html": '<script src="popup.js"></script><script src="https://cdn.example.com/x.js"></script>',
      "extension/options/index.html": '<script type="module" src="/options/options.js"></script>',
      "extension/background.js": "",
      "extension/content.js": "",
      "extension/popup.js": "",
      "extension/options/options.js": "",
      "extension/inject.js": "",
      "extension/unused.js": "",
    });
    expect(nodes).toEqual(
      expect.arrayContaining([
        fileId("extension/background.js"),
        fileId("extension/content.js"),
        fileId("extension/popup.js"),
        fileId("extension/options/options.js"),
        fileId("extension/inject.js"),
      ]),
    );
    expect(nodes).not.toContain(fileId("extension/unused.js"));
  });

  it("finds React Email templates", () => {
    const nodes = rootsOf({
      "emails/package.json": { name: "emails", scripts: { dev: "email dev --dir ./templates" }, dependencies: { "react-email": "1" } },
      "emails/emails/welcome.tsx": "export default function Welcome() { return null; }",
      "emails/templates/reset.tsx": "export default function Reset() { return null; }",
      "emails/ui/unused.tsx": "export const x = 1;",
    });
    expect(nodes).toEqual(expect.arrayContaining([fileId("emails/emails/welcome.tsx"), fileId("emails/templates/reset.tsx")]));
    expect(nodes).not.toContain(fileId("emails/ui/unused.tsx"));
  });

  it("finds scripts that workflows run, but not files in paths filters", () => {
    const nodes = rootsOf({
      ".github/workflows/ci.yml": "on:\n  push:\n    paths:\n      - 'src/watched.ts'\njobs:\n  x:\n    steps:\n      - run: node scripts/release.mjs\n      - uses: actions/github-script@v7\n        with:\n          script: require('./.github/workflows/label.js')",
      "scripts/release.mjs": "",
      ".github/workflows/label.js": "",
      "src/watched.ts": "",
    });
    expect(nodes).toEqual(expect.arrayContaining([fileId("scripts/release.mjs"), fileId(".github/workflows/label.js")]));
    expect(nodes).not.toContain(fileId("src/watched.ts"));
  });

  it("ignores manifest.json files that are not extension manifests", () => {
    const nodes = rootsOf({ "static/manifest.json": { name: "PWA", start_url: "/", icons: [{ src: "icon.js" }] }, "static/icon.js": "" });
    expect(nodes).not.toContain(fileId("static/icon.js"));
  });
});
