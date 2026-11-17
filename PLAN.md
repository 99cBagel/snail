# snail — Plan

## What it is
- A platform / ecosystem of individual professional knowledge spaces
- Domain: **snail.keeg.uk**
- Tagline: Professional Knowledge Base · A2A access · Connect with Agent, then Ask Anonymously
- NOT a tenant: Snail Eyes stays on its own domain (snail-eyes.keeg.uk)

## Spaces
- `/<space>` — a principal's KB (e.g. /joesmith, /simonchen)
- `/topic_xxxx` — a topic space
- Maintained manually by the operator — no self-signup, a handful of tenants

## Link shapes (settled)
| | Shape |
| --- | --- |
| Page | `snail.keeg.uk/<space>` |
| MCP hook | `snail.keeg.uk/<space>/mcp` |

- The hook is the page link + `/mcp` — one rule for every tenant
- No root directory hook; each space stands alone
- Path form, not query, not per-tenant subdomains — a space can branch later without changing its hook

## MCP per space
- Same pattern as the Snail Eyes KB MCP: 3 generic tools — `kb_topics` / `kb_search` / `kb_get`
- Answers only from that space's KB documents; stores nothing
- Space page carries a Connect button (one tap copies the connect text with the space's /mcp link)

## Storage — minimize KV
- KB documents live in **R2** (one folder per space)
- **No KV namespaces** — nothing in KV unless a later step proves it necessary
- Adding a space = adding its docs folder; no code change

## Brand
- Same logo and icon as Snail Eyes: the line snail, #9c6642 on #f4f1ec (see `logo/`)
- Same styling family as the Snail Eyes pages

## Deploy
- GitHub → Cloudflare via GitHub Actions (repo secrets CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN are set)
- Custom domain snail.keeg.uk to attach when the Worker first deploys
