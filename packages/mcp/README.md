# @loose-ends/mcp

MCP server for [Loose Ends](https://github.com/sid732/loose-ends). It lets coding agents check whether the code they wrote is reachable before they finish.

```json
{ "mcpServers": { "loose-ends": { "command": "npx", "args": ["-y", "@loose-ends/mcp"] } } }
```

Pass `--root <dir>` or set `LOOSE_ENDS_ROOT` to analyze a directory other than the working directory.

| Tool | Purpose |
|---|---|
| `check_changes` | Compare the working tree or a head ref with its base and report new loose ends. |
| `scan_project` | Report all unreachable code in the project. |
| `explain` | Explain why a file, symbol, or dependency is or is not reachable. |
| `list_roots` | List discovered entry points. |
| `plan_cleanup` | Return a removal patch, optionally verified against the project's checks. It never writes files. |
