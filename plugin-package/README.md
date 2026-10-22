# Personal preview plugin package

This is a configured **preview** package for the independent, hosted WPS Cloud Bridge. Its `mcp.json` points to the new public Site, which has its own empty database and encryption key. The original owner's private Site and WPS connection are not included.

To try it, upload the ZIP whose root contains `plugin.json` and `mcp.json` using ChatGPT Plugins' **With MCP** path. If ChatGPT accepts the package and connects to the server, sign in with your own ChatGPT account, open the authorization page, and authorize your own WPS account. Never paste WPS credentials into chat. The server uses the ChatGPT-provided user ID to select encrypted credentials and rejects missing identity.

This path has **not** been validated with a second ChatGPT account or completed ZIP upload. The package is not a public Plugin Directory listing. WPS distribution rights and OpenAI public review requirements remain open. A ZIP registers plugin configuration; the cloud Site runs the operations.

See [installation status and limitations](../docs/PLUGIN-ZIP.md).
