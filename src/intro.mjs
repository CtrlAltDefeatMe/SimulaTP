// The opening sequence. The four bars of the TH monogram tumble into place, the PlayTP name
// appears under them, and both shrink into the brand corner of the page waiting underneath.
const root = document.documentElement;
const overlay = document.querySelector('#intro');
const shell = document.querySelector('.app-shell');

// The monogram's place inside the square brand image, as shares of its side.
const GLYPH = { left: 248 / 1254, top: 343 / 1254, width: 759 / 1254 };
// The monogram is drawn 759 units wide.
const LOGO_UNITS = 759;
// Each bar: where it starts, as a share of the distance to the edge of the screen, the turn it
// starts with in degrees, and how long it waits in milliseconds.
const BARS = [
  { id: 't-stem', x: -.25, y: -1, turn: -150, delay: 0 },
  { id: 't-cap', x: -.7, y: -1, turn: 210, delay: 170 },
  { id: 'h-upright', x: .55, y: -1, turn: 160, delay: 340 },
  { id: 'h-crossbar', x: 1, y: -.45, turn: -250, delay: 510 },
];
const FALL_MS = 900;
const WORD_MS = 420;
const HOLD_MS = 750;
const SHRINK_MS = 800;
// How far a bar runs past its place before it settles, in logo units.
const OVERSHOOT = 17;

const animations = new Set();
let finished = false;

function onKey(event) {
  if (event.key === 'Escape') finish();
}

/** Take the sequence off the screen and hand the page back. Safe to call more than once. */
function finish() {
  if (finished) return;
  finished = true;
  const hadFocus = overlay.contains(document.activeElement);
  root.classList.remove('intro-on');
  animations.forEach(animation => animation.cancel());
  animations.clear();
  if (shell) shell.inert = false;
  document.removeEventListener('keydown', onKey);
  if (hadFocus) document.querySelector('#page-title')?.focus({ preventScroll: true });
}

