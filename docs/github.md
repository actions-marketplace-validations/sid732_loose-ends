# Running on GitHub

There are two ways to run Loose Ends on pull requests. Both produce the same findings.

## GitHub Action (recommended)

The Action runs on GitHub's own runners, so you need no server. It is free for public repositories, and private repositories use your regular Actions minutes (a run usually takes well under a minute).

```yaml
# .github/workflows/loose-ends.yml
name: Loose Ends
on: pull_request
permissions:
  contents: read
  pull-requests: write # for the sticky comment; drop it to skip commenting
jobs:
  liveness:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
      - uses: sid732/loose-ends@v1
```

`fetch-depth: 0` is required, because the base commit has to exist locally. Node.js setup is not needed: the Action ships as one bundled file and runs on the runner's built-in Node.

On each pull request, the Action:

- adds inline annotations on the diff for each finding (errors in red, warnings in yellow),
- writes the full report to the job summary,
- posts one PR comment and updates it on later pushes (with `comment: on-findings`, it only appears once there is something to report),
- fails the job when blocking findings exist. Make the job a required status check in branch protection to block merges.

| Input | Default | Meaning |
|---|---|---|
| `working-directory` | `.` | Project root inside the repository. Use one step per project in a monorepo with several roots. |
| `base` | PR base | Base revision to compare against. |
| `fail-on` | project config | Comma-separated finding kinds that fail the job. |
| `fail` | `true` | Set to `false` to report without failing. |
| `annotations` | `true` | Inline annotations on the diff. |
| `comment` | `on-findings` | `on-findings`, `always`, or `never`. |
| `sarif` | empty | Path to write a SARIF file, for `github/codeql-action/upload-sarif` (free on public repositories, needs GitHub Advanced Security on private ones). |

Outputs: `passed`, `findings`, `blocking`, `sarif`.

Pull requests opened from forks get a read-only token, so the comment is skipped with a warning. Annotations and the pass/fail result still work.

GitHub shows at most 10 error and 10 warning annotations per step on the diff. The job summary and the comment always list every finding.

## GitHub App (self-hosted)

The App needs a server you run. It is only worth it if you want one install to cover many repositories without adding a workflow file to each one. Everything the App reports, the Action reports too.

1. Create the app from [`packages/github-app/app.yml`](../packages/github-app/app.yml). It needs `checks: write`, `issues: write` (for the comment), `contents: read`, and `metadata: read`, and it subscribes to `pull_request`.
2. Download the private key and note the app ID and webhook secret.
3. Run the server:

   ```bash
   docker build -t loose-ends-app .
   docker run -p 3000:3000 -e APP_ID=... -e WEBHOOK_SECRET=... -e PRIVATE_KEY="$(cat key.pem)" loose-ends-app
   ```

   Webhooks are served at `/api/github/webhooks`, and `/healthz` returns `ok`.
4. Install the app on the repositories you want checked.
5. To block merges, add **Loose Ends** as a required status check in branch protection.

### Per-repository settings

Put `.github/loose-ends.json` in the repository:

```json
{
  "projects": ["apps/web", "packages/api"],
  "blockMerges": true,
  "comment": "on-findings",
  "checkName": "Loose Ends"
}
```

| Setting | Default | Meaning |
|---|---|---|
| `projects` | `["."]` | Project roots to analyze. Each one uses its own `loose-ends.config.json`. |
| `blockMerges` | `true` | Fail the check run on blocking findings. If `false`, findings are reported but the run still succeeds. |
| `comment` | `on-findings` | `always`, `on-findings` (after the first comment, it keeps being updated), or `never`. |
| `checkName` | `Loose Ends` | Name of the check run. Match this in branch protection. |

If the app cannot analyze a PR (clone failure, invalid config), it reports a neutral check with the error. It does not block the PR.
