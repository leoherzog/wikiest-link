// Host console: players, category search and board build, board review, answering and rulings,
// and round/game flow. This window is the only writer of game state.

import { $, fmt, icon, ROUND_TYPES } from './dom.js';
import {
  load, save, subscribe, defaultState, loadUi, saveUi, getBoard, putBoard, prune, periodLabel, lastTwelveMonths
} from './store.js';
import * as wiki from './wiki.js';
import {
  MARKET, points, topItem, turnOrder, turnSlot, upNext, hasOpenSlot, totals, standings,
  revealItems, pickedTitles, roundScore, currentRound, playerName
} from './scoring.js';

const SCOREBOARD_URL = 'scoreboard.html';
const SCOREBOARD_NAME = 'wikiest-link-scoreboard';
const SCOREBOARD_FEATURES = 'popup,width=1280,height=720';
const MAX_PLAYERS = 6;
// Phases before the first round, when there is nothing for the scoreboard to show.
const BEFORE_GAME = ['splash', 'welcome', 'lobby'];
const MISS_LABELS = { miss: 'Miss', nofit: 'Doesn\'t fit', repeat: 'Repeat' };

function defaultUi() {
  return {
    q: '', filter: '', answer: '', sort: 'views:desc', lookup: null, building: null, draft: null, home: false
  };
}

let state = load();
let ui = Object.assign(defaultUi(), loadUi());
let popupBlocked = false;
let suggestions = [];
let searchTimer = 0;
let messageTimer = 0;
const controllers = { search: new AbortController(), build: new AbortController(), lookup: new AbortController() };
const boardRows = { review: [], play: [] };
const foldCache = new WeakMap();
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/**
 * Abort the running request of one kind and start tracking its replacement.
 * @param {string} key 'search', 'build' or 'lookup'
 * @returns {AbortController}
 */
function restart(key) {
  controllers[key].abort();
  controllers[key] = new AbortController();
  return controllers[key];
}

function commit() {
  try {
    save(state);
  } catch (err) {
    console.log('Could not save game state', err);
    showMessage('Could not save the game, so the scoreboard will not show this change: ' + err.message);
  }
  render();
}

// The status region stays in the page so screen readers announce what is put into it.
function showMessage(text) {
  const box = document.createElement('article');
  box.append(icon('circle-info'), ' ' + text);
  $('message').replaceChildren(box);
  clearTimeout(messageTimer);
  messageTimer = setTimeout(function () { $('message').replaceChildren(); }, 8000);
}

// A table row; each cell is a <td> or <th>, or text or a node to put in a new <td>.
function row(cells) {
  const tr = document.createElement('tr');
  cells.forEach(function (cell) {
    if (cell instanceof HTMLTableCellElement) tr.append(cell);
    else tr.insertCell().append(cell);
  });
  return tr;
}

// ---------- Scoreboard window ----------

function openScoreboard() {
  const win = window.open(SCOREBOARD_URL, SCOREBOARD_NAME, SCOREBOARD_FEATURES);
  popupBlocked = !win;
  if (popupBlocked) showMessage('The scoreboard popup was blocked. Use "Open scoreboard" to open it.');
  renderHeader();
}

function renderHeader() {
  $('open-scoreboard').hidden = BEFORE_GAME.includes(state.phase) && !popupBlocked;
}

// ---------- Splash and welcome ----------

// The wordmark shows the splash as host-only UI state, so a game in progress keeps its phase and scoreboard.
// Modified clicks fall through to the link.
$('brand-link').addEventListener('click', function (event) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  ui.home = true;
  saveUi(ui);
  render();
  focusView();
});

$('begin-game').addEventListener('click', function () {
  ui.home = false;
  saveUi(ui);
  if (state.phase === 'splash') state.phase = 'welcome';
  commit();
  focusView();
});

$('start-new-game').addEventListener('click', function () {
  state.phase = 'lobby';
  commit();
  $('add-player').elements.name.focus();
});

// ---------- Lobby ----------

function renderLobby() {
  const last = state.players.length - 1;
  $('player-list').replaceChildren(...state.players.map(function (player, i) {
    const tr = document.importNode($('tpl-player-row').content.firstElementChild, true);
    tr.dataset.index = String(i);
    tr.cells[0].append(' ' + (i + 1) + '. ' + player.name);
    tr.querySelectorAll('button').forEach(function (button) {
      button.setAttribute('aria-label', button.getAttribute('aria-label') + ': ' + player.name);
    });
    tr.querySelector('[data-act="up"]').disabled = i === 0;
    tr.querySelector('[data-act="down"]').disabled = i === last;
    return tr;
  }));
  const full = state.players.length >= MAX_PLAYERS;
  const form = $('add-player');
  form.querySelector('fieldset').disabled = full;
  form.elements.name.placeholder = full ? 'Six players maximum' : 'Player name';
  $('start-game').disabled = state.players.length === 0;
}

