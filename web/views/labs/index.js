import { goBack, navigate } from '../../app.js';

/**
 * Labs — experiments that are not part of the product yet.
 *
 * The whole area is reached through one lazily imported entry point, so core
 * carries a single route branch and downloads none of this unless someone asks
 * for it. Nothing in core imports anything under `views/labs/`; a test asserts
 * that, because the boundary is the reason an experiment is safe to keep.
 *
 * Each experiment is imported lazily too, and for the same reason one step
 * down: they are independent of each other, so opening one must not download
 * the next. This menu is the only file that knows both of them exist, and
 * removing an experiment is removing its entry and its files.
 *
 * @param {HTMLElement} app
 * @param {string} sub  Path after `labs/`, empty for the index.
 */
export function renderLabs(app, sub) {
  const experiment = EXPERIMENTS.find((x) => x.slug === sub);
  return experiment ? experiment.open(app) : renderIndex(app);
}

const EXPERIMENTS = [
  {
    slug: 'rank-river',
    name: 'Rank River',
    blurb: 'Where the current top 20 have been over the last 30 sessions.',
    open: (app) => import('./rankRiver.js').then((m) => m.renderRankRiver(app)),
  },
  {
    slug: 'etf-river',
    name: 'ETF River',
    blurb: 'A year of industry rotation across ~20 sector and theme ETFs.',
    open: (app) => import('./etfRiver.js').then((m) => m.renderEtfRiver(app)),
  },
];

function renderIndex(app) {
  app.replaceChildren();
  document.body.classList.remove('has-bar');

  const head = document.createElement('header');
  head.className = 'head';
  const back = document.createElement('a');
  back.className = 'back';
  back.href = '#';
  back.textContent = '‹ Back to list';
  back.addEventListener('click', (e) => { e.preventDefault(); goBack(); });
  head.append(back);
  head.insertAdjacentHTML('beforeend', '<h1>Labs</h1>');
  app.append(head);

  const body = document.createElement('div');
  body.className = 'lab';
  body.insertAdjacentHTML('beforeend',
    `<p class="lab-note">Experiments. They may change or disappear, and nothing on the
     ranked list, the ticker screen or the watchlist depends on anything here.</p>`);

  const rows = document.createElement('div');
  rows.className = 'rows';
  for (const x of EXPERIMENTS) {
    const item = document.createElement('div');
    item.className = 'stock';
    const open = document.createElement('a');
    open.className = 'open';
    open.href = '#';
    open.addEventListener('click', (e) => { e.preventDefault(); navigate(`labs/${x.slug}`); });
    open.innerHTML = `<div class="rank"></div>
      <div class="ident"><div class="sym">${x.name}</div><div class="nm">${x.blurb}</div></div>`;
    item.append(open);
    rows.append(item);
  }
  body.append(rows);
  app.append(body);
}
