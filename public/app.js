const STORAGE_KEY = 'supermarket_list';
const SAVED_KEY = 'supermarket_saved';
const PANTRY_KEY = 'supermarket_pantry';

// ── State ─────────────────────────────────────────────────────────────────────
// state.recipes = [{ title, url, ingredients: [{ text, checked }] }]
let state = { recipes: [], viewMode: 'recipe', showSources: true };
// savedRecipes = [{ id, title, url, ingredients: [string] }]
let savedRecipes = [];
// pantryIngredients = [string] — ingredients the user has at home
let pantryIngredients = [];
// cached web search results; cleared whenever pantry changes
let webSearchResults = [];
// fallback context from last web search (null if no fallback occurred)
let lastFellBackFrom = null;
// selected meal category filter for web search — session-only, not persisted
// NOTE: must be a subset of ALLOWED_CATEGORIES in server.py
let selectedCategory = 'Any';
const MEAL_CATEGORIES = ['Any', 'Breakfast', 'Chicken', 'Beef', 'Pasta', 'Seafood', 'Vegetarian', 'Vegan', 'Dessert'];

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
const libraryList       = document.getElementById('library-list');
const libraryEmpty      = document.getElementById('library-empty');
const pantryInput       = document.getElementById('pantry-input');
const pantryAddBtn      = document.getElementById('pantry-add-btn');
const pantryChips       = document.getElementById('pantry-chips');
const cookResults       = document.getElementById('cook-results');

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
    if (state.activeScreen && ['home', 'list', 'library', 'cook'].includes(state.activeScreen)) {
      currentScreen = state.activeScreen;
    }
  } catch {
    state = { recipes: [], viewMode: 'recipe', showSources: true };
  }
}

function loadSaved() {
  try {
    const raw = localStorage.getItem(SAVED_KEY);
    if (raw) savedRecipes = JSON.parse(raw);
    if (!Array.isArray(savedRecipes)) savedRecipes = [];
    savedRecipes = savedRecipes.filter(r =>
      r && typeof r.id === 'string' && typeof r.url === 'string' && Array.isArray(r.ingredients)
    );
  } catch {
    savedRecipes = [];
  }
}

function saveSavedRecipes() {
  localStorage.setItem(SAVED_KEY, JSON.stringify(savedRecipes));
}

function loadPantry() {
  try {
    const raw = localStorage.getItem(PANTRY_KEY);
    if (raw) pantryIngredients = JSON.parse(raw);
    if (!Array.isArray(pantryIngredients)) pantryIngredients = [];
    pantryIngredients = pantryIngredients.filter(s => typeof s === 'string' && s.trim());
  } catch { pantryIngredients = []; }
}

function savePantry() {
  localStorage.setItem(PANTRY_KEY, JSON.stringify(pantryIngredients));
}

// ── Library ingredient popover ────────────────────────────────────────────────
const libraryPopover     = document.getElementById('library-popover');
const libraryPopoverList = libraryPopover.querySelector('.library-popover__list');
let   activeToggleBtn    = null;

function openPopover(btn, ingredients) {
  libraryPopoverList.innerHTML = '';
  ingredients.filter(text => !isWater(text)).forEach(text => {
    const li = document.createElement('li');

    const { main, note } = splitIngredient(text);
    const grams = extractGrams(text);
    const rawMain = main || note || text;
    const mainText = grams !== null ? stripInlineGrams(rawMain) : rawMain;

    li.textContent = mainText;

    if (grams !== null) {
      const gramNote = document.createElement('span');
      gramNote.className = 'gram-note';
      gramNote.textContent = ` (${+grams.toFixed(1)}g)`;
      li.appendChild(gramNote);
    }

    if (isRelevantNote(note)) {
      const noteEl = document.createElement('div');
      noteEl.className = 'ingredient-note';
      noteEl.textContent = note;
      li.appendChild(noteEl);
    }

    libraryPopoverList.appendChild(li);
  });

  libraryPopover.classList.remove('hidden');

  const rect = btn.getBoundingClientRect();
  let top  = rect.bottom + 6;
  let left = rect.left;

  // Flip left if popover would overflow right edge
  const popoverWidth = libraryPopover.offsetWidth;
  if (left + popoverWidth > window.innerWidth - 16) {
    left = rect.right - popoverWidth;
  }

  libraryPopover.style.top  = `${top}px`;
  libraryPopover.style.left = `${left}px`;

  activeToggleBtn = btn;
  btn.classList.add('open');
  btn.setAttribute('aria-expanded', 'true');
}

