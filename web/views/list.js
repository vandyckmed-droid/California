import { SCORE_LABELS, displayValue, navigate, rerender, state, syncHash, viewKey } from '../app.js';

function segmented(options, current, onPick, small = false) {
  const wrap = document.createElement('div');
  wrap.className = small ? 'seg small' : 'seg';
  for (const [value, label] of options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.setAttribute('aria-pressed', String(value === current));
    b.addEventListener('click', () => {
      if (value === current) return;
      onPick(value);
      syncHash();
      rerender();
    });
    wrap.append(b);
  }
  return wrap;
}

function stockRow(snapshot, view, entry) {
  const meta = snapshot.symbols[entry.symbol] ?? {};
  const a = document.createElement('a');
  a.className = 'stock';
  a.href = '#';
  a.addEventListener('click', (e) => {
    e.preventDefault();
    navigate(entry.symbol);
  });

  const { text, sign } = displayValue(view, entry);
  a.innerHTML = `
    <div class="rank">${entry.rank}</div>
    <div class="ident">
      <div class="sym">${entry.symbol}</div>
      <div class="nm">${escapeHtml(meta.name ?? '')}</div>
    </div>
    <div class="val ${sign >= 0 ? 'pos' : 'neg'}">${text}</div>`;
  return a;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function renderList(app, snapshot) {
  const view = snapshot.views[viewKey()];
  const groups = view.groups[state.threshold] ?? [];
  const byRank = new Map(view.ranked.map((e) => [e.symbol, e]));
  const multi = groups.filter((g) => g.members.length > 1);
  const clustered = multi.reduce((n, g) => n + g.members.length, 0);
  const meta = snapshot.meta;

  app.replaceChildren();

  const head = document.createElement('header');
  head.className = 'head';
  head.innerHTML = `
    <h1>Momentum Screen <span class="as-of">${meta.asOf}</span></h1>
    <p class="sub">Top ${view.ranked.length} of ${meta.universe.eligible.toLocaleString()} eligible ·
      ${multi.length} group${multi.length === 1 ? '' : 's'} covering ${clustered} name${clustered === 1 ? '' : 's'}
      at &rho; &ge; ${state.threshold} over ${meta.params.corrWindow}d</p>`;

  const controls = document.createElement('div');
  controls.className = 'controls';
  controls.append(
    segmented(
      Object.entries(SCORE_LABELS),
      state.score,
      (v) => { state.score = v; },
    ),
  );

  const row = document.createElement('div');
  row.className = 'row2';
  row.append(
    segmented([['raw', 'Raw'], ['voladj', 'Vol-adjusted']], state.mode, (v) => { state.mode = v; }, true),
    // Read from the snapshot rather than a hardcoded copy, so changing
    // THRESHOLDS in config cannot leave the UI offering a value the data
    // does not carry.
    segmented(
      Object.keys(view.groups).sort().map((t) => [t, `ρ ${t}`]),
      state.threshold,
      (v) => { state.threshold = v; },
      true,
    ),
  );
  controls.append(row);

  if (state.mode === 'voladj') {
    const note = document.createElement('div');
    note.className = 'vol-note';
    note.textContent = `Return per unit of volatility, floored at ${(meta.params.volFloorAnnualized * 100).toFixed(1)}% annualized.`;
    controls.append(note);
  }
  head.append(controls);
  app.append(head);

  const cards = document.createElement('div');
  cards.className = 'cards';
  for (const group of groups) {
    const card = document.createElement('section');
    card.className = group.members.length > 1 ? 'card multi' : 'card';
    if (group.members.length > 1) {
      const h = document.createElement('div');
      h.className = 'card-head';
      h.innerHTML = `<span class="n">${group.members.length} names move together</span>
                     <span class="rho">&rho; &ge; ${group.minCorr.toFixed(2)}</span>`;
      card.append(h);
    }
    for (const symbol of group.members) {
      const entry = byRank.get(symbol);
      if (entry) card.append(stockRow(snapshot, view, entry));
    }
    cards.append(card);
  }
  app.append(cards);

  const foot = document.createElement('p');
  foot.className = 'foot';
  foot.innerHTML = `Ranked on ${SCORE_LABELS[view.scoreKey]}${view.mode === 'voladj' ? ', volatility-adjusted' : ''}
    from ${meta.universe.screened.toLocaleString()} screened listings.
    Grouping is complete-linkage, so every pair inside a card clears the threshold; it never changes the ranking.<br>
    Data: Financial Modeling Prep · <code>${meta.dataHash.slice(0, 16)}</code>`;
  app.append(foot);
}
