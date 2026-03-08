const STORAGE_KEY = 'supermarket_list';

// ── State ─────────────────────────────────────────────────────────────────────
// state.recipes = [{ title, url, ingredients: [{ text, checked }] }]
let state = { recipes: [], viewMode: 'recipe' };

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

// ── Persistence ───────────────────────────────────────────────────────────────
function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) state = JSON.parse(raw);
    if (!state.viewMode) state.viewMode = 'recipe';
  } catch {
    state = { recipes: [], viewMode: 'recipe' };
  }
}

// ── Ingredient grouping ───────────────────────────────────────────────────────
function normalizeIngredient(text) {
  let s = text.toLowerCase().trim();
  // Remove unicode fractions
  s = s.replace(/[½⅓⅔¼¾⅛⅜⅝⅞]/g, '');
  // Remove leading numbers (integers, decimals, fractions like 1/2)
  s = s.replace(/^[\d\s/.\-]+/, '');
  // Remove common units (try multiple passes for compound cases like "2 large cups")
  const units = /^(cups?|tbsp\.?|tsp\.?|tablespoons?|teaspoons?|fl\.?\s*oz\.?|oz\.?|lbs?\.?|pounds?|ounces?|grams?|kg|ml|liters?|litres?|\bl\b|pinch(es)?|handfuls?|bunch(es)?|cans?|cloves?|slices?|pieces?|large|medium|small|heaping|heaped|fresh|dried|whole|boneless|skinless)\s+/i;
  for (let i = 0; i < 4; i++) s = s.replace(units, '');
  // Remove parenthetical notes like (optional), (about 200g)
  s = s.replace(/\s*\(.*?\)\s*/g, ' ');
  // Normalize whitespace and trailing punctuation
  s = s.replace(/\s+/g, ' ').trim().replace(/[,;]+$/, '').trim();
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

      if (group.sources.length > 1) {
        // Multiple recipes — show each amount with a recipe tag
        group.instances.forEach((inst, i) => {
          if (i > 0) {
            const dot = document.createTextNode(' · ');
            amountsDiv.appendChild(dot);
          }
          const amountText = document.createTextNode(inst.text + ' ');
          amountsDiv.appendChild(amountText);
          const tag = document.createElement('span');
          tag.className = 'recipe-tag';
          tag.textContent = state.recipes[inst.recipeIdx].title;
          amountsDiv.appendChild(tag);
        });
      } else {
        // Same recipe — just show the original text(s)
        amountsDiv.textContent = group.instances.map(i => i.text).join(' · ');
      }

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
  state.recipes.forEach(recipe => {
    const unchecked = recipe.ingredients.filter(i => !i.checked);
    if (unchecked.length > 0) {
      lines.push(`--- ${recipe.title} ---`);
      unchecked.forEach(i => lines.push(`• ${i.text}`));
      lines.push('');
    }
  });

  if (lines.length === 0) {
    showError('Nothing to copy — all items are checked off!');
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
  errorEl.classList.remove('hidden');
}

function clearError() {
  errorEl.textContent = '';
  errorEl.classList.add('hidden');
}

// ── View toggle ───────────────────────────────────────────────────────────────
viewRecipeBtn.addEventListener('click', () => { state.viewMode = 'recipe'; saveState(); render(); });
viewIngredientBtn.addEventListener('click', () => { state.viewMode = 'ingredient'; saveState(); render(); });

// ── Event listeners ───────────────────────────────────────────────────────────
fetchBtn.addEventListener('click', fetchRecipe);
urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') fetchRecipe(); });
copyBtn.addEventListener('click', copyUnchecked);
clearBtn.addEventListener('click', clearAll);

// ── Init ──────────────────────────────────────────────────────────────────────
loadState();
render();
