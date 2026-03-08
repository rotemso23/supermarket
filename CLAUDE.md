# Supermarket Shopping List App

## What this app does
Paste a recipe URL → extracts ingredients automatically → creates a checklist → check off items you already have at home. Multiple recipes can be added to one list.

## How to run
```
cd C:\Users\משתמש\Desktop\supermarket
python server.py
```
Then open http://localhost:3000 in the browser. Keep the terminal open.

## Tech stack
- **Backend**: Python + Flask (server.py)
- **Frontend**: Vanilla HTML/CSS/JS (public/)
- **Dependencies**: flask, requests, beautifulsoup4, playwright (Chromium)

## File structure
```
server.py          # Flask server + recipe parsing API
public/
  index.html       # App shell
  style.css        # Styling
  app.js           # Frontend logic (fetch, render, localStorage)
```

## How recipe parsing works
`GET /api/parse?url=<encoded-url>` — two strategies in order:
1. **requests** (fast) — fetches page with browser-like headers, parses JSON-LD Schema.org `recipeIngredient` field, falls back to HTML selectors
2. **Playwright** (fallback) — launches headless Chromium if requests fails or page has no ingredients (JS-rendered sites)

JSON-LD parsing handles: root object, array of objects, `@graph` wrapper, `@type` as array.

HTML fallback selectors: `[itemprop="recipeIngredient"]`, `[class*="ingredient"] li`, `.ingredients li`, etc.

## Frontend state (localStorage key: `supermarket_list`)
```json
{
  "recipes": [
    { "title": "...", "url": "...", "ingredients": [{ "text": "...", "checked": false }] }
  ]
}
```

## Known limitations
- Sites that block datacenter/cloud IPs (e.g. Dotdash Meredith: allrecipes.com, simplyrecipes.com) return 402 when tested from cloud environments but work fine from a home IP
- Heavy Cloudflare protection may block even Playwright
