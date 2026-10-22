# Personal preview plugin package

This folder contains a **portable Agent Plugins package template**, separate from the application source archive. Its root files are `plugin.json` and `mcp.json`. The URL in `mcp.json` is the reserved placeholder `replace-me.example` so the public repository does not expose the owner's private Site address.

Before using a package copy, replace the `url` with an authorized hosted HTTPS MCP endpoint that returns a `WWW-Authenticate` challenge and publishes OAuth protected-resource metadata. The portable schema currently accepts `type` and `url` for a remote server; authentication must be discovered from the endpoint or configured through a host-specific validated extension during submission. Never declare a protected server as no-auth. The public template ZIP cannot connect as-is. The current private Site permits only its allowed account; packaging cannot grant other people access to that Site or their WPS files. A public Directory submission also needs an authorized WPS distribution path, a reviewable public tool surface, and the remaining review materials.

Do not add WPS tokens, GitHub credentials, reviewer passwords, or fixed Authorization headers to this package. [Current ZIP status and installation paths](../docs/PLUGIN-ZIP.md).
