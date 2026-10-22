# Contributing

We welcome documentation fixes, carefully verified WPS cloud workflows, and connector improvements.

1. Search existing issues first. When reporting a bug, include the file type, tool name, expected behavior, and actual result. Never include WPS tokens, authorization codes, private document content, share credentials, or personal data.
2. Read `docs/PRODUCT-GUIDE.md`, `docs/USAGE.md`, and `docs/PROTOCOL.md` before changing an upstream integration. A new capability needs an official reference, its actual input schema, a risk classification, and an honest live-account validation status. A website button alone is not evidence that an API exists.
3. Explain the change's scope, identity and data-isolation risks, failure states, and link source. Keep request-ID deduplication and post-write readback. Publishing, deletion, sharing, and paid actions must remain separately reviewed.
4. Run `node tests/run.mjs`, `pnpm exec tsc --noEmit`, and `pnpm build`. If you cannot validate with a real WPS account, say so and distinguish simulated tests from live results.
5. Open a pull request for maintainer review. Do not upload account credentials or database exports to the repository or CI.

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
