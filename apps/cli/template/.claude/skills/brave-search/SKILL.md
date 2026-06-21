---
name: brave-search
description: "Search the web via Brave Search API. Use when you need to search for current information, news, images, or videos. Supports web, news, images, and video search with freshness filters. Requires BRAVE_API_KEY."
---

# Brave Search API

Search the web using the Brave Search API. The key is `BRAVE_API_KEY` in the `secret` store — run the curl under `secret exec BRAVE_API_KEY -- …` so it arrives in `$BRAVE_API_KEY`. (Falls back to `.claude/settings.local.json` `env.BRAVE_API_KEY` if the store isn't set up.)

**If the key is missing**, the skill is unavailable — tell the user to grab one at https://brave.com/search/api/, then store it with `secret set BRAVE_API_KEY`.

## Endpoints

| Endpoint | Usage |
|----------|-------|
| `/web/search` | General web search |
| `/news/search` | News articles |
| `/images/search` | Image search |
| `/videos/search` | Video search |
| `/suggest/search` | Query autocomplete |

Base URL: `https://api.search.brave.com/res/v1`

## Authentication

```bash
# run under: secret exec BRAVE_API_KEY -- bash <script>   (env var wins; settings.local.json is the fallback)
KEY="${BRAVE_API_KEY:-$(jq -r '.env.BRAVE_API_KEY // empty' .claude/settings.local.json 2>/dev/null)}"
[ -z "$KEY" ] && echo "No BRAVE_API_KEY configured" && exit 1

curl -s -H "Accept: application/json" \
  -H "X-Subscription-Token: $KEY" \
  "https://api.search.brave.com/res/v1/web/search?q=QUERY"
```

## Parameters

| Param | Description | Example |
|-------|-------------|---------|
| `q` | Search query (required) | `q=AI+news+2026` |
| `count` | Results per page (max 20) | `count=10` |
| `offset` | Pagination offset | `offset=10` |
| `freshness` | Time filter | `pd` (24h), `pw` (week), `pm` (month), `py` (year) |
| `search_lang` | Language | `search_lang=zh` |
| `country` | Country code | `country=US` |
| `spellcheck` | Spell correction | `spellcheck=true` |

## Usage Patterns

### Web Search

```bash
curl -s -H "Accept: application/json" \
  -H "X-Subscription-Token: $KEY" \
  "https://api.search.brave.com/res/v1/web/search?q=QUERY&count=10" \
  | python3 -c "
import json, sys
data = json.load(sys.stdin)
for r in data.get('web', {}).get('results', []):
    print(f'{r[\"title\"]}')
    print(f'  {r[\"url\"]}')
    print(f'  {r.get(\"description\", \"\")[:150]}')
    print()
"
```

### News Search

```bash
curl -s -H "Accept: application/json" \
  -H "X-Subscription-Token: $KEY" \
  "https://api.search.brave.com/res/v1/news/search?q=QUERY&count=20&freshness=pw" \
  | python3 -c "
import json, sys
data = json.load(sys.stdin)
for r in data.get('results', []):
    print(f'[{r.get(\"age\",\"\")}] {r[\"title\"]}')
    print(f'  {r[\"url\"]}')
    print(f'  {r.get(\"description\", \"\")[:150]}')
    print()
"
```

## Freshness Cheat Sheet

| Value | Meaning |
|-------|---------|
| `pd` | Past 24 hours |
| `pw` | Past week |
| `pm` | Past month |
| `py` | Past year |
| `YYYY-MM-DDtoYYYY-MM-DD` | Custom range |

## Tips

- URL-encode query: spaces → `+` or `%20`
- Combine multiple queries for comprehensive coverage
- News endpoint returns `results` directly; web endpoint nests under `web.results`
- Rate limit: 50 QPS, $5 free monthly credits
- For Chinese content: add `search_lang=zh` or include Chinese keywords in query
