import { describe, expect, it } from "vitest";
import { analyze, dependencyReport, discoverJavaModules, loadConfig, stateOf } from "@loose-ends/core";
import { project } from "./helpers/project.js";

const states = (files: Record<string, string | object>, ids: string[]) => {
  const analysis = analyze(loadConfig(project(files)));
  return Object.fromEntries(ids.map((id) => [id, stateOf(analysis, id).liveness]));
};

describe("single-file components", () => {
  it("follows imports in Vue script blocks and counts template use", () => {
    const s = states(
      {
        "package.json": { name: "app", dependencies: { vue: "3.0.0", vite: "5.0.0" } },
        "index.html": '<script type="module" src="/src/main.ts"></script>',
        "src/main.ts": 'import App from "./App.vue";\nApp;',
        "src/App.vue": '<template><post-list /><Footer /></template>\n<script setup lang="ts">\nimport PostList from "./PostList.vue";\nimport Footer from "./Footer.vue";\nimport { format } from "./format";\n</script>',
        "src/PostList.vue": "<template><p>posts</p></template>",
        "src/Footer.vue": "<template><p>footer</p></template>",
        "src/format.ts": "export function format() {}",
        "src/Unused.vue": "<template><p>unused</p></template>",
      },
      ["file:src/PostList.vue", "file:src/Footer.vue", "file:src/Unused.vue"],
    );
    expect(s).toEqual({ "file:src/PostList.vue": "live", "file:src/Footer.vue": "live", "file:src/Unused.vue": "orphaned" });
  });

  it("finds SvelteKit routes and resolves $lib", () => {
    const s = states(
      {
        "package.json": { name: "kit", devDependencies: { "@sveltejs/kit": "2.0.0", svelte: "5.0.0" } },
        "src/routes/+page.svelte": '<script>\nimport Post from "$lib/Post.svelte";\nimport { load } from "$lib/api";\n</script>\n<Post />',
        "src/lib/Post.svelte": "<p>post</p>",
        "src/lib/api.ts": "export function load() {}",
        "src/lib/Old.svelte": "<p>old</p>",
      },
      ["file:src/routes/+page.svelte", "file:src/lib/Post.svelte", "file:src/lib/api.ts", "file:src/lib/Old.svelte"],
    );
    expect(s).toEqual({ "file:src/routes/+page.svelte": "live", "file:src/lib/Post.svelte": "live", "file:src/lib/api.ts": "live", "file:src/lib/Old.svelte": "orphaned" });
  });

  it("reads Astro frontmatter and pages", () => {
    const s = states(
      {
        "package.json": { name: "site", dependencies: { astro: "4.0.0" } },
        "src/pages/index.astro": '---\nimport Card from "../components/Card.astro";\n---\n<Card />',
        "src/components/Card.astro": "<div />",
        "src/components/Unused.astro": "<div />",
      },
      ["file:src/components/Card.astro", "file:src/components/Unused.astro"],
    );
    expect(s).toEqual({ "file:src/components/Card.astro": "live", "file:src/components/Unused.astro": "orphaned" });
  });
});

describe("framework entry points", () => {
  it("roots the NestJS entry from nest-cli.json", () => {
    const s = states(
      {
        "package.json": { name: "api", dependencies: { "@nestjs/core": "10.0.0" } },
        "nest-cli.json": { sourceRoot: "server", entryFile: "boot" },
        "server/boot.ts": 'import { AppModule } from "./app.module";\nAppModule;',
        "server/app.module.ts": "export class AppModule {}",
      },
      ["file:server/app.module.ts"],
    );
    expect(s["file:server/app.module.ts"]).toBe("live");
  });

  it("roots React Router framework files and route modules named in routes.ts", () => {
    const s = states(
      {
        "package.json": { name: "web", devDependencies: { "@react-router/dev": "7.0.0" } },
        "app/root.tsx": "export default function Root() {}",
        "app/routes.ts": 'import { index, route } from "@react-router/dev/routes";\nexport default [index("routes/home.tsx"), route("about", "routes/about.tsx")];',
        "app/routes/home.tsx": "export default function Home() {}",
        "app/routes/about.tsx": "export default function About() {}",
        "app/routes/old.tsx": "export default function Old() {}",
      },
      ["file:app/root.tsx", "file:app/routes/home.tsx", "file:app/routes/about.tsx", "file:app/routes/old.tsx"],
    );
    expect(s).toEqual({ "file:app/root.tsx": "live", "file:app/routes/home.tsx": "live", "file:app/routes/about.tsx": "live", "file:app/routes/old.tsx": "orphaned" });
  });

  it("roots Nuxt auto-imported components and pages", () => {
    const s = states(
      {
        "package.json": { name: "web", dependencies: { nuxt: "3.0.0" } },
        "app.vue": "<template><NuxtPage /></template>",
        "pages/index.vue": "<template><Card /></template>",
        "components/Card.vue": "<template><div /></template>",
        "lib/unused.ts": "export const x = 1;",
      },
      ["file:pages/index.vue", "file:components/Card.vue", "file:lib/unused.ts"],
    );
    expect(s).toEqual({ "file:pages/index.vue": "live", "file:components/Card.vue": "live", "file:lib/unused.ts": "orphaned" });
  });

  it("roots VitePress theme entry and components imported from Markdown", () => {
    const s = states(
      {
        "package.json": { name: "docs", devDependencies: { vitepress: "1.0.0" } },
        "docs/.vitepress/theme/index.ts": "export default {};",
        "docs/.vitepress/theme/Grid.vue": "<template><div /></template>",
        "docs/index.md": '<script setup>\nimport Grid from "./.vitepress/theme/Grid.vue";\n</script>\n<Grid />',
      },
      ["file:docs/.vitepress/theme/index.ts", "file:docs/.vitepress/theme/Grid.vue"],
    );
    expect(s).toEqual({ "file:docs/.vitepress/theme/index.ts": "live", "file:docs/.vitepress/theme/Grid.vue": "live" });
  });
});

