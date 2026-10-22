# Security policy

## Supported versions

We prioritize the latest main branch and release for identity isolation, credential handling, unauthorized cloud-file access, duplicate writes, and link leaks. Older versions may receive migration guidance only.

## Reporting a vulnerability

Use the repository's **Report a vulnerability** private reporting flow. If it is unavailable, ask the maintainer for a private contact channel before sharing details. Do not publish tokens, authorization codes, private file content, exploit requests, or personal data in a public issue.

A report can include the affected version, reproduction steps, expected and actual behavior, and impact. Use test accounts and redacted data. The maintainer will acknowledge the report and coordinate a fix and disclosure timeline.

## Deployment boundary

The current implementation trusts user identity only when injected by the controlled Sites platform. Deploying it anonymously or trusting a client-supplied `oai-authenticated-user-id` header would break account isolation. Self-hosters must add independently verified authentication, protect the database and encryption key, and restrict sensitive actions.
