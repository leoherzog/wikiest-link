// Screen-shared scoreboard: renders the public view of game state and animates picks as they land.
// Read-only. It never shows the board or would-be points; unpicked answers appear only in the host-triggered reveal.

import { load, subscribe, periodLabel } from './store.js';
import { MARKET, turnSlot, upNext, totals, standings, revealItems, currentRound, playerName } from './scoring.js';
import { $, fmt, icon, ROUND_TYPES } from './dom.js';

const COUNT_MS = 2000;
const FLASH_MS = 2400;
const GAME_NAME = 'THE WIKIEST LINK';
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

// Pick id → performance.now() when this window first saw it. Picks present at load never animate.
const landed = new Map();
let firstRender = true;
let counters = [];
let frame = 0;
let flashTimer = 0;

function easeOut(t) {
  return 1 - (1 - t) ** 3;
}

function elapsed(pickId, now) {
  return reducedMotion.matches ? Infinity : now - landed.get(pickId);
}

// importNode, not cloneNode: a clone stays in the template's inert document, where the flash animation never runs.
function fromTemplate(id) {
  return document.importNode($(id).content.firstElementChild, true);
}

function setMark(el, iconName, text) {
  const mark = document.createElement('mark');
  mark.append(icon(iconName), ' ' + text);
  el.replaceChildren(mark);
  return mark;
}

function render() {
  const state = load();
  const now = performance.now();
  state.rounds.forEach(function (round) {
    round.picks.forEach(function (pick) {
      if (!landed.has(pick.id)) landed.set(pick.id, firstRender ? -Infinity : now);
    });
  });
  firstRender = false;

  const round = currentRound(state);
  const reveal = !!(round && round.reveal);
  const over = state.phase === 'over';
  document.body.dataset.type = round ? round.type : MARKET;

  renderBanner(state, round);
  renderCategory(state, round);
  $('sb-players').hidden = reveal || over;
  renderPlayers(state, round, now);
  renderUpNext(state, round, reveal);
  renderReveal(round, reveal);
  renderStandings(state, over);

  cancelAnimationFrame(frame);
  tick();
}

function renderBanner(state, round) {
  const type = round ? ROUND_TYPES[round.type] : null;
  $('sb-type').replaceChildren(icon(type ? type.icon : 'link'), ' ' + (type ? type.name.toUpperCase() : GAME_NAME));
  if (type) $('sb-goal').textContent = type.goal;
  else if (state.phase === 'over') $('sb-goal').textContent = 'game over';
  else $('sb-goal').textContent = 'the Wikipedia pageviews game';
  let roundText = '';
  if (round) roundText = 'ROUND ' + round.number;
  else if (state.phase === 'setup') roundText = 'ROUND ' + (state.rounds.length + 1) + ' UP NEXT';
  $('sb-round').replaceChildren();
  if (roundText) $('sb-round').append(icon('flag'), ' ' + roundText);
  $('sb-final').hidden = !(round && round.final);
}

function renderCategory(state, round) {
  let title = 'Waiting for the host';
  if (round) title = round.title;
  else if (state.phase === 'setup') title = 'Choosing the next category…';
  else if (state.phase === 'over') title = 'Final standings';
  $('sb-category').textContent = title;
  $('sb-period').hidden = !round;
  if (round) $('sb-period').replaceChildren(icon('eye'), ' English Wikipedia pageviews, ' + periodLabel(round.period));
}

