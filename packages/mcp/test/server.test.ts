import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "@loose-ends/mcp";
import { repo } from "../../core/test/helpers/project.js";

async function connect(root: string) {
  const server = createServer({ root });
  const client = new Client({ name: "test", version: "1.1.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

type Text = { type: string; text: string };
const texts = (r: unknown) => ((r as { content: Text[] }).content ?? []).map((c) => c.text);

const base = {
  "package.json": { name: "app", main: "index.ts" },
  "index.ts": `import { a } from "./a";\na();`,
  "a.ts": `export function a() {}`,
};

describe("MCP server", () => {
  it("lists tools with read-only annotations", async () => {
    const client = await connect(repo(base));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["check_changes", "explain", "list_roots", "plan_cleanup", "scan_project"]);
    expect(tools.find((t) => t.name === "check_changes")?.annotations?.readOnlyHint).toBe(true);
  });

  it("checks changes and returns structured findings", async () => {
    const client = await connect(repo(base, { "b.ts": "export const b = 1;\n" }));
    const result = await client.callTool({ name: "check_changes", arguments: {} });
    const [summary, json] = texts(result);
    expect(summary).toContain("orphaned-addition  b.ts:1");
    const data = JSON.parse(json!);
    expect(data.passed).toBe(false);
    expect(data.findings[0]).toMatchObject({ kind: "orphaned-addition", target: "b.ts", blocking: true, location: "b.ts:1" });
  });

  it("explains targets and reports unknown ones as errors", async () => {
    const client = await connect(repo(base));
    const [text] = texts(await client.callTool({ name: "explain", arguments: { target: "a.ts#a" } }));
    expect(text).toContain("a.ts#a  live");
    const missing = await client.callTool({ name: "explain", arguments: { target: "zzz.ts" } });
    expect(missing.isError).toBe(true);
  });

  it("lists roots and plans cleanup without touching the tree", async () => {
    const root = repo(base, { "b.ts": "export const b = 1;\n" });
    const client = await connect(root);
    const roots = JSON.parse(texts(await client.callTool({ name: "list_roots", arguments: {} }))[0]!);
    expect(roots).toEqual([expect.objectContaining({ target: "index.ts", kind: "production" })]);
    const [plan, patch] = texts(await client.callTool({ name: "plan_cleanup", arguments: {} }));
    expect(JSON.parse(plan!).actions[0]).toMatchObject({ type: "delete-file", path: "b.ts" });
    expect(patch).toContain("deleted file mode");
    const { existsSync } = await import("node:fs");
    expect(existsSync(`${root}/b.ts`)).toBe(true);
  });
});
