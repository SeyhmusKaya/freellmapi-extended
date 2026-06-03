# Contributing to FreeLLMAPI-Extended

Thanks for your interest in improving FreeLLMAPI-Extended! Contributions of any size are welcome — a new free provider, a routing improvement, a bug fix, docs, or a translation.

## Getting started

```bash
git clone https://github.com/SeyhmusKaya/freellmapi-extended.git
cd freellmapi-extended
npm install
cp .env.example .env   # set ENCRYPTION_KEY
npm run dev
```

## Before you open a PR

- **Run the tests:** `npm test -w server`
- **Type-check / build:** `npm run build`
- Keep changes focused — one logical change per PR.
- Add or update tests for behavioural changes.
- **Never commit secrets.** No API keys, `.env` files, or real provider credentials. Tests must use fake, key-shaped fixtures (e.g. `myllm-0000…`), never real keys.

## Adding a new provider

Most providers are OpenAI-compatible and need only:
1. A registration in `server/src/providers/index.ts` (base URL; set `requiresApiKey: false` for keyless gateways).
2. A catalog migration in `server/src/db/index.ts` seeding the models (with measured rate limits where known) and calling `applyQualityOrder`.
3. A note in `docs/FREE-PROVIDERS-RESEARCH.md`.

## Adding a translation

Copy `README.md`, translate the prose (keep code blocks, links, and the language-nav block intact), and save as `README.<lang>.md`. Add your language to the nav block in every README.

## Code style

- TypeScript, no `any` where avoidable.
- Comments explain **why**, not what.
- Match the surrounding style.

## Reporting bugs / requesting features

Open an issue using the templates. For security issues, see [SECURITY.md](SECURITY.md) — please do **not** open a public issue for vulnerabilities.
