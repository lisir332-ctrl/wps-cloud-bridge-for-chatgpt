---
name: wps-cloud-bridge-get-started
description: Help the user connect their personal WPS account to the current WPS Cloud Bridge hosted plugin and verify that the connection works.
---

# Get started with WPS Cloud Bridge

1. Explain that this package points to the existing hosted cloud connector. The current Site is private and may not be accessible to another ChatGPT account. Do not claim public Directory availability.
2. Ask the user to open the connector's authorization page and connect their own WPS account there. Never ask them to paste a WPS token, authorization code, or password into chat.
3. After they return, call the plugin's connection-status tool. If connected, begin with a read-only file lookup. Use the actual WPS file ID and schema before any write.
4. Return real WPS links and readback evidence. Publishing, deletion, sharing, and potentially paid operations still require their own review.

For package limitations, see the repository's `docs/PLUGIN-ZIP.md`.