function playerAction(act, i) {
  const players = state.players;
  if (act === 'remove') {
    players.splice(i, 1);
    commit();
    $('add-player').elements.name.focus();
    return;
  }
  const to = act === 'up' ? Math.max(i - 1, 0) : Math.min(i + 1, players.length - 1);
  players.splice(to, 0, players.splice(i, 1)[0]);
  commit();
  // A row moved to either end has that direction's button disabled, so focus goes to the other one.
  const moved = $('player-list').rows[to];
  const same = moved.querySelector('[data-act="' + act + '"]');
  (same.disabled ? moved.querySelector('[data-act="' + (act === 'up' ? 'down' : 'up') + '"]') : same).focus();
}

$('player-list').addEventListener('click', function (event) {
  const button = event.target.closest('button[data-act]');
  if (button) playerAction(button.dataset.act, Number(button.closest('tr').dataset.index));
});

$('add-player').addEventListener('submit', function (event) {
  event.preventDefault();
  const input = event.target.elements.name;
  const name = input.value.trim();
  if (!name || state.players.length >= MAX_PLAYERS) return;
  state.players.push({ id: state.nextId++, name: name });
  input.value = '';
  commit();
  // A full lobby disables the input, so focus moves on to starting the game.
  (input.matches(':disabled') ? $('start-game') : input).focus();
});

$('start-game').addEventListener('click', function () {
  if (!state.players.length) return;
  openScoreboard();
  state.phase = 'setup';
  commit();
  $('category-form').elements.q.focus();
});

$('open-scoreboard').addEventListener('click', openScoreboard);

// ---------- Category search and board build ----------

function renderSetup() {
  $('setup-heading').textContent = 'Round ' + (state.rounds.length + 1) + ': choose a category';
  const input = $('category-form').elements.q;
  if (document.activeElement !== input) input.value = ui.q;
  $('build').hidden = !ui.building;
  $('end-game-setup').hidden = state.rounds.length === 0;
  renderSuggestions();
  renderReview();
}

function renderSuggestions() {
  $('suggestions').replaceChildren(...suggestions.map(function (title) { return new Option('', title); }));
}

function looksLikeUrl(text) {
  return /^https?:\/\//i.test(text);
}

async function runSuggest() {
  const text = ui.q.trim();
  const controller = restart('search');
  if (!text || looksLikeUrl(text)) {
    suggestions = [];
    renderSuggestions();
    return;
  }
  try {
    const titles = await wiki.search(text, controller.signal);
    if (controller.signal.aborted) return;
    suggestions = titles;
    renderSuggestions();
  } catch (err) {
    if (!controller.signal.aborted) console.log('Suggestion search failed', err);
  }
}

$('category-form').elements.q.addEventListener('input', function (event) {
  ui.q = event.target.value;
  clearTimeout(searchTimer);
  // Picking a datalist option replaces the text instead of typing it; some browsers send a plain Event.
  const picked = event.inputType === 'insertReplacementText' || event.inputType === undefined;
  if (picked && suggestions.indexOf(ui.q) !== -1) {
    chooseCategory(ui.q);
    return;
  }
  searchTimer = setTimeout(runSuggest, 300);
});

$('category-form').elements.q.addEventListener('change', function () {
  saveUi(ui);
});

$('category-form').addEventListener('submit', function (event) {
  event.preventDefault();
  const text = event.target.elements.q.value.trim();
  if (!text) return;
  let title;
  try {
    title = wiki.titleFromUrl(text) || text;
  } catch (err) {
    showMessage(err.message);
    return;
  }
  chooseCategory(title);
});

function chooseCategory(title) {
  clearTimeout(searchTimer);
  controllers.search.abort();
  suggestions = [];
  renderSuggestions();
  ui.building = { title: title, period: lastTwelveMonths() };
  saveUi(ui);
  startBuild();
}

function setProgress(label, done, total) {
  const progress = $('build-progress');
  if (total > 0) {
    progress.max = total;
    progress.value = done;
    $('build-label').textContent = label + ': ' + done + ' of ' + total;
  } else {
    progress.removeAttribute('value');
    $('build-label').textContent = label;
  }
}

