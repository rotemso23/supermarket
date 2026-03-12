import html
import ipaddress
import json
import re
import socket
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlparse, quote as url_quote

import requests
from bs4 import BeautifulSoup
from flask import Flask, jsonify, request, send_from_directory

app = Flask(__name__, static_folder='public', static_url_path='')

_PRIVATE_RANGES = (
    ipaddress.ip_network('127.0.0.0/8'),
    ipaddress.ip_network('10.0.0.0/8'),
    ipaddress.ip_network('172.16.0.0/12'),
    ipaddress.ip_network('192.168.0.0/16'),
    ipaddress.ip_network('169.254.0.0/16'),
    ipaddress.ip_network('::1/128'),
    ipaddress.ip_network('fc00::/7'),
)

def _is_safe_url(url):
    """Return False if the URL resolves to a loopback or private address."""
    try:
        hostname = urlparse(url).hostname
        if not hostname:
            return False
        addr = ipaddress.ip_address(socket.gethostbyname(hostname))
        return not any(addr in net for net in _PRIVATE_RANGES)
    except Exception:
        return False

HEADERS = {
    'User-Agent': (
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
        'AppleWebKit/537.36 (KHTML, like Gecko) '
        'Chrome/120.0.0.0 Safari/537.36'
    ),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
}

# ── Parsing helpers ───────────────────────────────────────────────────────────

def find_recipe_in_jsonld(data):
    """Recursively find a Schema.org Recipe object in JSON-LD data."""
    if isinstance(data, list):
        for item in data:
            result = find_recipe_in_jsonld(item)
            if result:
                return result
        return None

    if not isinstance(data, dict):
        return None

    # @graph wrapper — if present, search only within it
    if '@graph' in data and isinstance(data['@graph'], list):
        for item in data['@graph']:
            result = find_recipe_in_jsonld(item)
            if result:
                return result
        return None

    # Direct Recipe object
    rtype = data.get('@type', '')
    types = rtype if isinstance(rtype, list) else [rtype]
    if 'Recipe' in types:
        return data

    return None


_INGREDIENT_PREFIX_RE = re.compile(r'^[\u25A0-\u25FF\u2610-\u2612\u2022\u2023\u2043\u204C\u204D]+\s*')

_WPRM_NOTE_RE = re.compile(r'\s*\(\d+\s+notes?\)\s*$', re.IGNORECASE)

def _clean_ingredient(raw):
    """Strip decorative prefixes, WPRM note indicators, asterisks, decode HTML entities, and trim."""
    cleaned = _INGREDIENT_PREFIX_RE.sub('', str(raw)).strip()
    cleaned = _WPRM_NOTE_RE.sub('', cleaned).strip()
    cleaned = cleaned.replace('*', '').strip()
    return html.unescape(cleaned)

def extract_from_jsonld(soup):
    for script in soup.find_all('script', type='application/ld+json'):
        try:
            parsed = json.loads(script.string or '')
            recipe = find_recipe_in_jsonld(parsed)
            if recipe:
                ingredients = recipe.get('recipeIngredient', [])
                if ingredients:
                    return {
                        'title': recipe.get('name', 'Recipe'),
                        'ingredients': [c for i in ingredients if (c := _clean_ingredient(i))],
                        'source': 'json-ld',
                    }
        except (json.JSONDecodeError, AttributeError):
            continue
    return None


def extract_from_html(soup):
    itemprop_attrs = [
        {'itemprop': 'recipeIngredient'},
        {'itemprop': 'ingredients'},
    ]
    css_selectors = [
        # WP Recipe Maker (wprm-recipe-ingredient are the <li> elements themselves)
        '.wprm-recipe-ingredient',
        # Tasty Recipes plugin
        '.tasty-recipes-ingredients-body li',
        # Mediavine Create
        '.mv-create-ingredients li',
        # Generic fallbacks (broad — listed last to avoid false positives)
        '[class*="ingredient"] li',
        '[class*="Ingredient"] li',
        '.ingredients li',
        '.recipe-ingredients li',
        '.ingredient-list li',
        '#ingredients li',
    ]

    for attrs in itemprop_attrs:
        items = [c for el in soup.find_all(attrs=attrs)
                 if (c := _clean_ingredient(el.get_text(separator=' ', strip=True)))]
        if items:
            title = soup.find('h1')
            return {
                'title': title.get_text(strip=True) if title else 'Recipe',
                'ingredients': items,
                'source': 'html',
            }

    for sel in css_selectors:
        items = [c for el in soup.select(sel)
                 if (c := _clean_ingredient(el.get_text(separator=' ', strip=True)))]
        if items:
            title = soup.find('h1')
            return {
                'title': title.get_text(strip=True) if title else 'Recipe',
                'ingredients': items,
                'source': 'html',
            }

    return None


