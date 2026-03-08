const STORAGE_KEY = 'supermarket_list';

// ── State ─────────────────────────────────────────────────────────────────────
// state.recipes = [{ title, url, ingredients: [{ text, checked }] }]
let state = { recipes: [] };

// ── DOM refs ──────────────────────────────────────────────────────────────────
const urlInput       = document.getElementById('recipe-url');
const fetchBtn       = document.getElementById('fetch-btn');
const loadingEl      = document.getElementById('loading');
const errorEl        = document.getElementById('error-msg');
const listSection    = document.getElementById('list-section');
const recipesContainer = document.getElementById('recipes-container');
const copyBtn        = document.getElementById('copy-btn');
const clearBtn       = document.getElementById('clear-btn');

// ── Persistence ───────────────────────────────────────────────────────────────
function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) state = JSON.parse(raw);
  } catch {
    state = { recipes: [] };
  }
}

// ── Render ────────────────────────────────────────────────────────────────────
function render() {
  recipesContainer.innerHTML = '';

  if (state.recipes.length === 0) {
    listSection.classList.add('hidden');
    return;
  }

  listSection.classList.remove('hidden');

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
  state = { recipes: [] };
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

// ── Event listeners ───────────────────────────────────────────────────────────
fetchBtn.addEventListener('click', fetchRecipe);
urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') fetchRecipe(); });
copyBtn.addEventListener('click', copyUnchecked);
clearBtn.addEventListener('click', clearAll);

// ── Init ──────────────────────────────────────────────────────────────────────
loadState();
render();
