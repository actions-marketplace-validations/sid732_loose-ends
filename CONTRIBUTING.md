# Contributing

## Setup

```bash
npm ci
npm run build
npm test
```

Node 20 or later is required.

## Changes

`main` is protected. Every change goes through a pull request:

- CI (`test (20)` and `test (22)`) must pass, and the branch must be up to date with `main`.
- Pull requests are squash-merged, so the PR title becomes the commit message. Use [Conventional Commits](https://www.conventionalcommits.org/) titles (`feat(core): ...`, `fix(cli): ...`).
- Review conversations must be resolved before merging.

If a change touches `packages/core` or `packages/action`, rebuild the Action bundle and commit it, or CI fails:

```bash
npm run bundle:action
```

This also applies to Dependabot pull requests that update runtime dependencies: check out the branch, rebuild the bundle, and push.

## Releasing

1. On a branch, bump the version in `packages/*/package.json`, `VERSION` in `packages/core/src/index.ts`, `TOOL` in `packages/core/src/report/common.ts`, and the client version in `packages/mcp/test/server.test.ts`. Run `npm install --package-lock-only`, then `npm run bundle:action` and `npm test`.
2. Open a pull request titled `chore: release X.Y.Z` and squash-merge it.
3. Tag the merge commit and move the major tag:

   ```bash
   git switch main && git pull
   git tag -a vX.Y.Z -m vX.Y.Z
   git tag -fa v1 -m v1
   git push origin vX.Y.Z
   git push -f origin v1
   ```

   `vX.Y.Z` tags cannot be moved or deleted once pushed. `v1` is meant to move.
4. Publish a GitHub release for `vX.Y.Z`. The Release workflow then waits for approval in the `npm` environment; approve it and it publishes `@loose-ends/core`, `loose-ends`, and `@loose-ends/mcp` to npm with provenance.