async function startBuild() {
  const job = ui.building;
  if (!job) return;
  const controller = restart('build');
  $('build').hidden = false;
  setProgress('Building board for ' + job.title, 0, 0);
  try {
    const board = getBoard(job.title, job.period) ||
      await wiki.buildBoard(job.title, job.period, setProgress, controller.signal, function (canonical) {
        return getBoard(canonical, job.period);
      });
    putBoard(board);
    if (controller !== controllers.build || state.phase !== 'setup') return;
    console.log('Board ready: ' + board.title + ' (' + board.items.length + ' candidates)');
    ui.draft = {
      title: board.title, period: board.period, items: board.items, dropped: board.dropped, type: MARKET, final: false
    };
    ui.building = null;
    ui.filter = '';
    ui.q = '';
    saveUi(ui);
    render();
  } catch (err) {
    if (controller.signal.aborted) return;
    console.log('Board build failed', err);
    showMessage('Could not build a board for "' + job.title + '": ' + err.message);
    ui.building = null;
    saveUi(ui);
    $('build').hidden = true;
  }
}

// ---------- Board tables ----------

function fold(text) {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function foldedNames(item) {
  let names = foldCache.get(item);
  if (!names) {
    names = [item.title].concat(item.aliases).map(fold);
    foldCache.set(item, names);
  }
  return names;
}

// 1 exact, 2 prefix, 3 word prefix, 4 substring, 0 no match.
function matchRank(item, query) {
  let best = 0;
  foldedNames(item).forEach(function (name) {
    let rank = 0;
    if (name === query) rank = 1;
    else if (name.indexOf(query) === 0) rank = 2;
    else if ((' ' + name).indexOf(' ' + query) !== -1) rank = 3;
    else if (name.indexOf(query) !== -1) rank = 4;
    if (rank && (!best || rank < best)) best = rank;
  });
  return best;
}

// Ascending comparators keyed by the first half of a sort value such as 'views:desc'.
const COMPARE = {
  valid: function (a, b) { return (a.valid ? 1 : 0) - (b.valid ? 1 : 0); },
  title: function (a, b) { return collator.compare(a.title, b.title); },
  description: function (a, b) { return collator.compare(a.description, b.description); },
  views: function (a, b) { return a.views - b.views; }
};

function sortItems(items, sort) {
  const parts = sort.split(':');
  const compare = COMPARE[parts[0]];
  const dir = parts[1] === 'asc' ? 1 : -1;
  return items.slice().sort(function (a, b) {
    return (compare(a, b) * dir) || (b.views - a.views);
  });
}

// Filter by title and aliases; ranked rows put the best match first so Enter can take it.
function filterItems(items, text, ranked, sort) {
  const query = fold(text);
  if (!query) return sortItems(items, sort);
  const matches = [];
  items.forEach(function (item) {
    const rank = matchRank(item, query);
    if (rank) matches.push({ item: item, rank: rank });
  });
  if (!ranked) {
    return sortItems(matches.map(function (m) { return m.item; }), sort);
  }
  matches.sort(function (a, b) {
    return (a.rank - b.rank) || ((b.item.valid ? 1 : 0) - (a.item.valid ? 1 : 0)) || (b.item.views - a.item.views);
  });
  return matches.map(function (m) { return m.item; });
}

function itemTags(item, pickedBy) {
  const tags = [];
  if (pickedBy !== undefined) tags.push('picked by ' + playerName(state, pickedBy));
  if (item.offList) tags.push('off-list');
  if (item.outlier) tags.push('unlike the other items');
  if (item.disambig) tags.push('disambiguation');
  if (item.error) tags.push('pageviews failed');
  else if (item.noData) tags.push('no pageview data');
  return tags.join(' · ');
}

function appendNote(cell, text) {
  if (!text) return;
  const small = document.createElement('small');
  small.textContent = text;
  cell.append(document.createElement('br'), small);
}

// The top match is the one Enter takes, so it is filled and labelled; picked and unchecked rows are muted.
function assignButton(item, pickedBy, isTop) {
  const button = document.createElement('button');
  button.type = 'button';
  if (pickedBy !== undefined) {
    button.className = 'secondary outline';
    const struck = document.createElement('s');
    struck.textContent = item.title;
    button.append(struck);
  } else {
    button.className = isTop ? '' : item.valid ? 'outline' : 'secondary outline';
    button.textContent = item.title;
  }
  if (isTop) {
    const key = document.createElement('kbd');
    key.textContent = 'Enter';
    key.setAttribute('aria-hidden', 'true');
    button.append(' ', key);
    button.setAttribute('aria-keyshortcuts', 'Enter');
  }
  return button;
}

function renderBoard(table, rows, opts) {
  const trs = rows.map(function (item, i) {
    const tr = document.importNode($('tpl-board-row').content.firstElementChild, true);
    tr.dataset.index = String(i);
    const cells = tr.cells;
    const box = cells[0].firstElementChild;
    box.checked = item.valid;
    box.disabled = opts.mode !== 'review';
    box.setAttribute('aria-label', 'Valid: ' + item.title);
    const pickedBy = opts.picked ? opts.picked.get(item.title) : undefined;
    if (opts.mode === 'play') cells[1].append(assignButton(item, pickedBy, opts.highlightTop && i === 0));
    else cells[1].textContent = item.title;
    appendNote(cells[1], itemTags(item, pickedBy));
    appendNote(cells[1], item.aliases.slice(0, 4).join(' · '));
    cells[2].textContent = item.description;
    cells[3].textContent = fmt.format(item.views);
    cells[4].textContent = String(points(opts.type, item.views, opts.top));
    return tr;
  });
  if (!trs.length) {
    trs.push(row([opts.empty]));
    trs[0].cells[0].colSpan = 5;
  }
  table.tBodies[0].replaceChildren(...trs);
}

function renderSortHeaders() {
  const parts = ui.sort.split(':');
  $('review-sort').value = ui.sort;
  document.querySelectorAll('#review-board th[data-key]').forEach(function (th) {
    if (th.dataset.key === parts[0]) {
      th.setAttribute('aria-sort', parts[1] === 'asc' ? 'ascending' : 'descending');
    } else {
      th.removeAttribute('aria-sort');
    }
  });
}

// ---------- Board review ----------

function renderReview() {
  const draft = ui.draft;
  $('review').hidden = !draft;
  if (!draft) return;
  $('review-title').textContent = draft.title;
  $('review-meta').textContent = draft.items.length + ' candidates' +
    (draft.dropped ? ' · ' + draft.dropped + ' unrelated links left off' : '') +
    ' · English Wikipedia pageviews, ' + periodLabel(draft.period);
  const form = $('round-form');
  form.elements.type.value = draft.type;
  form.elements.final.checked = draft.final;
  const filter = $('review-filter');
  if (document.activeElement !== filter) filter.value = ui.filter;
  renderReviewSummary();
  renderSortHeaders();
  const top = topItem(draft.items);
  boardRows.review = filterItems(draft.items, ui.filter, false, ui.sort);
  renderBoard($('review-board'), boardRows.review, {
    mode: 'review', type: draft.type, top: top ? top.views : 0, empty: 'No candidates match the filter.'
  });
}

/**
 * Why the draft cannot start a round, or '' when it can.
 * @param {object|null} top the draft's top item
 * @returns {string}
 */
function startBlocker(top) {
  if (!top) return 'Check at least one item to start the round.';
  if (!top.views) return 'The top item has no pageviews, so nothing could score.';
  return '';
}

function renderReviewSummary() {
  const draft = ui.draft;
  const top = topItem(draft.items);
  const valid = draft.items.filter(function (i) { return i.valid; }).length;
  const blocker = startBlocker(top);
  $('review-summary').textContent = valid + ' valid · top: ' +
    (top ? top.title + ' (' + fmt.format(top.views) + ' views)' : 'none') + (blocker ? ' · ' + blocker : '');
  $('start-round').disabled = !!blocker;
}

// Toggling validity can move the top, so every points cell refreshes without rebuilding rows.
function refreshReviewPoints() {
  const draft = ui.draft;
  const top = topItem(draft.items);
  const topViews = top ? top.views : 0;
  $('review-board').tBodies[0].querySelectorAll('tr[data-index]').forEach(function (tr) {
    const item = boardRows.review[Number(tr.dataset.index)];
    tr.cells[4].textContent = String(points(draft.type, item.views, topViews));
  });
  renderReviewSummary();
}

$('review-board').tBodies[0].addEventListener('change', function (event) {
  if (event.target.type !== 'checkbox') return;
  const item = boardRows.review[Number(event.target.closest('tr').dataset.index)];
  item.valid = event.target.checked;
  saveUi(ui);
  refreshReviewPoints();
});

$('review-sort').addEventListener('change', function (event) {
  ui.sort = event.target.value;
  saveUi(ui);
  renderReview();
});

$('review-filter').addEventListener('input', function (event) {
  ui.filter = event.target.value;
  renderReview();
});

$('review-filter').addEventListener('change', function () {
  saveUi(ui);
});

$('round-form').addEventListener('change', function (event) {
  const form = event.currentTarget;
  ui.draft.type = form.elements.type.value;
  ui.draft.final = form.elements.final.checked;
  saveUi(ui);
  refreshReviewPoints();
});

$('round-form').addEventListener('submit', function (event) {
  event.preventDefault();
  const draft = ui.draft;
  if (!draft) return;
  const top = topItem(draft.items);
  if (startBlocker(top)) return;
  controllers.build.abort();
  ui.building = null;
  state.rounds.push({
    number: state.rounds.length + 1,
    title: draft.title,
    period: draft.period,
    type: draft.type,
    final: draft.final,
    top: { title: top.title, views: top.views },
    items: draft.items,
    slots: turnOrder(state).map(function (id) {
      return { playerId: id, pickId: null };
    }),
    picks: [],
    override: null,
    reveal: false
  });
  ui.draft = null;
  state.phase = 'playing';
  ui.answer = '';
  ui.lookup = null;
  ui.filter = '';
  saveUi(ui);
  commit();
  $('answer-form').elements.answer.focus();
});

$('end-game-setup').addEventListener('click', endGame);

// ---------- Play ----------

function renderPlay() {
  const round = currentRound(state);
  const info = ROUND_TYPES[round.type];
  $('play-title').textContent = 'Round ' + round.number + ': ' + round.title;
  $('play-meta').textContent = info.name + ' · ' + info.goal + (round.final ? ' · Final round' : '') +
    ' · top: ' + round.top.title + ' (' + fmt.format(round.top.views) + ' views) · ' + periodLabel(round.period);

  const slot = turnSlot(round);
  const filled = round.picks.length;
  if (slot === -1) {
    $('turn-name').textContent = 'Everyone has picked';
    $('turn-detail').textContent = '';
  } else {
    $('turn-name').textContent = 'Now picking: ' + playerName(state, round.slots[slot].playerId);
    const next = upNext(round, 3).map(function (id) { return playerName(state, id); });
    $('turn-detail').textContent = 'pick ' + (filled + 1) + ' of ' + round.slots.length +
      (round.override !== null ? ' · out of order' : '') + (next.length ? ' · then ' + next.join(', ') : '');
  }

  renderPlayerButtons(round, slot);

  const last = round.picks[round.picks.length - 1];
  const summary = last ? pickSummary(round, last) : 'No picks yet.';
  // Rewriting identical text would make screen readers repeat it on every render.
  if ($('last-pick').textContent !== summary) $('last-pick').textContent = summary;

  const input = $('answer-form').elements.answer;
  if (input.value !== ui.answer) input.value = ui.answer;
  $('search-live').disabled = !ui.answer.trim();
  $('undo').disabled = !round.picks.length;
  const end = $('end-round');
  end.classList.toggle('outline', slot !== -1);

  renderPicksLog(round);
  renderPlayBoard();
  renderLookup();
}

function renderPlayerButtons(round, slot) {
  const sums = totals(state);
  const current = slot === -1 ? null : round.slots[slot].playerId;
  $('player-buttons').replaceChildren(...state.players.map(function (player) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.id = String(player.id);
    button.append(icon('user'), ' ' + player.name + ' · ' + sums[player.id]);
    button.className = player.id === current ? '' : 'secondary outline';
    button.setAttribute('aria-pressed', String(round.override === player.id));
    button.disabled = !hasOpenSlot(round, player.id);
    return button;
  }));
}