function closePopover() {
  if (!activeToggleBtn) return;
  libraryPopover.classList.add('hidden');
  activeToggleBtn.classList.remove('open');
  activeToggleBtn.setAttribute('aria-expanded', 'false');
  activeToggleBtn.focus();
  activeToggleBtn = null;
}

document.addEventListener('click', e => {
  if (activeToggleBtn && !libraryPopover.contains(e.target) && e.target !== activeToggleBtn) {
    closePopover();
  }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closePopover(); });
window.addEventListener('scroll', closePopover, { passive: true });

// ── Saved recipes library ─────────────────────────────────────────────────────
function isSavedUrl(url) {
  if (!url) return false;
  return savedRecipes.some(r => r.url === url);
}

function isActiveUrl(url) {
  if (!url) return false;
  return state.recipes.some(r => r.url === url);
}

function saveRecipe(recipeIdx) {
  const recipe = state.recipes[recipeIdx];
  if (isSavedUrl(recipe.url)) return;
  savedRecipes.push({
    id: crypto.randomUUID(),
    title: recipe.title,
    url: recipe.url,
    ingredients: recipe.ingredients.map(ing => ing.text),
  });
  saveSavedRecipes();
  renderLibrary();
  render(); // refresh save button state
}

function addSavedToList(id) {
  const saved = savedRecipes.find(r => r.id === id);
  if (!saved) return;
  if (isActiveUrl(saved.url)) return;
  state.recipes.push({
    title: saved.title,
    url: saved.url,
    ingredients: saved.ingredients.map(text => ({ text, checked: false })),
  });
  saveState();
  if (currentScreen === 'cook') {
    renderCookScreen(); // refresh button state without navigating away
  } else {
    renderLibrary(); // refresh "Add to list" disabled state
    navigate('list'); // navigate calls render()
  }
}

function deleteSaved(id) {
  savedRecipes = savedRecipes.filter(r => r.id !== id);
  saveSavedRecipes();
  renderLibrary();
  render(); // refresh save button state
}

function renderLibrary() {
  closePopover();
  if (savedRecipes.length === 0) {
    libraryEmpty.classList.remove('hidden');
    libraryList.innerHTML = '';
    return;
  }

  libraryEmpty.classList.add('hidden');
  libraryList.innerHTML = '';

  savedRecipes.forEach(saved => {
    const li = document.createElement('li');
    li.className = 'library-card';

    const titleLink = document.createElement('a');
    titleLink.className = 'library-card__title';
    titleLink.textContent = saved.title;
    titleLink.href = saved.url;
    titleLink.target = '_blank';
    titleLink.rel = 'noopener noreferrer';

    const meta = document.createElement('div');
    meta.className = 'library-card__meta';

    const visibleIngredients = saved.ingredients.filter(text => !isWater(text));
    if (visibleIngredients.length === 0) {
      const noIng = document.createElement('span');
      noIng.className = 'library-card__meta-count';
      noIng.textContent = 'No ingredients';
      meta.appendChild(noIng);
    } else {
      const metaToggle = document.createElement('button');
      metaToggle.className = 'library-card__meta-toggle';
      metaToggle.textContent = `${visibleIngredients.length} ingredient${visibleIngredients.length !== 1 ? 's' : ''}`;
      metaToggle.setAttribute('aria-expanded', 'false');
      metaToggle.setAttribute('aria-controls', 'library-popover');
      meta.appendChild(metaToggle);

      metaToggle.addEventListener('click', e => {
        e.stopPropagation();
        if (activeToggleBtn === metaToggle) {
          closePopover();
        } else {
          closePopover();
          openPopover(metaToggle, visibleIngredients);
        }
      });
    }

    const actions = document.createElement('div');
    actions.className = 'library-card__actions';

    const addBtn = document.createElement('button');
    addBtn.className = 'btn-secondary btn-save-add';
    addBtn.textContent = 'Add to list';
    const alreadyActive = isActiveUrl(saved.url);
    addBtn.disabled = alreadyActive;
    addBtn.title = alreadyActive ? 'Already in your list' : 'Add to shopping list';
    addBtn.addEventListener('click', () => addSavedToList(saved.id));

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'remove-recipe-btn';
    deleteBtn.textContent = '✕';
    deleteBtn.title = 'Remove from saved';
    deleteBtn.addEventListener('click', () => deleteSaved(saved.id));

    actions.appendChild(addBtn);
    actions.appendChild(deleteBtn);
    li.appendChild(titleLink);
    li.appendChild(meta);
    li.appendChild(actions);
    libraryList.appendChild(li);
  });
}

