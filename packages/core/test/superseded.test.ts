import { describe, expect, it } from "vitest";
import { check, fingerprint, normalizeName, similarity } from "@loose-ends/core";
import { repo } from "./helpers/project.js";

describe("similarity helpers", () => {
  it("normalizes names", () => {
    expect(normalizeName("fetchUsersV2")).toBe("fetchusers");
    expect(normalizeName("legacy_fetch_users")).toBe("fetchusers");
    expect(normalizeName("newFetchUsers")).toBe("fetchusers");
  });

  it("scores renamed copies as similar and unrelated code as different", () => {
    const a = fingerprint("function sum(xs) { let t = 0; for (const x of xs) { t += x; } return t; }");
    const b = fingerprint("function total(values) { let acc = 0; for (const v of values) { acc += v; } return acc; }");
    const c = fingerprint("class Cache { get(key) { return this.map.get(key) ?? fetch(key).then((r) => r.json()); } }");
    expect(similarity(a.shape, b.shape)).toBe(1);
    expect(similarity(a.shape, c.shape)).toBeLessThan(0.2);
  });
});

const fetchUsers = `export async function fetchUsers(page: number) {
  const response = await fetch("/api/users?page=" + page);
  if (!response.ok) throw new Error("failed: " + response.status);
  const body = await response.json();
  return body.items.map((item: any) => ({ id: item.id, name: item.name }));
}`;

const base = {
  "package.json": { name: "app", main: "src/index.ts" },
  "src/index.ts": `import { fetchUsers } from "./users";\nfetchUsers(1);`,
  "src/users.ts": fetchUsers,
};

describe("superseded detection", () => {
  it("reports an implementation left behind when callers move to a new one", () => {
    const root = repo(base, {
      "src/index.ts": `import { fetchUsersV2 } from "./users-v2";\nfetchUsersV2(1);`,
      "src/users-v2.ts": fetchUsers.replace("fetchUsers(page: number)", "fetchUsersV2(page: number, size = 20)").replace('"?page=" + page', '"?page=" + page + "&size=" + size'),
    });
    const result = check({ root });
    expect(result.findings.map((f) => `${f.kind} ${f.target}`)).toEqual(["superseded src/users.ts"]);
    const finding = result.findings[0]!;
    expect(finding.evidence.related).toEqual(["src/users-v2.ts#fetchUsersV2"]);
    expect(finding.message).toMatch(/callers now use the new code/);
    expect(finding.message).toMatch(/names match/);
  });

  it("keeps newly-orphaned when nothing replaced the code", () => {
    const root = repo(base, { "src/index.ts": `console.log("no users");` });
    expect(check({ root }).findings.map((f) => f.kind)).toEqual(["newly-orphaned"]);
  });

  it("flags added code that duplicates a live implementation", () => {
    const root = repo(base, {
      "src/index.ts": `import { fetchUsers } from "./users";\nimport { loadMembers } from "./members";\nfetchUsers(1);\nloadMembers(2);`,
      "src/members.ts": fetchUsers.replace("fetchUsers", "loadMembers").replace("/api/users", "/api/members"),
    });
    const result = check({ root });
    expect(result.findings.map((f) => `${f.kind} ${f.target}`)).toEqual(["duplicate src/members.ts#loadMembers"]);
    expect(result.findings[0]!.evidence.related).toEqual(["src/users.ts#fetchUsers"]);
  });
});
