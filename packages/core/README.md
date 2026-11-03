# @loose-ends/core

The Liveness Graph engine behind [Loose Ends](https://github.com/sid732/loose-ends).

```ts
import { check, scan, analyze, explain, loadConfig, formatReport } from "@loose-ends/core";

const result = check({ root: process.cwd(), base: "origin/main" });
console.log(formatReport(result, "text"));
process.exitCode = result.passed ? 0 : 1;

const analysis = analyze(loadConfig(process.cwd()));
console.log(explain(analysis, "src/lib/format.ts#formatUser"));
```

See [docs/architecture.md](https://github.com/sid732/loose-ends/blob/main/docs/architecture.md).
