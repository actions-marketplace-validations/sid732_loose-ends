# Agent skills

Thin instructions that tell coding agents when to run Loose Ends and how to act on what it reports. The engine does the analysis. These files only describe the workflow.

| Skill | Use |
|---|---|
| [check-loose-ends](check-loose-ends/SKILL.md) | Run before finishing a change. Explains each finding kind and what to do about it. |
| [clean-up-loose-ends](clean-up-loose-ends/SKILL.md) | Remove unreachable code with a patch that has been verified against the project's checks. |

## Install

Claude Code: copy a skill folder into `.claude/skills/` in your project, or into `~/.claude/skills/` to use it everywhere.

Other agents: paste the body of `SKILL.md` into your agent instructions file (for example `AGENTS.md`).

Pair the skills with the MCP server so the agent can call the tools directly:

```json
{
  "mcpServers": {
    "loose-ends": { "command": "npx", "args": ["-y", "@loose-ends/mcp"] }
  }
}
```