// ── What Can I Cook? ──────────────────────────────────────────────────────────
function matchRecipes() {
  const pantryNorms = pantryIngredients.map(p => normalizeIngredient(p));
  return savedRecipes
    .map(recipe => {
      const realIngredients = recipe.ingredients.filter(text => !isWater(text));
      const total = realIngredients.length;
      if (total === 0) return null;
      const missing = [];
      let matched = 0;
      realIngredients.forEach(ingText => {
        const ingNorm = normalizeIngredient(ingText);
        const covered = pantryNorms.some(pNorm => {
          if (pNorm === ingNorm) return true;
          // word-boundary check: pantry term appears as whole word(s) in recipe ingredient
          const escaped = pNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          return new RegExp('(?:^|\\s)' + escaped + '(?:\\s|$)').test(ingNorm);
        });
        if (covered) matched++;
        else missing.push(ingText);
      });
      return { recipe, matched, total, ratio: matched / total, missing };
    })
    .filter(r => r !== null && r.matched > 0)
    .sort((a, b) => b.ratio - a.ratio || a.missing.length - b.missing.length);
}

function addPantryItem() {
  const text = pantryInput.value.trim();
  if (!text) return;
  const norm = normalizeIngredient(text);
  if (pantryIngredients.some(p => normalizeIngredient(p) === norm)) {
    pantryInput.value = '';
    return;
  }
  pantryIngredients.push(text);
  savePantry();
  pantryInput.value = '';
  webSearchResults = [];
  lastFellBackFrom = null;
  selectedCategory = 'Any';
  renderCookScreen();
}

function removePantryItem(index) {
  pantryIngredients.splice(index, 1);
  savePantry();
  webSearchResults = [];
  lastFellBackFrom = null;
  selectedCategory = 'Any';
  renderCookScreen();
}

function buildLibraryCookCard({ recipe, matched, total, ratio, missing }) {
  const isFull = ratio === 1;
  const li = document.createElement('li');
  li.className = 'cook-card' + (isFull ? ' cook-card--full' : '');

  const header = document.createElement('div');
  header.className = 'cook-card__header';
  const titleLink = document.createElement('a');
  titleLink.className = 'cook-card__title';
  titleLink.textContent = recipe.title;
  titleLink.href = recipe.url;
  titleLink.target = '_blank';
  titleLink.rel = 'noopener noreferrer';
  header.appendChild(titleLink);
  li.appendChild(header);

  const matchRow = document.createElement('div');
  matchRow.className = 'cook-card__match' + (isFull ? ' cook-card__match--full' : '');
  const matchText = document.createElement('span');
  matchText.textContent = isFull ? `All ${total} ingredients ✓` : `${matched} / ${total} ingredients`;
  matchRow.appendChild(matchText);
  const barTrack = document.createElement('div');
  barTrack.className = 'cook-card__bar-track';
  const barFill = document.createElement('div');
  barFill.className = 'cook-card__bar-fill';
  barFill.style.width = `${Math.round(ratio * 100)}%`;
  barTrack.appendChild(barFill);
  matchRow.appendChild(barTrack);
  li.appendChild(matchRow);

  if (!isFull && missing.length > 0) {
    const missingLabel = document.createElement('div');
    missingLabel.className = 'cook-card__missing-label';
    missingLabel.textContent = 'Still need:';
    const missingList = document.createElement('ul');
    missingList.className = 'cook-card__missing-list';
    missing.forEach(ingText => {
      const missingLi = document.createElement('li');
      missingLi.textContent = ingText;
      missingList.appendChild(missingLi);
    });
    li.appendChild(missingLabel);
    li.appendChild(missingList);
  }

  const actions = document.createElement('div');
  actions.className = 'cook-card__actions';
  const addBtn = document.createElement('button');
  addBtn.className = 'btn-secondary btn-save-add';
  addBtn.textContent = 'Add to list';
  const alreadyActive = isActiveUrl(recipe.url);
  addBtn.disabled = alreadyActive;
  addBtn.title = alreadyActive ? 'Already in your list' : 'Add to shopping list';
  addBtn.addEventListener('click', () => addSavedToList(recipe.id));
  actions.appendChild(addBtn);
  li.appendChild(actions);

  return li;
}

