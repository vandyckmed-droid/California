import { spectrogram, territories, telescope, broadsheet, river } from './prototypes.js';

const stage = document.getElementById('stage');
const tabsEl = document.getElementById('tabs');
const get = (p) => fetch(p).then((r) => r.json());

const BLURB = {
  spectro: `<b>Every name, every session, as one image.</b> 2,572 rows, 126 columns, brightness is
    what that name did that day, standardised by its own volatility. Left is the whole universe;
    the right panel is 44 rows at full resolution, following the lens.
    <b>Switch to "as traded" and the picture collapses into vertical stripes</b> — the market
    moving every name at once, drowning everything else. Removing each session's cross-sectional
    mean leaves only what a name did differently, which is the only part correlation grouping was
    ever about, and the groups appear as bands of identical texture.
    <span class="q">Correlation stops being a matrix you decode and becomes a texture you recognise.</span>`,
  terr: `<b>The market as land instead of as a list.</b> Every correlation group is a territory
    whose area is its member count, hue its dominant sector, and brightness how far forward it
    reaches. Territories that touch the top 100 are lit; the rest is dark ground.
    <span class="q">A list answers "what is best". A map answers "what is there" — including the
    large, crowded, unlit regions a top-100 list never mentions.</span>`,
  tele: `<b>One chart, three horizons, no tabs.</b> The x-axis is compressed in
    sessions-before-now, so recent weeks are stretched and last autumn squeezed. The windows are
    nested and stay nested — that is what they are — but the increments between them, and the
    <b>21 sessions the ranking deliberately throws away</b>, stop being slivers. The skip goes from
    8% of the frame to about 18%.
    <span class="q">The windows stop being a legend and become the geometry of the chart.</span>`,
  sheet: `<b>The top 100 as a page of type and nothing else.</b> Size is rank, weight is how much
    of a name's twelve-month standing survives into six months, and the superscript is how many
    names share its correlation group. No axes, no chart, no colour carrying meaning alone.
    <span class="q">A claim that a ranked list is an editorial object — a front page — rather than
    a table that happens to be sorted.</span>`,
  river: `<b>Where the leaders have been.</b> Twenty paths converging on today, with the two
    arrivals and two collapses drawn heavier. Invented data, on purpose — the question this
    answers is not what the market did, it is <b>whether a braid can carry an arrival story
    legibly</b>, and that is answerable from a drawing without owning the history first.
    <span class="q">Sketching on fiction is how you find out whether the storage would be worth
    buying.</span>`,
};

