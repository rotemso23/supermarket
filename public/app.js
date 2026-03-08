const STORAGE_KEY = 'supermarket_list';

// ── State ─────────────────────────────────────────────────────────────────────
// state.recipes = [{ title, url, ingredients: [{ text, checked }] }]
let state = { recipes: [], viewMode: 'recipe', showSources: true };

// ── DOM refs ──────────────────────────────────────────────────────────────────
const urlInput          = document.getElementById('recipe-url');
const fetchBtn          = document.getElementById('fetch-btn');
const loadingEl         = document.getElementById('loading');
const errorEl           = document.getElementById('error-msg');
const listSection       = document.getElementById('list-section');
const recipesContainer  = document.getElementById('recipes-container');
const copyBtn           = document.getElementById('copy-btn');
const clearBtn          = document.getElementById('clear-btn');
const viewRecipeBtn     = document.getElementById('view-recipe-btn');
const viewIngredientBtn = document.getElementById('view-ingredient-btn');
const showSourcesToggle = document.getElementById('show-sources-toggle');
const showSourcesCb     = document.getElementById('show-sources-cb');

// ── Persistence ───────────────────────────────────────────────────────────────
function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.recipes)) {
        state = parsed;
      }
    }
    if (!state.viewMode) state.viewMode = 'recipe';
    if (state.showSources === undefined) state.showSources = true;
  } catch {
    state = { recipes: [], viewMode: 'recipe' };
  }
}

// ── Ingredient grouping ───────────────────────────────────────────────────────
function normalizeIngredient(text) {
  let s = text.toLowerCase().trim();
  // Remove unicode fractions
  s = s.replace(/[½⅓⅔¼¾⅛⅜⅝⅞]/g, '');
  // Remove leading numbers (integers, decimals, fractions like 1/2, and Unicode dashes for ranges like 2–3)
  s = s.replace(/^[\d\s/.\-\u2012-\u2015\u2212]+/, '');
  // Remove common units (try multiple passes for compound cases like "2 large cups")
  const units = /^(cups?|tbsp\.?|tsp\.?|tablespoons?|teaspoons?|fl\.?\s*oz\.?|oz\.?|lbs?\.?|pounds?|ounces?|grams?|kg|ml|liters?|litres?|\bl\b|pinch(es)?|handfuls?|bunch(es)?|cans?|cloves?|slices?|pieces?|large|medium|small|heaping|heaped|fresh|dried|whole|boneless|skinless)\s+/i;
  for (let i = 0; i < 4; i++) s = s.replace(units, '');
  // Remove parenthetical notes like (optional), (about 200g)
  s = s.replace(/\s*\(.*?\)\s*/g, ' ');
  // Strip everything after the first comma (preparation notes like "cut into florets", "slightly warmed", "divided")
  s = s.replace(/,.*$/, '');
  // Normalize whitespace and trailing punctuation
  s = s.replace(/\s+/g, ' ').trim().replace(/[;]+$/, '').trim();
  // Canonicalize common synonyms
  const synonyms = {
    'sea salt': 'salt', 'kosher salt': 'salt', 'coarse salt': 'salt',
    'fine salt': 'salt', 'table salt': 'salt', 'flaky salt': 'salt',
  };
  if (synonyms[s]) s = synonyms[s];
  return s || text.toLowerCase().trim();
}

function groupIngredients() {
  const groups = {};
  state.recipes.forEach((recipe, ri) => {
    recipe.ingredients.forEach((ing, ii) => {
      const key = normalizeIngredient(ing.text);
      if (!groups[key]) groups[key] = { key, instances: [], sources: [] };
      groups[key].instances.push({ recipeIdx: ri, ingIdx: ii, text: ing.text, checked: ing.checked });
      if (!groups[key].sources.includes(recipe.title)) groups[key].sources.push(recipe.title);
    });
  });
  return Object.values(groups).sort((a, b) => a.key.localeCompare(b.key));
}

