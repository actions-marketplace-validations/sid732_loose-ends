# Running on GitHub

There are two ways to run Loose Ends on pull requests. Both produce the same findings.

## GitHub Action

Use the Action if you want the check to run inside your own CI.

```yaml
# .github/workflows/loose-ends.yml
name: Loose Ends
on: pull_request
permissions:
  contents: read
  security-events: write
jobs:
  liveness:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - id: loose-ends
        uses: sid732/loose-ends@main
      - if: always() && steps.loose-ends.outputs.sarif != ''
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: loose-ends.sarif
          category: loose-ends
```

`fetch-depth: 0` is required, because the base commit has to exist locally. The markdown report goes to the job summary, and the job fails when blocking findings exist.

## GitHub App

Use the App if you want annotations and a sticky PR comment on every repository without editing each workflow.

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
