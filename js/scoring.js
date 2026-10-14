// Scoring for both round types, turn order, totals, and standings.
// Pure functions over game state, shared by the host console and the scoreboard.

export const MARKET = 'market';
const NICHE = 'niche';
const LINEAR = 'linear';
const CATCH_UP = 'catchup';
const REVEAL_COUNT = 5;

/**
 * Points for a valid answer, from its share of the locked top's views.
 * A top with no views gives any viewed answer a full share. Misses score 0 and never reach this function.
 * @param {string} type 'market' or 'niche'
 * @param {number} views
 * @param {number} top
 * @returns {number}
 */
export function points(type, views, top) {
  const pct = top > 0 ? Math.round(100 * views / top) : (views > 0 ? 100 : 0);
  return type === NICHE ? Math.max(0, 100 - pct) : Math.min(100, pct);
}

/**
 * Most-viewed valid item on a board.
 * @param {Array} items
 * @returns {object|null}
 */
export function topItem(items) {
  let best = null;
  items.forEach(function (item) {
    if (item.valid && (!best || item.views > best.views)) best = item;
  });
  return best;
}

/**
 * The round being played or just ended, or null between rounds.
 * @param {object} state
 * @returns {object|null}
 */
export function currentRound(state) {
  if (state.phase !== 'playing' && state.phase !== 'ended') return null;
  return state.rounds.at(-1) ?? null;
}

/**
 * @param {object} state
 * @param {number} id
 * @returns {string}
 */
export function playerName(state, id) {
  const player = state.players.find(function (p) { return p.id === id; });
  return player ? player.name : '?';
}

/**
 * Slot order for the round about to start, from the order setting. Snake and linear rotate the first pick
 * by round; catch-up puts the lowest total first, ties in seating order. Snake and catch-up reverse each pass.
 * @param {object} state before the new round is added
 * @returns {Array<number>} player id per slot
 */
export function turnOrder(state) {
  const ids = state.players.map(function (p) { return p.id; });
  const order = state.settings.order;
  let base;
  if (order === CATCH_UP) {
    const sums = totals(state);
    base = ids.toSorted(function (a, b) { return sums[a] - sums[b]; });
  } else {
    const start = state.rounds.length % ids.length;
    base = ids.slice(start).concat(ids.slice(0, start));
  }
  const back = order === LINEAR ? base : base.toReversed();
  return Array.from({ length: state.settings.picksPerPlayer }, function (_, pass) {
    return pass % 2 === 0 ? base : back;
  }).flat();
}

function openSlotIndexes(round) {
  const open = [];
  round.slots.forEach(function (slot, i) {
    if (slot.pickId === null) open.push(i);
  });
  return open;
}

/**
 * Slot the next answer fills: the override player's earliest open slot, else the earliest open slot.
 * @param {object} round
 * @returns {number} slot index, or -1 when every slot is filled
 */
export function turnSlot(round) {
  const own = round.slots.findIndex(function (slot) {
    return slot.pickId === null && slot.playerId === round.override;
  });
  return own !== -1 ? own : round.slots.findIndex(function (slot) { return slot.pickId === null; });
}

/**
 * Player ids for the turns after the current one, in sequence order.
 * @param {object} round
 * @param {number} count
 * @returns {Array<number>}
 */
export function upNext(round, count) {
  const current = turnSlot(round);
  return openSlotIndexes(round)
    .filter(function (i) { return i !== current; })
    .slice(0, count)
    .map(function (i) { return round.slots[i].playerId; });
}

/**
 * True when the player still has an open slot this round.
 * @param {object} round
 * @param {number} playerId
 * @returns {boolean}
 */
export function hasOpenSlot(round, playerId) {
  return round.slots.some(function (slot) { return slot.pickId === null && slot.playerId === playerId; });
}

/**
 * Sum of a player's points in one round.
 * @param {object} round
 * @param {number} playerId
 * @returns {number}
 */
export function roundScore(round, playerId) {
  return round.picks.reduce(function (sum, pick) {
    return pick.playerId === playerId ? sum + pick.points : sum;
  }, 0);
}

/**
 * Game totals by player id.
 * @param {object} state
 * @returns {Object<number, number>}
 */
export function totals(state) {
  const result = {};
  state.players.forEach(function (p) { result[p.id] = 0; });
  state.rounds.forEach(function (round) {
    round.picks.forEach(function (pick) {
      result[pick.playerId] += pick.points;
    });
  });
  return result;
}

// The round that breaks ties: the last round flagged final, else the last round played.
function finalRound(state) {
  return state.rounds.findLast(function (r) { return r.final; }) ?? state.rounds.at(-1) ?? null;
}

/**
 * Standings, highest total first. Equal totals are split by final-round score; still equal is a tie.
 * @param {object} state
 * @returns {Array<{player: object, total: number, finalScore: number, rank: number, label: string, tiebroken: boolean}>}
 *   label is the rank with a "T" prefix for ties; tiebroken is true when final-round score placed the row
 *   against an equal total
 */
export function standings(state) {
  const sums = totals(state);
  const last = finalRound(state);
  const rows = state.players.map(function (player) {
    return { player: player, total: sums[player.id], finalScore: last ? roundScore(last, player.id) : 0 };
  });
  rows.sort(function (a, b) {
    return (b.total - a.total) || (b.finalScore - a.finalScore);
  });
  function sameScore(a, b) {
    return !!a && !!b && a.total === b.total && a.finalScore === b.finalScore;
  }
  rows.forEach(function (row, i) {
    row.rank = sameScore(rows[i - 1], row) ? rows[i - 1].rank : i + 1;
  });
  rows.forEach(function (row, i) {
    const tied = sameScore(rows[i - 1], row) || sameScore(row, rows[i + 1]);
    row.label = (tied ? 'T' : '') + row.rank;
    row.tiebroken = rows.some(function (other) {
      return other.total === row.total && other.finalScore !== row.finalScore;
    });
  });
  return rows;
}

/**
 * The reveal: valid answers nobody picked, most-viewed for Market Share and least-viewed for Niche Market.
 * @param {object} round
 * @returns {Array<{title: string, views: number}>}
 */
export function revealItems(round) {
  const picked = pickedTitles(round);
  const pool = round.items.filter(function (item) { return item.valid && !picked.has(item.title); });
  pool.sort(function (a, b) {
    return round.type === NICHE ? a.views - b.views : b.views - a.views;
  });
  return pool.slice(0, REVEAL_COUNT).map(function (item) { return { title: item.title, views: item.views }; });
}

/**
 * Titles already picked in a round, mapped to the picker's id.
 * @param {object} round
 * @returns {Map<string, number>}
 */
export function pickedTitles(round) {
  const map = new Map();
  round.picks.forEach(function (pick) {
    if (!pick.miss) map.set(pick.title, pick.playerId);
  });
  return map;
}