// ── Amount summing ────────────────────────────────────────────────────────────
function sumIngredientAmounts(texts, key) {
  if (texts.length === 1) return texts[0];

  const UNICODE_FRACS = {
    '½': 0.5, '⅓': 1/3, '⅔': 2/3, '¼': 0.25, '¾': 0.75,
    '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875,
  };
  const VOLUME = { tsp: 1, tbsp: 3, cup: 48, floz: 6, ml: 0.202884, l: 202.884 };
  const WEIGHT = { g: 1, kg: 1000, oz: 28.3495, lb: 453.592 };
  const UNIT_ALIASES = {
    cups: 'cup', tbsps: 'tbsp', tsps: 'tsp',
    tablespoon: 'tbsp', tablespoons: 'tbsp',
    teaspoon: 'tsp', teaspoons: 'tsp',
    lbs: 'lb', pound: 'lb', pounds: 'lb',
    ounce: 'oz', ounces: 'oz',
    gram: 'g', grams: 'g',
    kilogram: 'kg', kilograms: 'kg',
    liter: 'l', liters: 'l', litre: 'l', litres: 'l',
    milliliter: 'ml', milliliters: 'ml', millilitre: 'ml', millilitres: 'ml',
  };

  function parseOne(text) {
    let s = text.trim();
    for (const [ch, val] of Object.entries(UNICODE_FRACS)) s = s.replace(ch, String(val));
    const qMatch = s.match(/^(\d+\s+\d+\/\d+|\d+\/\d+|\d*\.?\d+)/);
    if (!qMatch) return null;
    const qs = qMatch[1].trim();
    let qty;
    if (qs.includes('/')) {
      const sp = qs.indexOf(' ');
      if (sp > -1) {
        const [n, d] = qs.slice(sp + 1).split('/').map(Number);
        qty = parseFloat(qs.slice(0, sp)) + n / d;
      } else {
        const [n, d] = qs.split('/').map(Number);
        qty = n / d;
      }
    } else {
      qty = parseFloat(qs);
    }
    if (isNaN(qty)) return null;
    const rest = s.slice(qMatch[0].length).trim();
    const uMatch = rest.match(/^(cups?|tbsp\.?|tsp\.?|tablespoons?|teaspoons?|fl\.?\s*oz\.?|oz\.?|lbs?\.?|pounds?|ounces?|grams?|kg\b|g\b|ml\b|milliliters?|millilitres?|liters?|litres?)/i);
    if (!uMatch) return { qty, type: 'count' };
    const raw = uMatch[1].toLowerCase().replace(/[\s.]/g, '');
    const unit = UNIT_ALIASES[raw] || raw;
    if (VOLUME[unit] !== undefined) return { qty, unit, type: 'volume', base: qty * VOLUME[unit] };
    if (WEIGHT[unit] !== undefined) return { qty, unit, type: 'weight', base: qty * WEIGHT[unit] };
    return { qty, unit, type: 'other' };
  }

  function toNiceFraction(n, maxDenom = 8) {
    if (n <= 0) return null;
    for (const d of [1, 2, 3, 4, 6, 8].filter(d => d <= maxDenom)) {
      const rounded = Math.round(n * d) / d;
      if (Math.abs(rounded - n) / n < 0.02) {
        const whole = Math.floor(rounded);
        const num = Math.round((rounded - whole) * d);
        if (num === 0) return `${whole}`;
        const gcd = (a, b) => b === 0 ? a : gcd(b, a % b);
        const g = gcd(num, d);
        return whole > 0 ? `${whole} ${num / g}/${d / g}` : `${num / g}/${d / g}`;
      }
    }
    return null;
  }

  function formatVolume(tsp) {
    for (const { name, factor, minVal, maxDenom } of [
      { name: 'cup', factor: 48, minVal: 0.25, maxDenom: 8 },
      { name: 'tbsp', factor: 3, minVal: 1, maxDenom: 2 },
      { name: 'tsp', factor: 1, minVal: 0, maxDenom: 8 },
    ]) {
      const val = tsp / factor;
      if (val < minVal) continue;
      const nice = toNiceFraction(val, maxDenom);
      if (nice) return `${nice} ${name}`;
    }
    return `${Math.round(tsp * 10) / 10} tsp`;
  }

  const parsed = texts.map(parseOne).filter(Boolean);
  if (parsed.length !== texts.length) return texts.join(' + ');
  const types = new Set(parsed.map(p => p.type));
  if (types.size !== 1) return texts.join(' + ');
  const type = [...types][0];

  if (type === 'volume') {
    const total = parsed.reduce((s, p) => s + p.base, 0);
    return `${formatVolume(total)} ${key}`;
  }
  if (type === 'weight') {
    const total = parsed.reduce((s, p) => s + p.base, 0);
    if (parsed.every(p => p.unit === 'oz' || p.unit === 'lb')) {
      const oz = total / 28.3495;
      if (oz >= 16) { const nice = toNiceFraction(oz / 16); if (nice) return `${nice} lb ${key}`; }
      const nice = toNiceFraction(oz);
      if (nice) return `${nice} oz ${key}`;
    }
    if (total >= 1000) { const nice = toNiceFraction(total / 1000); if (nice) return `${nice} kg ${key}`; }
    return `${Math.round(total)} g ${key}`;
  }
  if (type === 'count') {
    const total = parsed.reduce((s, p) => s + p.qty, 0);
    const nice = toNiceFraction(total);
    return `${nice || (Math.round(total * 100) / 100)} ${key}`;
  }
  return texts.join(' + ');
}

