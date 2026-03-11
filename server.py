import ipaddress
import json
import re
import socket
from urllib.parse import urlparse

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
                        'ingredients': [str(i).strip() for i in ingredients if str(i).strip()],
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
        items = [el.get_text(separator=' ', strip=True) for el in soup.find_all(attrs=attrs)]
        items = [i for i in items if i]
        if items:
            title = soup.find('h1')
            return {
                'title': title.get_text(strip=True) if title else 'Recipe',
                'ingredients': items,
                'source': 'html',
            }

    for sel in css_selectors:
        items = [el.get_text(separator=' ', strip=True) for el in soup.select(sel)]
        items = [i for i in items if i]
        if items:
            title = soup.find('h1')
            return {
                'title': title.get_text(strip=True) if title else 'Recipe',
                'ingredients': items,
                'source': 'html',
            }

    return None


_WATER_RE = re.compile(
    r'^[\d\s/½¼¾⅓⅔.–-]*'          # optional quantity (numbers, fractions, dashes)
    r'(?:cups?|c\.|tbsp\.?|tsp\.?|oz\.?|ml|l|liters?|quarts?|qt\.?)?\s*'  # optional unit
    r'water\s*$',
    re.IGNORECASE
)

def filter_ingredients(result):
    if result and 'ingredients' in result:
        result['ingredients'] = [
            i for i in result['ingredients']
            if not _WATER_RE.match(i.strip())
        ]
    return result


def parse_html(html):
    soup = BeautifulSoup(html, 'html.parser')
    return filter_ingredients(extract_from_jsonld(soup) or extract_from_html(soup))


# ── Fetch strategies ──────────────────────────────────────────────────────────

MAX_RESPONSE_BYTES = 10 * 1024 * 1024  # 10 MB

def fetch_with_requests(url):
    """Fast fetch using requests. Returns (html, error_dict)."""
    try:
        response = requests.get(url, headers=HEADERS, timeout=10, max_redirects=5)
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


if __name__ == '__main__':
    print('Supermarket app running at http://localhost:3000')
    app.run(port=3000, debug=False)