$('player-buttons').addEventListener('click', function (event) {
  const button = event.target.closest('button[data-id]');
  const round = currentRound(state);
  if (!button || !round) return;
  const id = Number(button.dataset.id);
  round.override = round.override === id ? null : id;
  commit();
  $('answer-form').elements.answer.focus();
});

// The picks log's answer cell: the title, marked when off-list or ruled valid, or a miss's struck-out text.
function pickAnswer(pick) {
  const td = document.createElement('td');
  if (pick.miss) {
    const struck = document.createElement('s');
    struck.textContent = pick.typed || '—';
    td.append(icon('xmark'), ' ', struck, ' ' + MISS_LABELS[pick.reason]);
  } else if (pick.offList) {
    td.append(icon('globe'), ' ' + pick.title + ' (off-list)');
  } else if (pick.ruled) {
    td.append(icon('gavel'), ' ' + pick.title + ' (ruled valid)');
  } else {
    td.append(pick.title);
  }
  return td;
}

function renderPicksLog(round) {
  $('picks-log').replaceChildren(...round.picks.map(function (pick, i) {
    return row([
      String(i + 1), playerName(state, pick.playerId), pickAnswer(pick),
      pick.miss ? '—' : fmt.format(pick.views), String(pick.points)
    ]);
  }));
}