_WATER_RE = re.compile(
    r'^[\d\s/½¼¾⅓⅔.–-]*'                                                    # optional quantity
    r'(?:cups?|c\.|tbsp\.?|tablespoons?|tsp\.?|teaspoons?|oz\.?|ml|l\b|liters?|litres?|g\b|kg\b|quarts?|qt\.?)?\s*'  # optional unit
    r'(?:boiling|hot|warm|cold|lukewarm|filtered|tap|distilled|sparkling|plain|room[\s-]temperature)?\s*'
    r'water\s*$',
    re.IGNORECASE
)

_SUB_RECIPE_RE = re.compile(
    r'^(?!\s*[\d½¼¾⅓⅔]).*\brecipe\s*$',
    re.IGNORECASE
)

def _is_sub_recipe_title(text):
    """Return True for entries that are sub-recipe links, not actual ingredients."""
    return bool(_SUB_RECIPE_RE.match(text.strip()))


def filter_ingredients(result):
    if result and 'ingredients' in result:
        def _is_water(text):
            cleaned = re.sub(r'[*†‡#]+', '', text.strip())
            cleaned = re.sub(r',.*$', '', cleaned).strip()
            # Strip all parentheticals including nested ones like ((474g))
            prev = None
            while prev != cleaned:
                prev = cleaned
                cleaned = re.sub(r'\([^()]*\)', '', cleaned).strip()
            return bool(_WATER_RE.match(cleaned))
        result['ingredients'] = [i for i in result['ingredients'] if not _is_water(i)]
        result['ingredients'] = [i for i in result['ingredients'] if not _is_sub_recipe_title(i)]
    return result


def parse_html(html):
    soup = BeautifulSoup(html, 'html.parser')
    jsonld_result = extract_from_jsonld(soup)
    html_result = extract_from_html(soup)

    # Prefer whichever source provides richer ingredient text.
    # Some sites (e.g. WP Recipe Maker) include metric equivalents like "(240 g)"
    # in the HTML display but omit them from JSON-LD structured data.
    # If both sources find ingredients with similar counts but HTML has notably
    # more content, use HTML — otherwise JSON-LD is the safer default.
    if jsonld_result and html_result:
        jl_ings = jsonld_result['ingredients']
        ht_ings = html_result['ingredients']
        if abs(len(jl_ings) - len(ht_ings)) <= 2 and ht_ings:
            jl_avg = sum(len(i) for i in jl_ings) / len(jl_ings)
            ht_avg = sum(len(i) for i in ht_ings) / len(ht_ings)
            if ht_avg > jl_avg * 1.15:
                # HTML is richer per ingredient (e.g. metric equivalents included).
                # Keep the cleaner JSON-LD title; use HTML ingredients.
                return filter_ingredients({
                    'title': jsonld_result['title'],
                    'ingredients': ht_ings,
                    'source': 'html',
                })
        return filter_ingredients(jsonld_result)

    return filter_ingredients(jsonld_result or html_result)


# ── Fetch strategies ──────────────────────────────────────────────────────────

MAX_RESPONSE_BYTES = 10 * 1024 * 1024  # 10 MB