// ── Render ────────────────────────────────────────────────────────────────────
function render() {
  recipesContainer.innerHTML = '';

  if (state.recipes.length === 0) {
    listSection.classList.add('hidden');
    return;
  }

  listSection.classList.remove('hidden');
  viewRecipeBtn.classList.toggle('active', state.viewMode === 'recipe');
  viewIngredientBtn.classList.toggle('active', state.viewMode === 'ingredient');
  showSourcesToggle.classList.toggle('hidden', state.viewMode !== 'ingredient');
  showSourcesCb.checked = state.showSources;

  if (state.viewMode === 'ingredient') {
    renderByIngredient();
  } else {
    renderByRecipe();
  }
}

function renderByRecipe() {
  state.recipes.forEach((recipe, recipeIdx) => {
    const group = document.createElement('div');
    group.className = 'recipe-group';

    // Recipe heading
    const titleRow = document.createElement('div');
    titleRow.className = 'recipe-title';

    const titleText = document.createElement('span');
    titleText.textContent = recipe.title;
    titleRow.appendChild(titleText);

    const rightSide = document.createElement('span');
    rightSide.style.display = 'flex';
    rightSide.style.alignItems = 'center';
    rightSide.style.gap = '10px';

    if (recipe.url) {
      const link = document.createElement('a');
      link.href = recipe.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'view recipe';
      rightSide.appendChild(link);
    }

    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove-recipe-btn';
    removeBtn.title = 'Remove this recipe';
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', () => {
      state.recipes.splice(recipeIdx, 1);
      saveState();
      render();
    });
    rightSide.appendChild(removeBtn);
    titleRow.appendChild(rightSide);

    group.appendChild(titleRow);

    // Ingredient list
    const ul = document.createElement('ul');
    ul.className = 'ingredient-list';

    recipe.ingredients.forEach((ing, ingIdx) => {
      const li = document.createElement('li');
      const label = document.createElement('label');
      label.className = 'ingredient-item' + (ing.checked ? ' checked' : '');

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = ing.checked;
      checkbox.addEventListener('change', () => {
        state.recipes[recipeIdx].ingredients[ingIdx].checked = checkbox.checked;
        label.classList.toggle('checked', checkbox.checked);
        saveState();
      });

      const span = document.createElement('span');
      span.textContent = ing.text;

      label.appendChild(checkbox);
      label.appendChild(span);
      li.appendChild(label);
      ul.appendChild(li);
    });

    group.appendChild(ul);
    recipesContainer.appendChild(group);
  });
}

function renderByIngredient() {
  const groups = groupIngredients();
  const ul = document.createElement('ul');
  ul.className = 'ingredient-list';

  groups.forEach(group => {
    const allChecked = group.instances.every(inst => inst.checked);
    const li = document.createElement('li');
    const label = document.createElement('label');
    label.className = 'ingredient-item' + (allChecked ? ' checked' : '');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = allChecked;
    checkbox.addEventListener('change', () => {
      group.instances.forEach(inst => {
        state.recipes[inst.recipeIdx].ingredients[inst.ingIdx].checked = checkbox.checked;
      });
      label.classList.toggle('checked', checkbox.checked);
      saveState();
    });

    const textWrapper = document.createElement('div');
    textWrapper.className = 'ingredient-text-wrapper';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'ingredient-name';
    nameSpan.textContent = group.key;
    textWrapper.appendChild(nameSpan);

    // Show original amounts/sources if there are multiple instances or the text has quantities
    const showAmounts = group.instances.length > 1 ||
      group.instances.some(inst => inst.text.toLowerCase().trim() !== group.key);

    if (showAmounts) {
      const amountsDiv = document.createElement('div');
      amountsDiv.className = 'ingredient-amounts';

      group.instances.forEach(inst => {
        const row = document.createElement('div');
        row.className = 'ingredient-amount-row';
        const amountText = document.createTextNode(inst.text);
        row.appendChild(amountText);
        if (state.showSources) {
          const tag = document.createElement('span');
          tag.className = 'recipe-tag';
          tag.textContent = '(' + state.recipes[inst.recipeIdx].title + ')';
          row.appendChild(tag);
        }
        amountsDiv.appendChild(row);
      });

      textWrapper.appendChild(amountsDiv);
    }

    label.appendChild(checkbox);
    label.appendChild(textWrapper);
    li.appendChild(label);
    ul.appendChild(li);
  });

  recipesContainer.appendChild(ul);
}