describe("library layouts", () => {
  it("keeps public types of a published Java library with a non-Maven layout, even with a main", () => {
    const s = states(
      {
        "pom.xml": "<project><artifactId>lib</artifactId><scm><url>x</url></scm></project>",
        "lib/src/com/acme/Api.java": "package com.acme;\npublic class Api {}",
        "lib/src/com/acme/Tool.java": "package com.acme;\npublic class Tool { public static void main(String[] a) {} }",
        "lib/src/com/acme/Helper.java": "package com.acme;\nclass Helper {}",
      },
      ["sym:lib/src/com/acme/Api.java#Api", "sym:lib/src/com/acme/Helper.java#Helper"],
    );
    expect(s).toEqual({ "sym:lib/src/com/acme/Api.java#Api": "live", "sym:lib/src/com/acme/Helper.java#Helper": "orphaned" });
  });

  it("treats Jenkins @Extension classes and JMH benchmarks as entry points", () => {
    const s = states(
      {
        "pom.xml": "<project><artifactId>app</artifactId><build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>",
        "src/main/java/a/Cmd.java": "package a;\n@Extension\npublic class Cmd {}",
        "src/main/java/a/Bench.java": "package a;\npublic class Bench {\n@Benchmark\npublic void run() {}\n}",
      },
      ["sym:src/main/java/a/Cmd.java#Cmd", "sym:src/main/java/a/Bench.java#Bench"],
    );
    expect(s).toEqual({ "sym:src/main/java/a/Cmd.java#Cmd": "live", "sym:src/main/java/a/Bench.java#Bench": "live" });
  });

  it("finds Python packages in maturin's python-source directory", () => {
    const s = states(
      {
        "pyproject.toml": '[project]\nname = "fastlib"\n[build-system]\nbuild-backend = "maturin"\n[tool.maturin]\npython-source = "python"',
        "python/fastlib/__init__.py": "from .core import api\n",
        "python/fastlib/core.py": "def api():\n    pass\n",
      },
      ["sym:python/fastlib/core.py#api"],
    );
    expect(s["sym:python/fastlib/core.py#api"]).toBe("live");
  });
});

describe("dependency noise", () => {
  it("uses the scope from a parent pom's dependencyManagement", () => {
    const root = project({
      "pom.xml": "<project><artifactId>parent</artifactId><dependencyManagement><dependencies><dependency><groupId>org.mockito</groupId><artifactId>mockito-core</artifactId><scope>test</scope></dependency></dependencies></dependencyManagement></project>",
      "core/pom.xml": "<project><artifactId>core</artifactId><dependencies><dependency><groupId>org.mockito</groupId><artifactId>mockito-core</artifactId></dependency><dependency><groupId>com.google.code.gson</groupId><artifactId>gson</artifactId></dependency></dependencies></project>",
    });
    const core = discoverJavaModules(root).find((m) => m.name === "core")!;
    expect(core.dependencies.map((d) => d.artifact)).toEqual(["gson"]);
  });

  it("skips dependencies of a package whose files are all unreachable", () => {
    const root = project({
      "package.json": { name: "root", private: true, workspaces: ["app", "sample"] },
      "app/package.json": { name: "app", bin: "cli.js", dependencies: { lodash: "4.0.0", chalk: "5.0.0" } },
      "app/cli.js": 'import "lodash";',
      "sample/package.json": { name: "sample", private: true, dependencies: { react: "18.0.0" } },
      "sample/src/widget.js": 'import "react";',
    });
    const unused = dependencyReport(analyze(loadConfig(root))).filter((d) => d.use === "unused").map((d) => `${d.package}:${d.name}`);
    expect(unused).toEqual(["app:chalk"]);
  });
});