function renderCookScreen() {
  // Render pantry chips
  pantryChips.innerHTML = '';
  pantryIngredients.forEach((item, i) => {
    const chip = document.createElement('span');
    chip.className = 'pantry-chip';
    chip.textContent = item;
    const removeBtn = document.createElement('button');
    removeBtn.className = 'pantry-chip__remove';
    removeBtn.textContent = '×';
    removeBtn.title = 'Remove';
    removeBtn.addEventListener('click', () => removePantryItem(i));
    chip.appendChild(removeBtn);
    pantryChips.appendChild(chip);
  });

  cookResults.innerHTML = '';

  if (pantryIngredients.length === 0) return;

  // ── Library section ──────────────────────────────────────────────────────
  const libHeader = document.createElement('div');
  libHeader.className = 'cook-section-header';
  libHeader.textContent = 'From your library';
  cookResults.appendChild(libHeader);

  const libSection = document.createElement('div');
  cookResults.appendChild(libSection);

  if (savedRecipes.length === 0) {
    libSection.innerHTML = `
      <div class="empty-state" style="padding: 24px 0;">
        <div class="empty-state__icon">📚</div>
        <p>No saved recipes yet.</p>
        <p class="text-muted">Save a recipe from the Shopping List screen first.</p>
      </div>`;
  } else {
    const results = matchRecipes();
    if (results.length === 0) {
      libSection.innerHTML = `
        <div class="empty-state" style="padding: 24px 0;">
          <div class="empty-state__icon">🤔</div>
          <p>No matches in your library.</p>
          <p class="text-muted">Try adding more pantry items or search the web below.</p>
        </div>`;
    } else {
      const ul = document.createElement('ul');
      ul.className = 'cook-results-list';
      results.forEach(r => ul.appendChild(buildLibraryCookCard(r)));
      libSection.appendChild(ul);
    }
  }

  // ── Web section ───────────────────────────────────────────────────────────
  const webHeader = document.createElement('div');
  webHeader.className = 'cook-section-header';
  webHeader.style.marginTop = '28px';
  webHeader.textContent = 'From the web';
  cookResults.appendChild(webHeader);

  // Category filter chips
  const catRow = document.createElement('div');
  catRow.className = 'category-filter-row';
  MEAL_CATEGORIES.forEach(cat => {
    const btn = document.createElement('button');
    btn.className = 'category-chip' + (cat === selectedCategory ? ' category-chip--active' : '');
    btn.textContent = cat;
    btn.addEventListener('click', () => {
      if (cat === selectedCategory) return;
      selectedCategory = cat;
      webSearchResults = [];
      lastFellBackFrom = null;
      renderCookScreen();
    });
    catRow.appendChild(btn);
  });
  cookResults.appendChild(catRow);

  const webControls = document.createElement('div');
  webControls.className = 'cook-web-controls';
  const searchBtn = document.createElement('button');
  searchBtn.id = 'web-search-btn';
  searchBtn.className = 'btn-secondary';
  searchBtn.textContent = 'Search Web';
  searchBtn.addEventListener('click', searchWebRecipes);
  webControls.appendChild(searchBtn);
  cookResults.appendChild(webControls);

  const webResultsDiv = document.createElement('div');
  webResultsDiv.id = 'web-results';
  cookResults.appendChild(webResultsDiv);

  // Restore cached results if pantry hasn't changed since last search
  if (webSearchResults.length > 0) {
    renderWebResults(webSearchResults, lastFellBackFrom);
  }
}

