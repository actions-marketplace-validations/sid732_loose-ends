import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@loose-ends/core": pkg("core"),
      "loose-ends": pkg("cli"),
      "@loose-ends/mcp": pkg("mcp"),
      "@loose-ends/github-app": pkg("github-app"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
