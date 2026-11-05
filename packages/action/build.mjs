// Bundle the action into a single committed file so `uses: sid732/loose-ends@v1` starts without npm install.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
await build({
  entryPoints: [fileURLToPath(new URL("./src/main.ts", import.meta.url))],
  outfile: `${root}action/index.mjs`,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  legalComments: "eof",
  minify: true,
  keepNames: true,
  logLevel: "warning",
  alias: { "@loose-ends/core": `${root}packages/core/src/index.ts` },
  // TypeScript is CommonJS: it calls require() for Node built-ins and reads __filename/__dirname.
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "import { dirname as __dirnameOf } from 'node:path';",
      "const require = __createRequire(import.meta.url);",
      "const __filename = __fileURLToPath(import.meta.url);",
      "const __dirname = __dirnameOf(__filename);",
    ].join(" "),
  },
});