function renderPlayBoard() {
  const round = currentRound(state);
  const query = ui.answer.trim();
  boardRows.play = filterItems(round.items, query, true, ui.sort);
  renderBoard($('play-board'), boardRows.play, {
    mode: 'play',
    type: round.type,
    top: round.top.views,
    picked: pickedTitles(round),
    highlightTop: !!fold(query),
    empty: 'Not on the board. Search Wikipedia, or record a miss.'
  });
}

function typedOr(fallback) {
  return ui.answer.trim() || fallback || '';
}

function clearAnswer() {
  controllers.lookup.abort();
  ui.answer = '';
  ui.lookup = null;
  saveUi(ui);
}

// The last-pick readout, such as "Alice: Paris, 73 points. Bob is up."
function pickSummary(round, pick) {
  const answer = pick.miss ? MISS_LABELS[pick.reason] + (pick.typed ? ' "' + pick.typed + '"' : '') : pick.title;
  const slot = turnSlot(round);
  return playerName(state, pick.playerId) + ': ' + answer + ', ' + pick.points +
    (pick.points === 1 ? ' point. ' : ' points. ') +
    (slot === -1 ? 'Everyone has picked.' : playerName(state, round.slots[slot].playerId) + ' is up.');
}

function recordPick(round, fields) {
  const slot = turnSlot(round);
  const pick = Object.assign({
    id: state.nextId++,
    slot: slot,
    playerId: round.slots[slot].playerId,
    typed: ui.answer.trim(),
    title: null,
    views: null,
    points: 0,
    miss: false,
    reason: null,
    offList: false,
    ruled: false,
    override: round.override
  }, fields);
  round.slots[slot].pickId = pick.id;
  round.picks.push(pick);
  round.override = null;
  console.log('Pick: ' + playerName(state, pick.playerId) + ' → ' + (pick.title || pick.typed) + ' = ' + pick.points);
  clearAnswer();
  commit();
  $('answer-form').elements.answer.focus();
}

