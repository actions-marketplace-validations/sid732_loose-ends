# Examples

Small projects used by the end-to-end tests. Each test copies one into a temporary git repository, applies a change of the kind coding agents tend to make, and checks what Loose Ends reports.

| Example | Shows |
|---|---|
| [express-api](express-api) | An Express server whose routes are wired up in code. Covers superseded services, orphaned helpers, and removed routes. |
| [next-app](next-app) | Next.js App Router with `@/` path aliases. Pages, layouts, and route handlers are roots. |
| [workspace](workspace) | An npm workspace. Library exports are public API, while files inside the library that nothing exports are not. |

Try one by hand:

```bash
cd examples/express-api
npx loose-ends roots
npx loose-ends scan
```
