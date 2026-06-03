# Security Policy

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Instead, report privately via **[GitHub Security Advisories](https://github.com/SeyhmusKaya/freellmapi-extended/security/advisories/new)** (Security → Report a vulnerability). We aim to acknowledge reports within a few days.

## Scope & hardening notes

FreeLLMAPI-Extended is a self-hosted gateway. When you deploy it:

- **Set a strong `ENCRYPTION_KEY`** (32 random bytes / 64 hex chars). Provider API keys are encrypted at rest with AES-256-GCM using this key — losing it means re-adding every provider key.
- **Protect the dashboard & admin API.** The `/api/*` routes (key management, analytics) have no built-in auth — put the app behind a reverse proxy with Basic Auth / SSO, or bind it to localhost. Only the `/v1/*` consumer endpoints expect a Bearer client key.
- **Never expose the app directly to the public internet without a proxy.** Run the Node app on `127.0.0.1` and terminate TLS + auth at nginx/Caddy/Traefik.
- **Rotate keys if leaked.** Provider keys and issued client keys can be regenerated from the dashboard.
- **Errors are redacted.** Provider error messages are passed through a secret/PII redactor before being stored in analytics, so an echoed credential never lands in the database.

## Supported versions

The latest release on the default branch is supported. Please update before reporting issues.