// `ruled` marks an unchecked board item the host ruled valid, so undo can uncheck it again.
function recordHit(round, item, ruled) {
  recordPick(round, {
    title: item.title,
    views: item.views,
    points: points(round.type, item.views, round.top.views),
    offList: item.offList,
    ruled: ruled
  });
}

function recordMiss(round, typed, reason, title) {
  recordPick(round, { typed: typed, title: title || null, miss: true, reason: reason });
}

function canPick(round) {
  if (state.phase !== 'playing' || !round) return false;
  if (turnSlot(round) === -1) {
    showMessage('Every slot is filled. Undo a pick or end the round.');
    return false;
  }
  return true;
}

/**
 * Record a board item for the current turn: a repeat miss when it was already picked this round, else a hit that
 * rules it valid if it was unchecked.
 * @param {object} round
 * @param {object} item an entry in round.items
 */
function takeEntry(round, item) {
  if (pickedTitles(round).has(item.title)) {
    recordMiss(round, typedOr(item.title), 'repeat', item.title);
    return;
  }
  const ruled = !item.valid;
  item.valid = true;
  recordHit(round, item, ruled);
}

function assignItem(item) {
  const round = currentRound(state);
  if (!canPick(round)) return;
  if (item.valid || pickedTitles(round).has(item.title)) takeEntry(round, item);
  else openRuling(item);
}

$('play-board').tBodies[0].addEventListener('click', function (event) {
  const button = event.target.closest('button');
  if (button) assignItem(boardRows.play[Number(button.closest('tr').dataset.index)]);
});

$('answer-form').elements.answer.addEventListener('input', function (event) {
  ui.answer = event.target.value;
  if (ui.lookup) {
    controllers.lookup.abort();
    ui.lookup = null;
  }
  saveUi(ui);
  $('search-live').disabled = !ui.answer.trim();
  renderPlayBoard();
  renderLookup();
});

$('answer-form').addEventListener('submit', function (event) {
  event.preventDefault();
  if (!ui.answer.trim()) return;
  if (fold(ui.answer) && boardRows.play.length) assignItem(boardRows.play[0]);
  else liveSearch();
});

$('search-live').addEventListener('click', liveSearch);

$('miss').addEventListener('click', function () {
  const round = currentRound(state);
  if (canPick(round)) recordMiss(round, ui.answer.trim(), 'miss', null);
});

$('undo').addEventListener('click', undo);
$('undo-end').addEventListener('click', undo);

function undo() {
  const round = currentRound(state);
  if (!round) return;
  if (state.phase === 'ended') {
    state.phase = 'playing';
    round.reveal = false;
  } else {
    const pick = round.picks.pop();
    if (!pick) return;
    round.slots[pick.slot].pickId = null;
    round.override = pick.override;
    if (pick.offList) {
      round.items = round.items.filter(function (item) { return !(item.offList && item.title === pick.title); });
    }
    if (pick.ruled) {
      const item = boardEntry(round, pick.title);
      if (item) item.valid = false;
    }
    console.log('Undid pick ' + pick.id);
  }
  commit();
  $('answer-form').elements.answer.focus();
}

$('end-round').addEventListener('click', function () {
  const round = currentRound(state);
  if (!round || state.phase !== 'playing') return;
  clearAnswer();
  round.override = null;
  state.phase = 'ended';
  commit();
  $('next-round').focus();
});

// ---------- Live lookup and rulings ----------

function openRuling(item) {
  controllers.lookup.abort();
  ui.lookup = {
    query: ui.answer.trim(), results: [], selected: item.title, status: 'ready', entry: Object.assign({}, item)
  };
  saveUi(ui);
  renderLookup();
  $('rule-counts').focus();
}

