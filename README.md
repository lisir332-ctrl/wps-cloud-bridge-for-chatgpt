# WPS Cloud Bridge for ChatGPT

[English](README.md) · [简体中文](README.zh-CN.md)

An open-source **ChatGPT connector for personal WPS cloud documents**. Ask in ChatGPT; the hosted service calls WPS cloud, verifies the result, and returns a WPS link. No local WPS installation or always-on computer is required.

**At a glance**

- **Cross-device:** use supported ChatGPT web, desktop, or mobile surfaces; voice-triggered tools depend on the available mode. [Availability](https://learn.chatgpt.com/docs/plugins)
- **Cloud execution:** your computer can sleep; long jobs may need a later status check.
- **Focused access:** no local files or Shell; WPS access follows the account's actual authorization.
- **Verifiable output:** real WPS links, readback checks, and duplicate-write protection.

Cloud API limits still apply; this connector does not reproduce every desktop WPS feature. Publishing and sharing receive separate review.

**Independent community project. Not made by or endorsed by WPS or OpenAI.** This repository is public source code; the hosted connector is currently private. A public ChatGPT Directory listing has **not** been approved or published. [OpenAI's plugin guidelines](https://developers.openai.com/plugins/plugin-guidelines) say unofficial third-party connectors are not eligible for approval without appropriate authorization.

Public Directory progress is tracked in [issue #1](https://github.com/lisir332-ctrl/wps-cloud-bridge-for-chatgpt/issues/1).

Created and maintained by **[Sergio](https://github.com/lisir332-ctrl)**, with development assistance from **Codex**. See [maintainers and credits](MAINTAINERS.md).

## What it covers

| WPS product | Current cloud path |
| --- | --- |
| Writer, Spreadsheets, Presentations, PDF | Cloud file operations and structured editing or conversion, subject to account permissions |
| Smart Documents and Smart Spreadsheets | OTL block operations and KSHEET spreadsheet operations |
| Smart Forms | Draft creation, reading, updating, and publishing; 14 question types currently exposed |
| Multi-dimensional Tables | Fields, records, views, and a separate Form-view workflow |
| AI PPT | Session-based generation with interruption and task-state handling |

The catalog contains a snapshot of **619 tools** discovered from WPS's personal SkillHub on 2026-10-22. A tool's presence does not prove that every account can use it, that a membership entitlement is available, or that every operation has passed a live-account test. Native cloud editing for mind maps, flowcharts, posters, voice notes, and WPS Notes is not exposed through this personal-cloud path. See the [product guide](docs/PRODUCT-GUIDE.md) and [usage notes](docs/USAGE.md).

## How it works

1. Sign in to the supported hosting environment and connect your own WPS account on its minimal authorization page.
2. In ChatGPT, select the MCP connector and ask for an outcome, such as “Create a Word document introducing tea tasting” or “Find my recent WPS files.”
3. The hosted connector resolves the target and exact tool schema, performs the requested WPS cloud operation, reads back what it can verify, and returns a usable WPS link in the conversation.

The authorization page handles connection, status, and disconnect only. Work happens in the ChatGPT conversation. Forms remain drafts by default. Publishing, deletion, sharing, permission changes, and operations that may consume a paid entitlement receive separate review. Free and member capabilities are determined from WPS's actual response.

**ZIP installation:** the downloadable GitHub Release ZIP is source code, not a ChatGPT plugin upload package. The current private connector is installed through its Sites-generated personal plugin. See [plugin ZIP vs. source ZIP](docs/PLUGIN-ZIP.md) before using ChatGPT's Upload ZIP option.

## Security and hosting

The current deployment relies on a **trusted Sites-injected ChatGPT identity**, a D1 database, and a server-side encryption key. `POST /mcp` exposes tool discovery and calls. User identity is not accepted from the request body or a client-controlled header. WPS credentials are encrypted and isolated per user; the execution deduplication ledger does not store document bodies or tokens.

**Do not deploy this repository as an anonymous public Worker.** A different host needs a verified identity layer and a proxy that strips forged identity headers. Public ChatGPT Directory submission also needs a reviewable authentication flow, a verified publisher, policy URLs, a demo account, and WPS authorization for a public third-party integration. See [deployment and publication boundaries](docs/DEPLOYMENT.md).

## Develop locally

Requires Node.js 22.13+ and pnpm. The checked-in public hosting config uses a zero-value project ID. Replace it with your own project ID before deploying to Sites.

```sh
pnpm install --frozen-lockfile
pnpm build
node tests/run.mjs
pnpm exec tsc --noEmit
```

Bind D1 as `DB`, set `SITE_ORIGIN` to the final HTTPS origin, and supply a 32-byte random `WPS_ENCRYPTION_KEY` as a 64-character hex secret. Never commit tokens, private files, database exports, or live secrets. A successful build, simulated tests, and live WPS account verification are distinct evidence. See [deployment](docs/DEPLOYMENT.md) and [protocol](docs/PROTOCOL.md).

## Community

Questions and feature ideas are welcome in [Discussions](https://github.com/lisir332-ctrl/wps-cloud-bridge-for-chatgpt/discussions). Before contributing, read the [contributing guide](CONTRIBUTING.md), [code of conduct](CODE_OF_CONDUCT.md), [security policy](SECURITY.md), and [third-party notices](THIRD_PARTY_NOTICES.md). See the [changelog](CHANGELOG.md) for version history.

The project is released under the [MIT License](LICENSE). If you find it useful, you can star the [GitHub repository](https://github.com/lisir332-ctrl/wps-cloud-bridge-for-chatgpt) or help improve it.

Maintainer: [Sergio](https://github.com/lisir332-ctrl). Another independent project: [HUC Free AI Hub](https://free.huc.us.ci/).