def fetch_with_requests(url):
    """Fast fetch using requests. Returns (html, error_dict)."""
    try:
        with requests.Session() as session:
            session.max_redirects = 5
            response = session.get(url, headers=HEADERS, timeout=10)
        if response.ok:
            if len(response.content) > MAX_RESPONSE_BYTES:
                return None, {'exception': 'Response too large'}
            return response.text, None
        return None, {'status': response.status_code}
    except requests.TooManyRedirects:
        return None, {'exception': 'Too many redirects'}
    except requests.Timeout:
        return None, {'timeout': True}
    except requests.RequestException as e:
        return None, {'exception': str(e)}


def fetch_with_playwright(url):
    """Fallback: launch a real browser to render the page."""
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            try:
                context = browser.new_context(
                    user_agent=HEADERS['User-Agent'],
                    locale='en-US',
                    viewport={'width': 1280, 'height': 800},
                )
                page = context.new_page()
                # Block images, fonts, and media to load faster
                page.route('**/*.{png,jpg,jpeg,gif,webp,svg,ico,woff,woff2,ttf,mp4,webm}',
                           lambda route: route.abort())
                response = page.goto(url, timeout=25000, wait_until='domcontentloaded')
                if response and response.ok:
                    # Wait briefly for any JS to populate ingredient data
                    page.wait_for_timeout(1500)
                    html = page.content()
                    return html, None
                status = response.status if response else 0
                return None, {'status': status}
            finally:
                browser.close()
    except Exception as e:
        return None, {'exception': str(e)}


# ── API ───────────────────────────────────────────────────────────────────────

@app.route('/')
def index():
    return send_from_directory('public', 'index.html')


@app.route('/api/parse')
def parse():
    url = request.args.get('url', '').strip()

    if not url:
        return jsonify({'error': 'Missing url parameter.'}), 400

    try:
        parsed = urlparse(url)
        if parsed.scheme not in ('http', 'https'):
            raise ValueError()
    except Exception:
        return jsonify({'error': 'Invalid URL.'}), 400

    if not _is_safe_url(url):
        return jsonify({'error': 'Invalid URL.'}), 400

    # ── Strategy 1: fast requests ────────────────────────────────────────────
    html, err = fetch_with_requests(url)

    if html:
        result = parse_html(html)
        if result:
            return jsonify(result)
        # Got page but no ingredients — try browser in case content is JS-rendered
        html = None

    # ── Strategy 2: headless browser ─────────────────────────────────────────
    html, err2 = fetch_with_playwright(url)

    if not html:
        # Determine best error message
        status = (err2 or err or {}).get('status', 0)
        if (err or {}).get('timeout') or (err2 or {}).get('timeout'):
            msg = 'Request timed out. The site took too long to respond.'
        elif status in (401, 402, 403):
            msg = 'This site is blocking automated access. Try opening the page in your browser and copying the ingredients manually.'
        elif status == 429:
            msg = 'The site is rate-limiting requests. Wait a moment and try again.'
        else:
            msg = f'Could not reach the site. Error: {(err2 or err or {}).get("exception", f"HTTP {status}")}'
        return jsonify({'error': msg}), 502

    result = parse_html(html)
    if not result:
        return jsonify({
            'error': 'Could not find ingredients on this page. The site may use an unsupported format.'
        }), 422

    return jsonify(result)


# ── TheMealDB ingredient search ───────────────────────────────────────────────

MEALDB_BASE = 'https://www.themealdb.com/api/json/v1/1'

ALLOWED_CATEGORIES = {
    'Breakfast', 'Chicken', 'Beef', 'Pasta',
    'Seafood', 'Vegetarian', 'Vegan', 'Dessert',
    'Lamb', 'Pork', 'Starter', 'Side',
}

def _mealdb_get(path):
    """GET from TheMealDB. Returns parsed JSON dict or None on any error."""
    try:
        resp = requests.get(MEALDB_BASE + path, timeout=8)
        if resp.ok:
            return resp.json()
    except Exception:
        pass
    return None