async function liveSearch() {
  const round = currentRound(state);
  const text = ui.answer.trim();
  if (!text || !round) return;
  const controller = restart('lookup');
  ui.lookup = { query: text, results: [], selected: null, status: 'searching', entry: null };
  saveUi(ui);
  renderLookup();
  try {
    const results = await wiki.search(text, controller.signal, true);
    if (controller.signal.aborted) return;
    ui.lookup.results = results;
    if (!results.length) {
      ui.lookup.status = 'none';
      saveUi(ui);
      renderLookup();
      return;
    }
    await selectLookup(results[0]);
  } catch (err) {
    lookupFailed(controller, err);
  }
}

async function selectLookup(title) {
  const round = currentRound(state);
  if (!round || !ui.lookup) return;
  const controller = restart('lookup');
  ui.lookup.selected = title;
  ui.lookup.status = 'loading';
  ui.lookup.entry = null;
  saveUi(ui);
  renderLookup();
  try {
    const entry = await wiki.lookup(title, round.period, controller.signal);
    if (controller.signal.aborted) return;
    ui.lookup.entry = entry;
    ui.lookup.status = entry ? 'ready' : 'notarticle';
    saveUi(ui);
    renderLookup();
  } catch (err) {
    lookupFailed(controller, err);
  }
}

function lookupFailed(controller, err) {
  if (controller.signal.aborted || !ui.lookup) return;
  console.log('Live lookup failed', err);
  ui.lookup.status = 'error';
  ui.lookup.error = err.message;
  saveUi(ui);
  renderLookup();
}

// The live board entry for a looked-up title, so undo and reloads never leave a stale label.
function boardEntry(round, title) {
  return round.items.find(function (i) { return i.title === title; }) || null;
}

function lookupHeading(lk, round) {
  const entry = lk.entry;
  switch (lk.status) {
    case 'searching': return 'Searching Wikipedia for "' + lk.query + '"…';
    case 'loading': return 'Looking up ' + lk.selected + '…';
    case 'none': return 'No English Wikipedia article matches "' + lk.query + '".';
    case 'notarticle': return lk.selected + ' is not an article.';
    case 'error': return 'Lookup failed: ' + lk.error;
  }
  if (pickedTitles(round).has(entry.title)) return 'Already picked this round: counts as a miss';
  const onBoard = boardEntry(round, entry.title);
  if (!onBoard) return 'Not on the board: your ruling';
  return onBoard.valid ? 'On the board' : 'On the board but unchecked: your ruling';
}

function renderLookup() {
  const round = currentRound(state);
  const lk = ui.lookup;
  $('lookup').hidden = !lk;
  if (!lk) return;
  const status = $('lookup-status');
  status.textContent = lookupHeading(lk, round);
  status.setAttribute('aria-busy', String(lk.status === 'searching' || lk.status === 'loading'));

  const results = $('lookup-results');
  results.replaceChildren(...lk.results.map(function (title) {
    return new Option(title, title, false, title === lk.selected);
  }));
  results.hidden = lk.results.length < 2;

  // Only the 'ready' status shows the actions, and every path that sets it also sets lk.entry.
  const entry = lk.status === 'ready' ? (boardEntry(round, lk.entry.title) || lk.entry) : null;
  $('lookup-detail').hidden = !entry;
  $('lookup-actions').hidden = !entry;
  if (!entry) return;
  $('lookup-title').textContent = entry.title;
  $('lookup-desc').textContent = entry.description || 'No short description';
  const notes = [];
  if (entry.error) notes.push('pageviews failed to load');
  else if (entry.noData) notes.push('no pageview data');
  if (entry.disambig) notes.push('disambiguation page');
  $('lookup-stats').textContent = fmt.format(entry.views) + ' views, ' + periodLabel(round.period) +
    ' · would score ' + points(round.type, entry.views, round.top.views) +
    (notes.length ? ' · ' + notes.join(' · ') : '');
}

$('lookup-results').addEventListener('change', function (event) {
  selectLookup(event.target.value);
});

$('rule-counts').addEventListener('click', function () {
  const round = currentRound(state);
  const lk = ui.lookup;
  if (!lk || lk.status !== 'ready' || !canPick(round)) return;
  let item = boardEntry(round, lk.entry.title);
  if (!item) {
    item = Object.assign({}, lk.entry, { aliases: lk.entry.aliases.slice(), valid: true, offList: true });
    if (lk.query && fold(lk.query) !== fold(item.title)) item.aliases.push(lk.query);
    round.items.push(item);
  }
  takeEntry(round, item);
});

$('rule-nofit').addEventListener('click', function () {
  const round = currentRound(state);
  const lk = ui.lookup;
  if (!lk || lk.status !== 'ready' || !canPick(round)) return;
  recordMiss(round, typedOr(lk.entry.title), 'nofit', lk.entry.title);
});