// ── Fetch recipe ──────────────────────────────────────────────────────────────
async function fetchRecipe() {
  const url = urlInput.value.trim();
  if (!url) return;

  setLoading(true);
  clearError();

  try {
    const res = await fetch(`/api/parse?url=${encodeURIComponent(url)}`);
    const data = await res.json();

    if (!res.ok || data.error) {
      showError(data.error || 'Something went wrong. Please try again.');
      return;
    }

    // Validate URL protocol before storing (prevents javascript: XSS)
    let parsedUrl;
    try { parsedUrl = new URL(url); } catch { parsedUrl = null; }
    if (!parsedUrl || (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:')) {
      showError('Invalid URL: only http and https are supported.');
      return;
    }

    // Append recipe to state
    state.recipes.push({
      title: data.title,
      url: url,
      ingredients: data.ingredients.map(text => ({ text, checked: false })),
    });

    saveState();
    render();
    urlInput.value = '';
  } catch {
    showError('Network error. Make sure the server is running.');
  } finally {
    setLoading(false);
  }
}

// ── Copy unchecked ────────────────────────────────────────────────────────────
function copyUnchecked() {
  const lines = [];

  if (state.viewMode === 'ingredient') {
    groupIngredients()
      .filter(group => !group.instances.every(inst => inst.checked))
      .forEach(group => {
        const uncheckedTexts = group.instances
          .filter(inst => !inst.checked)
          .map(inst => inst.text);
        lines.push(`• ${sumIngredientAmounts(uncheckedTexts, group.key)}`);
      });
  } else {
    state.recipes.forEach(recipe => {
      const unchecked = recipe.ingredients.filter(i => !i.checked);
      if (unchecked.length > 0) {
        lines.push(`--- ${recipe.title} ---`);
        unchecked.forEach(i => lines.push(`• ${i.text}`));
        lines.push('');
      }
    });
  }

  if (lines.length === 0) {
    showInfo('Nothing to copy — all items are checked off!');
    return;
  }

  navigator.clipboard.writeText(lines.join('\n')).then(() => {
    const orig = copyBtn.textContent;
    copyBtn.textContent = 'Copied!';
    setTimeout(() => { copyBtn.textContent = orig; }, 1500);
  }).catch(() => {
    showError('Could not access clipboard. Please copy manually.');
  });
}

// ── Clear all ─────────────────────────────────────────────────────────────────
function clearAll() {
  if (!confirm('Clear the entire shopping list?')) return;
  state = { recipes: [], viewMode: state.viewMode };
  saveState();
  render();
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function setLoading(on) {
  loadingEl.classList.toggle('hidden', !on);
  fetchBtn.disabled = on;
}

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.className = 'error';
}

function showInfo(msg) {
  errorEl.textContent = msg;
  errorEl.className = 'info';
}

function clearError() {
  errorEl.textContent = '';
  errorEl.className = 'error hidden';
}

// ── View toggle ───────────────────────────────────────────────────────────────
viewRecipeBtn.addEventListener('click', () => { state.viewMode = 'recipe'; saveState(); render(); });
viewIngredientBtn.addEventListener('click', () => { state.viewMode = 'ingredient'; saveState(); render(); });
showSourcesCb.addEventListener('change', () => { state.showSources = showSourcesCb.checked; saveState(); render(); });

// ── Event listeners ───────────────────────────────────────────────────────────
fetchBtn.addEventListener('click', fetchRecipe);
urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') fetchRecipe(); });
copyBtn.addEventListener('click', copyUnchecked);
clearBtn.addEventListener('click', clearAll);

// ── Init ──────────────────────────────────────────────────────────────────────
loadState();
render();
