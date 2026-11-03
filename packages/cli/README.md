# loose-ends

Command-line interface for [Loose Ends](https://github.com/sid732/loose-ends), the graph-powered liveness checks for AI-written code.

```bash
npx loose-ends check     # report new loose ends in this change
npx loose-ends scan      # report existing unreachable code
npx loose-ends explain <path#symbol>
npx loose-ends roots
npx loose-ends fix --verify --patch cleanup.diff
npx loose-ends init
```

See the [main README](https://github.com/sid732/loose-ends#readme) for details.