function renderPlayers(state, round, now) {
  const sums = totals(state);
  const slot = round && state.phase === 'playing' ? turnSlot(round) : -1;
  const current = slot === -1 ? null : round.slots[slot].playerId;
  let flashEnds = Infinity;
  counters = [];
  clearTimeout(flashTimer);

  const frag = document.createDocumentFragment();
  state.players.forEach(function (player) {
    const card = fromTemplate('tpl-player');
    const status = card.querySelector('hgroup > p');
    const picks = card.querySelector('article > div');
    card.querySelector('h2').append(icon('user'), ' ' + player.name);
    if (player.id === current) {
      card.setAttribute('aria-current', 'true');
      setMark(status, 'hand-point-right', 'NOW PICKING');
    }
    const counter = { totalEl: card.querySelector('article > p'), base: sums[player.id], anims: [] };

    if (round) {
      const body = picks.querySelector('tbody');
      round.picks.forEach(function (pick) {
        if (pick.playerId !== player.id) return;
        const tr = pickRow(pick);
        body.append(tr);
        if (!pick.miss && elapsed(pick.id, now) < COUNT_MS) {
          counter.base -= pick.points;
          counter.anims.push({ el: tr.cells[1].firstElementChild, points: pick.points, pickId: pick.id });
        }
        const age = now - landed.get(pick.id);
        if (!pick.miss && pick.points === 100 && age < FLASH_MS) {
          flash(status, ROUND_TYPES[round.type], age);
          flashEnds = Math.min(flashEnds, FLASH_MS - age);
        }
      });
      round.slots.forEach(function (s) {
        if (s.playerId === player.id && s.pickId === null) body.append(fromTemplate('tpl-empty'));
      });
      picks.style.setProperty('--rows', body.rows.length);
    } else {
      picks.remove();
    }
    counters.push(counter);
    frag.append(card);
  });
  $('sb-players').replaceChildren(frag);
  // Re-render once the flash ends so the status line returns to its turn label.
  if (flashEnds !== Infinity) flashTimer = setTimeout(render, flashEnds + 50);
}

function pickRow(pick) {
  const tr = fromTemplate(pick.miss ? 'tpl-miss' : 'tpl-pick');
  const answer = tr.cells[0];
  answer.firstElementChild.textContent = pick.miss ? (pick.typed || pick.title || 'Miss') : pick.title;
  if (!pick.miss) answer.querySelector('small').append(' ' + fmt.format(pick.views) + ' views');
  tr.cells[1].firstElementChild.textContent = String(pick.points);
  return tr;
}

function flash(status, type, age) {
  const mark = setMark(status, type.flashIcon, type.flash);
  if (reducedMotion.matches) return;
  const blink = mark.animate(
    [{ opacity: 0 }, { opacity: 1 }, { opacity: 0.2 }, { opacity: 1 }, { opacity: 0.2 }, { opacity: 1 }],
    { duration: FLASH_MS, easing: 'ease-out' }
  );
  blink.currentTime = age;
}

function renderUpNext(state, round, reveal) {
  const show = !reveal && !!round && state.phase === 'playing' && turnSlot(round) !== -1;
  $('sb-upnext').hidden = !show;
  if (!show) return;
  const names = upNext(round, 3).map(function (id) { return playerName(state, id); });
  $('sb-next').textContent = names.length ? names.join(' → ') : 'Last pick of the round';
}

function renderReveal(round, show) {
  $('sb-reveal').hidden = !show;
  if (!show) return;
  $('sb-reveal-title').textContent = ROUND_TYPES[round.type].reveal;
  const rows = revealItems(round).map(function (item) {
    const tr = fromTemplate('tpl-reveal');
    tr.cells[0].textContent = item.title;
    tr.cells[1].append(' ' + fmt.format(item.views) + ' views');
    return tr;
  });
  if (!rows.length) rows.push(fromTemplate('tpl-reveal-none'));
  $('sb-reveal-body').replaceChildren(...rows);
}

function renderStandings(state, show) {
  $('sb-standings').hidden = !show;
  if (!show) return;
  const rows = standings(state);
  const trs = rows.map(function (row) {
    const tr = fromTemplate('tpl-standing');
    tr.cells[0].textContent = row.label;
    if (row.rank === 1) setMark(tr.cells[1], 'crown', row.player.name);
    else tr.cells[1].textContent = row.player.name;
    tr.cells[2].textContent = fmt.format(row.total);
    return tr;
  });
  $('sb-standings-body').replaceChildren(...trs);
  $('sb-tiebreak').hidden = !rows.some(function (row) { return row.tiebroken; });
}

function tick() {
  const now = performance.now();
  let active = false;
  counters.forEach(function (counter) {
    let extra = 0;
    counter.anims.forEach(function (anim) {
      const t = Math.min(1, elapsed(anim.pickId, now) / COUNT_MS);
      const value = Math.round(anim.points * easeOut(t));
      anim.el.textContent = String(value);
      extra += value;
      if (t < 1) active = true;
    });
    counter.totalEl.textContent = fmt.format(counter.base + extra);
  });
  frame = active ? requestAnimationFrame(tick) : 0;
}

subscribe(render);
render();
