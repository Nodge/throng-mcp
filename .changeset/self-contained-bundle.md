---
"throng-mcp": minor
---

The package is self-contained: the runtime libraries (`@agentclientprotocol/sdk`, `@modelcontextprotocol/sdk`, `ajv`, `yaml`, `zod`) are bundled into `dist/`, and `package.json` has no `dependencies`. `npx -y throng-mcp` fetches one tarball and resolves nothing else; the versions a user runs are the ones the release was tested with. `dist/THIRD_PARTY_LICENSES.md` lists every bundled package with its license text.