function run(element, keyframes, options) {
  const animation = element.animate(keyframes, { fill: 'both', ...options });
  animations.add(animation);
  return animation.finished;
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/** The share of a straight journey between two centres at which the traveller first sits inside a rectangle. */
function arrival(from, to, target) {
  for (let step = 0; step <= 100; step += 1) {
    const share = step / 100;
    const x = from.x + (to.x - from.x) * share;
    const y = from.y + (to.y - from.y) * share;
    if (x >= target.left && x <= target.right && y >= target.top && y <= target.bottom) return share;
  }
  return 1;
}

async function play() {
  const logo = overlay.querySelector('.intro-logo');
  // The name is drawn twice. The dark copy rides on the tile and is cut off with it.
  // The light copy waits underneath and shows wherever the tile has gone.
  const word = overlay.querySelector('.intro-word-dark');
  const under = overlay.querySelector('.intro-word-light');
  const tile = overlay.querySelector('.intro-tile');
  const skip = overlay.querySelector('.intro-skip');
  const mark = document.querySelector('.brand-mark');
  const markImage = mark?.querySelector('img');
  const brandWord = document.querySelector('.brand-wordmark strong');
  if (!logo?.animate || !word || !under || !tile || !markImage || !brandWord) return;

  if (shell) shell.inert = true;
  skip?.addEventListener('click', finish, { once: true });
  document.addEventListener('keydown', onKey);

  // Bars move in logo units, so the distance to the edge of the screen is converted first.
  const box = logo.getBoundingClientRect();
  const unit = box.width / LOGO_UNITS;
  const reach = { x: (overlay.clientWidth / 2 + box.width) / unit, y: (overlay.clientHeight / 2 + box.height * 1.2) / unit };
  await Promise.all(BARS.map(({ id, x, y, turn, delay }) => {
    const length = Math.hypot(x, y);
    const past = [-x / length * OVERSHOOT, -y / length * OVERSHOOT];
    return run(overlay.querySelector(`[data-bar="${id}"]`), [
      { opacity: 1, transform: `translate(${x * reach.x}px, ${y * reach.y}px) rotate(${turn}deg)`, easing: 'cubic-bezier(.45, 0, .8, .5)' },
      { opacity: 1, transform: `translate(${past[0]}px, ${past[1]}px) rotate(${turn > 0 ? -3 : 3}deg)`, offset: .68, easing: 'ease-out' },
      { opacity: 1, transform: `translate(${-past[0] * .3}px, ${-past[1] * .3}px) rotate(${turn > 0 ? 1 : -1}deg)`, offset: .85, easing: 'ease-in-out' },
      { opacity: 1, transform: 'translate(0px, 0px) rotate(0deg)' },
    ], { duration: FALL_MS, delay });
  }));

  await run(word, [
    { opacity: 0, transform: `translate(0px, ${box.height * .09}px) scale(1)` },
    { opacity: 1, transform: 'translate(0px, 0px) scale(1)' },
  ], { duration: WORD_MS, easing: 'cubic-bezier(.2, .7, .2, 1)' });
  await wait(HOLD_MS);
  if (finished) return;

  // Measure where the brand sits on the page underneath, then close down onto it.
  const image = markImage.getBoundingClientRect();
  const from = logo.getBoundingClientRect();
  const logoMove = `translate(${image.left + image.width * GLYPH.left - from.left}px, ${image.top + image.height * GLYPH.top - from.top}px) scale(${image.width * GLYPH.width / from.width})`;
  const wordFrom = word.getBoundingClientRect();
  const wordTo = brandWord.getBoundingClientRect();
  const wordScale = wordTo.height / wordFrom.height;
  const wordMove = `translate(${wordTo.left - wordFrom.left}px, ${wordTo.top - wordFrom.top}px) scale(${wordScale})`;
  // The copy under the tile is dark over the page and turns to the brand's own colour as it reaches the navy bar.
  const bar = (mark.closest('.sidebar') ?? mark).getBoundingClientRect();
  const reached = arrival(
    { x: wordFrom.left + wordFrom.width / 2, y: wordFrom.top + wordFrom.height / 2 },
    { x: wordTo.left + wordFrom.width * wordScale / 2, y: wordTo.top + wordTo.height / 2 },
    bar,
  );
  const ink = getComputedStyle(word).color;
  const landed = getComputedStyle(brandWord).color;
  const frame = tile.getBoundingClientRect();
  const corner = mark.getBoundingClientRect();
  const clip = `inset(${corner.top - frame.top}px ${frame.right - corner.right}px ${frame.bottom - corner.bottom}px ${corner.left - frame.left}px round ${getComputedStyle(mark).borderTopLeftRadius})`;
  const timing = { duration: SHRINK_MS, easing: 'cubic-bezier(.7, 0, .2, 1)' };
  if (skip) run(skip, [{ opacity: 1 }, { opacity: 0 }], { duration: 160 }).catch(() => {});
  await Promise.all([
    run(tile, [{ clipPath: 'inset(0px 0px 0px 0px round 0px)' }, { clipPath: clip }], timing),
    run(logo, [{ transform: 'translate(0px, 0px) scale(1)' }, { transform: logoMove }], timing),
    // Both copies of the name travel together, so it reads as one word whichever side of the tile's edge it is on.
    run(word, [{ opacity: 1, transform: 'translate(0px, 0px) scale(1)' }, { opacity: 1, transform: wordMove }], timing),
    run(under, [
      { color: ink, transform: 'translate(0px, 0px) scale(1)' },
      { color: ink, offset: Math.max(0, Math.min(.9, reached - .05)) },
      { color: landed, offset: Math.max(.05, Math.min(.95, reached + .05)) },
      { color: landed, transform: wordMove },
    ], timing),
  ]);
}

// Skipping cancels the running animations, which rejects their promises. Either way the page is handed back.
if (overlay && root.classList.contains('intro-on')) play().catch(() => {}).finally(finish);