@app.route('/api/search-by-ingredients')
def search_by_ingredients():
    raw = request.args.get('ingredients', '').strip()
    if not raw:
        return jsonify({'results': []})

    ingredients = [i.strip() for i in raw.split(',') if i.strip()][:5]

    category = request.args.get('category', '').strip()
    if category not in ALLOWED_CATEGORIES:
        category = ''

    def fetch_detail(mid):
        return mid, _mealdb_get(f'/lookup.php?i={mid}')

    def parse_meal(mid, m, match_count):
        ings = []
        for n in range(1, 21):
            ing = (m.get(f'strIngredient{n}') or '').strip()
            if not ing:
                continue
            measure = (m.get(f'strMeasure{n}') or '').strip()
            ings.append(f'{measure} {ing}'.strip() if measure else ing)
        source = (m.get('strSource') or '').strip() or f'https://www.themealdb.com/meal/{mid}'
        return {
            'id': mid,
            'title': m.get('strMeal', 'Unknown'),
            'thumbnail': m.get('strMealThumb', ''),
            'sourceUrl': source,
            'ingredients': ings,
            'matchCount': match_count,
        }

    # ── Category-first path ────────────────────────────────────────────────────
    # When a category is selected, use it as the primary filter so results always
    # belong to that category. Pantry ingredients are used only for ranking.
    if category:
        cat_data = _mealdb_get(f'/filter.php?c={url_quote(category)}')
        if cat_data and cat_data.get('meals'):
            cat_ids = [m['idMeal'] for m in cat_data['meals']][:20]

            details = {}
            with ThreadPoolExecutor(max_workers=8) as executor:
                for mid, data in executor.map(fetch_detail, cat_ids):
                    if data:
                        details[mid] = data

            results = []
            for mid in cat_ids:
                data = details.get(mid)
                if not data or not data.get('meals'):
                    continue
                m = data['meals'][0]
                # Rank by how many pantry ingredients appear in the meal
                ing_names = [(m.get(f'strIngredient{n}') or '').strip().lower()
                             for n in range(1, 21)
                             if (m.get(f'strIngredient{n}') or '').strip()]
                match_count = sum(
                    1 for p in ingredients
                    if any(p.lower() in ing or ing in p.lower() for ing in ing_names)
                )
                results.append(parse_meal(mid, m, match_count))

            if results:
                results.sort(key=lambda r: r['matchCount'], reverse=True)
                return jsonify({'results': results[:8], 'category': category, 'fellBack': False})
            # All detail fetches failed — fall through to ingredient-only search

        # Category API failed or returned no usable results — fall through

    # ── Ingredient-first path (no category, or category lookup failed) ─────────
    meal_counts = {}
    meal_thumbs = {}
    meal_titles = {}
    for ingredient in ingredients:
        data = _mealdb_get(f'/filter.php?i={url_quote(ingredient)}')
        if not data:
            continue
        meals = data.get('meals')   # TheMealDB returns null, not [] — guard both
        if not meals:
            continue
        for meal in meals:
            mid = meal.get('idMeal')
            if not mid:
                continue
            meal_counts[mid] = meal_counts.get(mid, 0) + 1
            meal_thumbs[mid] = meal.get('strMealThumb', '')
            meal_titles[mid] = meal.get('strMeal', '')

    if not meal_counts:
        return jsonify({'results': [], 'category': category or None, 'fellBack': bool(category)})

    top_ids = sorted(meal_counts, key=lambda m: meal_counts[m], reverse=True)[:8]

    details = {}
    with ThreadPoolExecutor(max_workers=8) as executor:
        for mid, data in executor.map(fetch_detail, top_ids):
            if data:
                details[mid] = data

    results = []
    for mid in top_ids:
        data = details.get(mid)
        if not data or not data.get('meals'):
            continue
        m = data['meals'][0]
        results.append(parse_meal(mid, m, meal_counts.get(mid, 0)))
        # Restore original title/thumb from filter response (fallback if lookup is sparse)
        if results[-1]['title'] == 'Unknown':
            results[-1]['title'] = meal_titles.get(mid, 'Unknown')
        if not results[-1]['thumbnail']:
            results[-1]['thumbnail'] = meal_thumbs.get(mid, '')

    return jsonify({'results': results, 'category': category or None, 'fellBack': bool(category)})


if __name__ == '__main__':
    print('Supermarket app running at http://localhost:3001')
    app.run(port=3001, debug=False)