async function searchWebRecipes() {
  const searchBtn = document.getElementById('web-search-btn');
  const webResultsDiv = document.getElementById('web-results');
  if (!searchBtn || !webResultsDiv) return;

  searchBtn.disabled = true;
  searchBtn.textContent = 'Searching...';
  webResultsDiv.innerHTML = '<p class="text-muted" style="padding: 12px 0;">Looking up recipes on the web\u2026</p>';

  try {
    const query = pantryIngredients.slice(0, 5).join(',');
    const categoryParam = selectedCategory !== 'Any' ? `&category=${encodeURIComponent(selectedCategory)}` : '';
    const res = await fetch(`/api/search-by-ingredients?ingredients=${encodeURIComponent(query)}${categoryParam}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Server error');
    webSearchResults = data.results || [];
    lastFellBackFrom = data.fellBack ? data.category : null;
    renderWebResults(webSearchResults, lastFellBackFrom);
  } catch (err) {
    // Re-query DOM: the cook screen may have been re-rendered while awaiting
    const div = document.getElementById('web-results');
    if (div) {
      const errP = document.createElement('p');
      errP.className = 'cook-web-error';
      errP.textContent = err.message || 'Could not reach the web search service. Check your connection or try again.';
      div.innerHTML = '';
      div.appendChild(errP);
    }
  } finally {
    const btn = document.getElementById('web-search-btn');
    if (btn) { btn.disabled = false; btn.textContent = 'Search Web'; }
  }
}

function renderWebResults(results, fellBackFrom = null) {
  const webResultsDiv = document.getElementById('web-results');
  if (!webResultsDiv) return;
  webResultsDiv.innerHTML = '';

  if (fellBackFrom) {
    const note = document.createElement('p');
    note.className = 'cook-fallback-note';
    note.textContent = `No "${fellBackFrom}" recipes matched your pantry — showing all ingredient matches instead.`;
    webResultsDiv.appendChild(note);
  }

  if (results.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'text-muted';
    empty.style.padding = '12px 0';
    empty.textContent = 'No web recipes found for your pantry ingredients.';
    webResultsDiv.appendChild(empty);
    return;
  }

  if (selectedCategory !== 'Any' && !fellBackFrom) {
    const filterLabel = document.createElement('p');
    filterLabel.className = 'cook-filter-label';
    filterLabel.textContent = `Filtered to: ${selectedCategory}`;
    webResultsDiv.appendChild(filterLabel);
  }

  const ul = document.createElement('ul');
  ul.className = 'cook-results-list';

  results.forEach(result => {
    const li = document.createElement('li');
    li.className = 'cook-card';

    const header = document.createElement('div');
    header.className = 'cook-card__header';

    const titleLink = document.createElement('a');
    titleLink.className = 'cook-card__title';
    titleLink.textContent = result.title;
    if (/^https?:\/\//i.test(result.sourceUrl)) titleLink.href = result.sourceUrl;
    titleLink.target = '_blank';
    titleLink.rel = 'noopener noreferrer';
    header.appendChild(titleLink);

    if (result.thumbnail) {
      const thumb = document.createElement('img');
      thumb.className = 'cook-card__thumb';
      thumb.src = result.thumbnail;
      thumb.alt = '';
      thumb.loading = 'lazy';
      header.appendChild(thumb);
    }

    li.appendChild(header);

    const matchRow = document.createElement('div');
    matchRow.className = 'cook-card__match';
    const matchSpan = document.createElement('span');
    matchSpan.textContent = `${result.matchCount} of your ingredients matched · ${result.ingredients.length} ingredients total`;
    matchRow.appendChild(matchSpan);
    li.appendChild(matchRow);

    const actions = document.createElement('div');
    actions.className = 'cook-card__actions';
    const addBtn = document.createElement('button');
    addBtn.className = 'btn-secondary btn-save-add';
    const alreadyActive = state.recipes.some(r => r.url === result.sourceUrl);
    addBtn.disabled = alreadyActive;
    addBtn.title = alreadyActive ? 'Already in your list' : 'Add to shopping list';
    addBtn.textContent = 'Add to list';
    addBtn.addEventListener('click', () => {
      if (state.recipes.some(r => r.url === result.sourceUrl)) return;
      state.recipes.push({
        title: result.title,
        url: result.sourceUrl,
        ingredients: result.ingredients.map(text => ({ text, checked: false })),
      });
      saveState();
      addBtn.disabled = true;
      addBtn.title = 'Already in your list';
      navigate('list');
    });
    actions.appendChild(addBtn);
    li.appendChild(actions);

    ul.appendChild(li);
  });

  webResultsDiv.appendChild(ul);
}

// ── Screen router ─────────────────────────────────────────────────────────────
let currentScreen = 'home';

function navigate(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('screen--active'));
  document.querySelectorAll('.topnav__link').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.nav === id);
  });
  document.getElementById('screen-' + id).classList.add('screen--active');
  currentScreen = id;
  state.activeScreen = id;
  saveState();
  if (id === 'library') renderLibrary();
  if (id === 'list') render();
  if (id === 'cook') renderCookScreen();
  window.scrollTo(0, 0);
}

document.addEventListener('click', e => {
  const target = e.target.closest('[data-nav]');
  if (target) navigate(target.dataset.nav);
});

// ── Ingredient text splitting ─────────────────────────────────────────────────
// Splits "2 cups flour, sifted" → { main: "2 cups flour", note: "sifted" }
// Also handles trailing parens: "1 head lettuce (, chopped)" → { main: "1 head lettuce", note: "chopped" }
function splitIngredient(text) {
  const t = text.trim();

  // Entire text is a parenthetical "(, note text)" — orphaned note fragment
  const noteOnly = t.match(/^\(\s*,?\s*(.+?)\s*\)$/);
  if (noteOnly) return { main: null, note: noteOnly[1] };

  // Find first top-level comma (not inside parentheses)
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === ',' && depth === 0) {
      const main = t.slice(0, i).trim();
      let note = t.slice(i + 1).trim();
      // Unwrap "(note)" → "note"
      if (note.startsWith('(') && note.endsWith(')')) note = note.slice(1, -1).trim();
      // Strip a leading comma "(, note)" that survived unwrapping
      note = note.replace(/^,\s*/, '').trim();
      return { main: main || null, note: note || null };
    }
  }

  // No top-level comma — check for a trailing parenthetical at the end
  if (t.endsWith(')')) {
    let d = 0;
    for (let i = t.length - 1; i >= 0; i--) {
      if (t[i] === ')') d++;
      else if (t[i] === '(') {
        d = Math.max(0, d - 1);
        if (d === 0) {
          const main = t.slice(0, i).trim();
          let note = t.slice(i + 1, t.length - 1).trim();
          note = note.replace(/^,\s*/, '').trim();
          if (main && note) return { main, note };
          break;
        }
      }
    }
  }

  return { main: t, note: null };
}

// Returns true for substitution/alternative notes worth showing in the shopping list.
// e.g. "or buttermilk" yes, "chopped" no, "sifted" no.
function isRelevantNote(note) {
  if (!note) return false;
  return /^(or\b|such as\b|like\b|e\.?g\.?\b|preferably\b|ideally\b|alternatively\b)/i.test(note.trim());
}

// Removes inline metric amounts like "( 240 g )" or "(1.5kg)" from display text
// when a gram badge is already shown separately.
function stripInlineGrams(text) {
  return text
    .replace(/\(\s*\d+(?:[.,]\d+)?\s*(?:kg|kilograms?|grams?|g(?!\w))\s*\)/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ── Gram extraction ───────────────────────────────────────────────────────────
// Returns gram amount as a number, or null if not specified in grams/kg.
function extractGrams(text) {
  // Match patterns like: 200g, 200 g, 200grams, 0.5kg, 500 grams, 1.5 kg
  const match = text.match(/(\d+(?:[.,]\d+)?)\s*(kg|kilograms?|grams?|g(?!\w))/i);
  if (!match) return null;
  let amount = parseFloat(match[1].replace(',', '.'));
  const unit = match[2].toLowerCase();
  if (unit.startsWith('k')) amount = amount * 1000; // kg → g
  return amount;
}

// Returns true if an ingredient text is just water (should be hidden from shopping list)
const WATER_RE = /^[\d\s/½¼¾⅓⅔.–\-]*(?:cups?|tbsp\.?|tablespoons?|tsp\.?|teaspoons?|oz\.?|lbs?\.?|ml|l\b|liters?|litres?|g\b|kg\b)?\s*(?:boiling|hot|warm|cold|lukewarm|filtered|tap|distilled|sparkling|plain|room[\s-]temperature)?\s*water\s*$/i;

function isWater(text) {
  // Strip asterisks, trailing comma-notes, and all parentheticals (including nested like ((474g)))
  let cleaned = text.trim().replace(/[*†‡#]+/g, '').replace(/,.*$/, '').trim();
  let prev;
  do { prev = cleaned; cleaned = cleaned.replace(/\([^()]*\)/g, '').trim(); } while (cleaned !== prev);
  return WATER_RE.test(cleaned);
}

// ── Ingredient grouping ───────────────────────────────────────────────────────
function normalizeIngredient(text) {
  let s = text.toLowerCase().trim();
  // Remove decorative prefix characters used by some recipe sites (checkbox squares, bullets)
  s = s.replace(/^[\u25a0-\u25ff\u2610-\u2612\u2022\u2023\u2043\u204c\u204d]+\s*/, '');
  // Remove unicode fractions
  s = s.replace(/[½⅓⅔¼¾⅛⅜⅝⅞]/g, '');
  // Remove leading numbers (integers, decimals, fractions like 1/2, and Unicode dashes for ranges like 2–3)
  s = s.replace(/^[\d\s/.\-\u2012-\u2015\u2212]+/, '');
  // Remove common units (try multiple passes for compound cases like "2 large cups")
  const units = /^(cups?|tbsp\.?|tsp\.?|tablespoons?|teaspoons?|fl\.?\s*oz\.?|oz\.?|lbs?\.?|pounds?|ounces?|grams?|kg|ml|liters?|litres?|\bl\b|pinch(es)?|handfuls?|bunch(es)?|cans?|cloves?|slices?|pieces?|large|medium|small|heaping|heaped|fresh|dried|whole|boneless|skinless)\s+/i;
  for (let i = 0; i < 4; i++) s = s.replace(units, '');
  // Remove parenthetical notes like (optional), (about 200g).
  // Loop until stable so that nested parens like "(see note (a))" are fully removed.
  let prev;
  do { prev = s; s = s.replace(/\s*\([^()]*\)\s*/g, ' '); } while (s !== prev);
  // Strip any orphaned parens left over from malformed nesting.
  s = s.replace(/[()]/g, ' ');
  // Strip everything after the first comma (preparation notes like "cut into florets", "slightly warmed", "divided")
  s = s.replace(/,.*$/, '');
  // Normalize hyphens to spaces so "extra-virgin" and "extra virgin" group together
  s = s.replace(/-/g, ' ');
  // Normalize whitespace and trailing punctuation
  s = s.replace(/\s+/g, ' ').trim().replace(/[;]+$/, '').trim();
  // Normalize all salt variants (kosher, sea, flaky, pink himalayan, etc.) to 'salt'
  if (/\bsalt$/.test(s)) s = 'salt';
  return s || text.toLowerCase().trim();
}

function groupIngredients() {
  const groups = {};
  state.recipes.forEach((recipe, ri) => {
    recipe.ingredients.forEach((ing, ii) => {
      if (isWater(ing.text)) return;
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
  // Render My Items last so recipe groups dominate the visual hierarchy
  const sorted = [
    ...state.recipes.map((r, i) => ({ r, i })).filter(({ r }) => r.url !== null),
    ...state.recipes.map((r, i) => ({ r, i })).filter(({ r }) => r.url === null),
  ];
  sorted.forEach(({ r: recipe, i: recipeIdx }) => {
    const group = document.createElement('div');
    group.className = 'recipe-group';

    // Recipe heading
    const titleRow = document.createElement('div');
    titleRow.className = 'recipe-title';

    if (recipe.url) {
      const titleLink = document.createElement('a');
      titleLink.href = recipe.url;
      titleLink.target = '_blank';
      titleLink.rel = 'noopener noreferrer';
      titleLink.textContent = recipe.title || '(untitled recipe)';
      titleLink.className = 'recipe-title-link';
      titleRow.appendChild(titleLink);
    } else {
      const titleText = document.createElement('span');
      titleText.textContent = recipe.title || '(untitled recipe)';
      titleRow.appendChild(titleText);
    }

    const rightSide = document.createElement('span');
    rightSide.style.display = 'flex';
    rightSide.style.alignItems = 'center';
    rightSide.style.gap = '10px';

    if (recipe.url) {
      const saveBtn = document.createElement('button');
      saveBtn.className = 'save-recipe-btn';
      const alreadySaved = isSavedUrl(recipe.url);
      saveBtn.textContent = alreadySaved ? 'saved ✓' : 'save';
      saveBtn.disabled = alreadySaved;
      saveBtn.title = alreadySaved ? 'Already in your saved library' : 'Save recipe for reuse later';
      if (!alreadySaved) saveBtn.addEventListener('click', () => saveRecipe(recipeIdx));
      rightSide.appendChild(saveBtn);
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
      if (isWater(ing.text)) return;
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

      const { main, note } = splitIngredient(ing.text);
      const grams = extractGrams(ing.text);

      const textBlock = document.createElement('div');
      textBlock.className = 'ingredient-text-block';

      const mainRow = document.createElement('div');
      mainRow.className = 'ingredient-main-row';

      const mainSpan = document.createElement('span');
      mainSpan.className = 'ingredient-main';
      const rawMain = main || note || ing.text;
      mainSpan.textContent = grams !== null ? stripInlineGrams(rawMain) : rawMain;
      mainRow.appendChild(mainSpan);

      if (grams !== null) {
        const gramNote = document.createElement('span');
        gramNote.className = 'gram-note';
        gramNote.textContent = `(${+grams.toFixed(1)}g)`;
        mainRow.appendChild(gramNote);
      }
      textBlock.appendChild(mainRow);

      if (isRelevantNote(note)) {
        const noteEl = document.createElement('div');
        noteEl.className = 'ingredient-note';
        noteEl.textContent = note;
        textBlock.appendChild(noteEl);
      }

      label.appendChild(checkbox);
      label.appendChild(textBlock);
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

    const nameRow = document.createElement('div');
    nameRow.className = 'ingredient-name-row';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'ingredient-name';
    nameSpan.textContent = group.key;
    nameRow.appendChild(nameSpan);

    // Show gram badge only when ALL instances specify grams (avoids misleading partial totals)
    const allGrams = group.instances.map(inst => extractGrams(inst.text));
    if (allGrams.every(g => g !== null)) {
      const totalG = allGrams.reduce((sum, g) => sum + g, 0);
      const gramNote = document.createElement('span');
      gramNote.className = 'gram-note';
      gramNote.textContent = `(${+totalG.toFixed(1)}g)`;
      nameRow.appendChild(gramNote);
    }

    textWrapper.appendChild(nameRow);

    // Show relevant note (first one found across instances) below the name
    const relevantNote = group.instances.map(inst => splitIngredient(inst.text).note).find(isRelevantNote);
    if (relevantNote) {
      const noteEl = document.createElement('div');
      noteEl.className = 'ingredient-note';
      noteEl.textContent = relevantNote;
      textWrapper.appendChild(noteEl);
    }

    // Show original amounts/sources if there are multiple instances or the text has quantities
    const showAmounts = group.instances.length > 1 ||
      group.instances.some(inst => inst.text.toLowerCase().trim() !== group.key);

    if (showAmounts) {
      const amountsDiv = document.createElement('div');
      amountsDiv.className = 'ingredient-amounts';

      // Build pattern once for all instances; add s? only if key doesn't already end in s
      const keyPlural = group.key.endsWith('s') ? '' : 's?';
      const keyPattern = new RegExp('\\b' + group.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + keyPlural + '\\b', 'i');

      group.instances.forEach(inst => {
        const { main: instMain } = splitIngredient(inst.text);
        const instGrams = extractGrams(inst.text);
        const rawInstMain = instMain || inst.text;
        // Strip the ingredient name from the amount to avoid repeating it (e.g. "1 avocado" → "1")
        const stripped = rawInstMain.replace(keyPattern, '')
          .replace(/\s+(of|and|or)$/i, '').replace(/^(a|an|the|of|some)\s+/i, '')
          .trim().replace(/\s+/g, ' ');
        const displayMain = stripped || rawInstMain;
        const row = document.createElement('div');
        row.className = 'ingredient-amount-row';
        const amountText = document.createTextNode(instGrams !== null ? stripInlineGrams(displayMain) : displayMain);
        row.appendChild(amountText);
        if (state.showSources) {
          const tag = document.createElement('span');
          tag.className = 'recipe-source-pill';
          tag.textContent = ' \u2014 ' + state.recipes[inst.recipeIdx].title;
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
    if (!Array.isArray(data.ingredients) || data.ingredients.length === 0) {
      showError('No ingredients found on this page.');
      return;
    }
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

// ── Manual ingredient add ─────────────────────────────────────────────────────
const MY_ITEMS_TITLE = 'My Items';

function addManualItem() {
  const ingredientInput = document.getElementById('ingredient-input');
  const text = ingredientInput.value.trim();
  if (!text) return;

  // Find or create the "My Items" group (always last in the recipes array)
  let myItems = state.recipes.find(r => r.url === null && r.title === MY_ITEMS_TITLE);
  if (!myItems) {
    myItems = { title: MY_ITEMS_TITLE, url: null, ingredients: [] };
    state.recipes.push(myItems);
  }

  myItems.ingredients.push({ text, checked: false });
  saveState();
  render();
  ingredientInput.value = '';
  ingredientInput.focus();
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
      const unchecked = recipe.ingredients.filter(i => !i.checked && !isWater(i.text));
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
  state = { recipes: [], viewMode: state.viewMode, showSources: state.showSources, activeScreen: state.activeScreen };
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
document.getElementById('add-ingredient-btn').addEventListener('click', addManualItem);
document.getElementById('ingredient-input').addEventListener('keydown', e => { if (e.key === 'Enter') addManualItem(); });
copyBtn.addEventListener('click', copyUnchecked);
clearBtn.addEventListener('click', clearAll);
pantryAddBtn.addEventListener('click', addPantryItem);
pantryInput.addEventListener('keydown', e => { if (e.key === 'Enter') addPantryItem(); });

// ── Init ──────────────────────────────────────────────────────────────────────
loadState();
loadSaved();
loadPantry();
navigate(currentScreen);