// ---------- Round over and game over ----------

function renderEnded() {
  const round = currentRound(state);
  const info = ROUND_TYPES[round.type];
  const sums = totals(state);
  $('ended-title').textContent = 'Round ' + round.number + ' over: ' + round.title;
  $('ended-meta').textContent = info.name + ' · ' + state.players.map(function (p) {
    return p.name + ' +' + roundScore(round, p.id) + ' (' + sums[p.id] + ')';
  }).join(' · ');
  $('reveal-heading').textContent = info.reveal;
  $('reveal-list').replaceChildren(...revealItems(round).map(function (item) {
    const li = document.createElement('li');
    li.textContent = item.title + ' · ' + fmt.format(item.views) + ' views';
    return li;
  }));
  const toggle = $('toggle-reveal');
  $('toggle-reveal-text').textContent = round.reveal ? 'Hide reveal on scoreboard' : 'Show reveal on scoreboard';
  toggle.setAttribute('aria-pressed', String(round.reveal));
}

$('toggle-reveal').addEventListener('click', function () {
  const round = currentRound(state);
  round.reveal = !round.reveal;
  commit();
});

// Finished rounds drop their boards to save storage; only their picks are read again.
$('next-round').addEventListener('click', function () {
  currentRound(state).items = [];
  state.phase = 'setup';
  ui.q = '';
  saveUi(ui);
  commit();
  $('category-form').elements.q.focus();
});

$('end-game').addEventListener('click', endGame);

function endGame() {
  const round = currentRound(state);
  if (round) round.items = [];
  controllers.build.abort();
  ui.building = null;
  ui.draft = null;
  saveUi(ui);
  state.phase = 'over';
  commit();
  $('over-heading').focus();
}

function renderOver() {
  $('final-standings').replaceChildren(...standings(state).map(function (r) {
    const name = document.createElement('th');
    name.scope = 'row';
    if (r.rank === 1) name.append(icon('crown'), ' ');
    name.append(r.player.name);
    return row([r.label, name, String(r.total), String(r.finalScore)]);
  }));
}

// ---------- Settings ----------

function renderSettings() {
  const form = $('settings-form');
  form.elements.picks.value = String(state.settings.picksPerPlayer);
  form.elements.order.value = state.settings.order;
}

// Enter in the picks field would otherwise submit the form and reload the page.
$('settings-form').addEventListener('submit', function (event) {
  event.preventDefault();
});

$('settings-form').elements.picks.addEventListener('change', function (event) {
  const n = Math.round(Number(event.target.value));
  if (n >= 1 && n <= 10) state.settings.picksPerPlayer = n;
  commit();
});

$('settings-form').elements.order.addEventListener('change', function (event) {
  state.settings.order = event.target.value;
  commit();
});

// The New game button opens this dialog through its command attributes.
$('confirm-new').addEventListener('close', function (event) {
  const dialog = event.target;
  const confirmed = dialog.returnValue === 'confirm';
  dialog.returnValue = '';
  if (!confirmed) return;
  Object.keys(controllers).forEach(restart);
  const fresh = defaultState();
  // The players stay, so a new game skips the welcome page.
  fresh.phase = 'lobby';
  fresh.players = state.players;
  fresh.nextId = state.nextId;
  fresh.settings = state.settings;
  state = fresh;
  ui = defaultUi();
  saveUi(ui);
  suggestions = [];
  commit();
});

// ---------- Render and restore ----------

// Each phase has a section with the same id. The splash and welcome sections are static.
const PHASES = {
  splash: function () {},
  welcome: function () {},
  lobby: renderLobby,
  setup: renderSetup,
  playing: renderPlay,
  ended: renderEnded,
  over: renderOver
};

function view() {
  return ui.home ? 'splash' : state.phase;
}

// A section's first heading takes focus when the view switches to it, as after a page load.
function focusView() {
  $(view()).querySelector('h1, h2').focus();
}

function render() {
  const shown = view();
  Object.keys(PHASES).forEach(function (phase) { $(phase).hidden = phase !== shown; });
  $('settings').hidden = shown === 'splash' || shown === 'welcome';
  $('begin-game-text').textContent = BEFORE_GAME.includes(state.phase) ? 'Begin game' : 'Return to game';
  renderHeader();
  PHASES[state.phase]();
  renderSettings();
}

subscribe(function () {
  state = load();
  render();
});

prune();
render();

if (ui.building) startBuild();

if (ui.lookup && state.phase === 'playing') {
  if (ui.lookup.status === 'searching') liveSearch();
  else if (ui.lookup.status === 'loading') selectLookup(ui.lookup.selected);
}