const NOTES = {
  spectro: [
    ['Real data', 'All 2,572 names, 126 sessions, from the correlation-grade returns the product already ships per symbol.'],
    ['Two passes', 'Standardising by each name\'s own sigma stops the picture being a volatility map. Subtracting the session\'s cross-sectional mean — a crude one-factor market model — is what makes groups visible at all. <b>The market factor averages 0.79% a day and swamps everything.</b>'],
    ['Overview and detail', 'The full universe at 620px gives every row a quarter of a pixel, so on its own it is texture and nothing more. The lens is not a nicety — without it the picture cannot be read at all.'],
    ['What it would need to ship', 'Nothing new — but it is a desktop-scale picture. The phone version is probably one selected name against its group, not the universe.'],
  ],
  terr: [
    ['Real data', 'All 360 groups at ρ ≥ 0.65 over the eligible universe, plus every solo name inside the top 400.'],
    ['The unlit majority', 'Most of the map is dark. 1,364 of 2,572 names are in no group at all, and the biggest territories — 28 gold miners, 21 regional banks — sit a thousand places back.'],
    ['Squarified', 'Compact rectangles rather than a strip layout, so areas stay comparable by eye instead of by width alone.'],
    ['Where it goes next', 'Selecting a watchlist should light your holdings on this map, which turns "what am I missing" into a spatial question with a visible answer.'],
  ],
  tele: [
    ['Real data', 'The same 253-session display series and the same anchors the product\'s own chart uses.'],
    ['Getting the exponent right', 'A true log axis was the first attempt and handed the skipped month <b>56%</b> of the frame — one distortion traded for a worse one. A 0.7 power gives it about 18% against linear time\'s 8%.'],
    ['Honest distortion', 'A compressed time axis is a strong claim — recent days are not more important, they are just more <b>resolvable</b>. The ticks are labelled in sessions so the distortion is legible rather than hidden.'],
    ['Where it goes next', 'Two names overlaid on the same log-time axis would make "why are these grouped" a picture instead of a number.'],
  ],
  sheet: [
    ['Real data', 'The top 100 on the blend, with their 12–1 and 6–1 ranks and group sizes.'],
    ['Two channels, no colour', 'Size and weight carry rank and survival. Nothing depends on hue, so it survives greyscale and a colour-blind reader without a fallback.'],
    ['What it is good at', 'Density. A hundred names, four dimensions, one screen, no scrolling — and the crowded groups announce themselves as repeated superscripts.'],
    ['What it is bad at', 'Precision. You cannot read a rank off it. It is a way of feeling the shape of a hundred names, not of looking one up.'],
  ],
  river: [
    ['Mock', 'Only the final session is real. The paths are a seeded mean-reverting walk in log-rank with four scripted stories — two arrivals, two collapses.'],
    ['What it would need', 'Rank history the pipeline does not keep. A rolling 60 sessions for names that touched the top 200 is about 70 KB raw.'],
    ['What the first attempt taught', 'A plain random walk produced something no ranking has looked like — every path slamming the #1 ceiling, a funnel at the right edge. Real ranks are <b>persistent</b>, and a sketch that ignores that answers the wrong question.'],
    ['Verdict from the sketch', 'The two arrivals are findable at a glance; the steady middle is decorative braid. It works at 20 names and would be mud at 100 — so if this is ever built it is a <b>top-20 object</b>, and the storage note should be costed for 20, not 200.'],
  ],
};

const TABS = [
  ['spectro', 'Spectrogram', async () => {
    const idx = await get('data/spectro-index.json');
    return (h) => spectrogram(h, idx, (p, o) => `data/spectro-${p}-${o}.png`);
  }],
  ['terr', 'Territories', async () => {
    const d = await get('data/territories.json');
    return (h) => territories(h, d);
  }],
  ['tele', 'Telescope', async () => {
    const d = await get('data/telescope.json');
    return (h) => telescope(h, d);
  }],
  ['sheet', 'Broadsheet', async () => {
    const d = await get('data/top100.json');
    return (h) => broadsheet(h, d);
  }],
  ['river', 'Rank river', async () => {
    const d = await get('data/mock-history.json');
    return (h) => river(h, d);
  }],
];

async function show(key) {
  const t = TABS.find((x) => x[0] === key) ?? TABS[0];
  tabsEl.querySelectorAll('button').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.k === t[0])));
  if (location.hash.replace('#', '') !== t[0]) location.hash = t[0];
  stage.replaceChildren(Object.assign(document.createElement('p'),
    { className: 'loading', textContent: 'Loading…' }));
  const build = await t[2]();
  stage.replaceChildren();
  const blurb = document.createElement('p');
  blurb.className = 'blurb';
  blurb.innerHTML = BLURB[t[0]];
  stage.append(blurb);
  build(stage);
  const dl = document.createElement('dl');
  dl.className = 'notes';
  for (const [k, v] of NOTES[t[0]]) {
    const d = document.createElement('div');
    d.innerHTML = `<dt>${k}</dt><dd>${v}</dd>`;
    dl.append(d);
  }
  stage.append(dl);
}

tabsEl.replaceChildren(...TABS.map(([k, label]) => {
  const b = document.createElement('button');
  b.type = 'button'; b.dataset.k = k; b.textContent = label;
  b.addEventListener('click', () => show(k));
  return b;
}));
show(location.hash.replace('#', '') || 'spectro');
addEventListener('hashchange', () => show(location.hash.replace('#', '') || 'spectro'));
