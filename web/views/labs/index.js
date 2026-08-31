import { goBack, navigate } from '../../app.js';
import { renderRankRiver } from './rankRiver.js';

/**
 * Labs — experiments that are not part of the product yet.
 *
 * The whole area is reached through one lazily imported entry point, so core
 * carries a single route branch and downloads none of this unless someone asks
 * for it. Nothing in core imports anything under `views/labs/`; a test asserts
 * that, because the boundary is the reason an experiment is safe to keep.
 *
 * @param {HTMLElement} app
 * @param {string} sub  Path after `labs/`, empty for the index.
 */
export function renderLabs(app, sub) {
  if (sub === 'rank-river') return renderRankRiver(app);
  return renderIndex(app);
}

const EXPERIMENTS = [
  {
    route: 'labs/rank-river',
    name: 'Rank River',
    blurb: 'Where the current top 20 have been over the last 30 sessions.',
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
    open.addEventListener('click', (e) => { e.preventDefault(); navigate(x.route); });
    open.innerHTML = `<div class="rank"></div>
      <div class="ident"><div class="sym">${x.name}</div><div class="nm">${x.blurb}</div></div>`;
    item.append(open);
    rows.append(item);
  }
  body.append(rows);
  app.append(body);
}
