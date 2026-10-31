import { cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { check, scan } from "@loose-ends/core";
import { git, project, writeFiles } from "./helpers/project.js";

const examples = join(dirname(fileURLToPath(import.meta.url)), "../../../examples");

/** Copy an example into a fresh repo, commit it as main, then apply a change. */
function scenario(example: string, change: Record<string, string | object | null>): string {
  const root = project({});
  cpSync(join(examples, example), root, { recursive: true });
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  for (const [path, content] of Object.entries(change)) {
    if (content === null) git(root, "rm", "-q", path);
    else writeFiles(root, { [path]: content });
  }
  return root;
}

const kinds = (root: string) => check({ root }).findings.map((f) => `${f.kind} ${f.target}`);

describe("examples are clean at rest", () => {
  for (const example of ["express-api", "next-app", "workspace"]) {
    it(example, () => {
      const result = scan({ root: join(examples, example) });
      expect(result.findings.filter((f) => f.kind !== "uncertain").map((f) => `${f.kind} ${f.target}`)).toEqual([]);
    });
  }
});

describe("express-api", () => {
  it("catches a v2 rewrite that leaves the old service behind", () => {
    const root = scenario("express-api", {
      "src/services/users-v2.ts": `import { formatUser, type User } from "../lib/format.js";

const store: User[] = [];

export async function listUsersV2(page: number, size = 20) {
  const start = (page - 1) * size;
  const rows = store.slice(start, start + size);
  if (rows.length === 0) return { page, items: [] };
  return { page, size, items: rows.map((row) => formatUser(row)) };
}
`,
      "src/routes/users.ts": `import { Router } from "express";
import { listUsersV2 } from "../services/users-v2.js";

export const users = Router();
users.get("/", async (req, res) => {
  const page = Number(req.query.page ?? 1);
  res.json(await listUsersV2(page));
});
`,
    });
    const findings = check({ root }).findings;
    // The old service is still imported by its test, so it is test-only now, and the v2 service replaced it.
    expect(findings.map((f) => `${f.kind} ${f.target}`)).toEqual(["superseded src/services/users.ts"]);
    expect(findings[0]!.evidence).toMatchObject({ before: "live", after: "test-only", related: ["src/services/users-v2.ts#listUsersV2"] });
  });

  it("reports superseded when the old implementation has no tests left", () => {
    const root = scenario("express-api", {
      "src/services/users.test.ts": null,
      "src/services/users-v2.ts": `import { formatUser, type User } from "../lib/format.js";

const store: User[] = [];

export async function listUsersV2(page: number) {
  const size = 10;
  const start = (page - 1) * size;
  const rows = store.slice(start, start + size);
  if (rows.length === 0) return { page, items: [] };
  return { page, items: rows.map((row) => formatUser(row)) };
}
`,
      "src/routes/users.ts": `import { Router } from "express";
import { listUsersV2 } from "../services/users-v2.js";

export const users = Router();
users.get("/", async (req, res) => res.json(await listUsersV2(Number(req.query.page ?? 1))));
`,
    });
    const findings = check({ root }).findings;
    expect(findings.map((f) => `${f.kind} ${f.target}`)).toEqual(["superseded src/services/users.ts"]);
    expect(findings[0]!.evidence.related).toEqual(["src/services/users-v2.ts#listUsersV2"]);
  });

  it("catches a helper that was written but never wired in", () => {
    const root = scenario("express-api", {
      "src/lib/pagination.ts": `export function paginate<T>(rows: T[], page: number, size = 10) {\n  return rows.slice((page - 1) * size, page * size);\n}\n`,
    });
    expect(kinds(root)).toEqual(["orphaned-addition src/lib/pagination.ts"]);
  });

  it("catches a route that was unregistered", () => {
    const root = scenario("express-api", {
      "src/routes/index.ts": `import { Router } from "express";\nimport { users } from "./users.js";\n\nexport const routes = Router();\nroutes.use("/users", users);\n`,
    });
    const findings = check({ root }).findings;
    expect(findings.map((f) => `${f.kind} ${f.target}`)).toEqual(["newly-orphaned src/routes/health.ts"]);
    expect(findings[0]!.evidence.brokenEdge).toMatchObject({ from: "src/routes/index.ts", to: "src/routes/health.ts", reason: "removed" });
  });
});

describe("next-app", () => {
  it("accepts a new page and flags a component nothing renders", () => {
    const root = scenario("next-app", {
      "app/settings/page.tsx": `export default function Settings() {\n  return <h1>Settings</h1>;\n}\n`,
      "components/settings-form.tsx": `export function SettingsForm() {\n  return <form />;\n}\n`,
    });
    expect(kinds(root)).toEqual(["orphaned-addition components/settings-form.tsx"]);
  });

  it("flags non-route exports added to a page", () => {
    const root = scenario("next-app", {
      "app/page.tsx": `import { Hero } from "@/components/hero";\n\nexport default function Home() {\n  return <Hero title="Welcome" />;\n}\n\nexport function formatTitle(t: string) {\n  return t.toUpperCase();\n}\n`,
    });
    expect(kinds(root)).toEqual(["orphaned-addition app/page.tsx#formatTitle"]);
  });
});

describe("workspace", () => {
  it("treats library exports as public API but flags unexported library files", () => {
    const root = scenario("workspace", {
      "packages/ui/src/index.ts": `export { Button } from "./button.js";\nexport { Card } from "./card.js";\nexport { Badge } from "./badge.js";\n`,
      "packages/ui/src/badge.tsx": `export function Badge({ text }: { text: string }) {\n  return <span>{text}</span>;\n}\n`,
      "packages/ui/src/tooltip.tsx": `export function Tooltip() {\n  return null;\n}\n`,
    });
    expect(kinds(root)).toEqual(["orphaned-addition packages/ui/src/tooltip.tsx"]);
  });
});
