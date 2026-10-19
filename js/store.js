// Game state, localStorage persistence, and cross-window sync. The host console is the only writer;
// the scoreboard re-renders from localStorage on storage events.

import { RULES } from './wiki.js';

const KEY_ROOT = 'wikiest-link:';
const VERSION = 1;
const GAME_KEY = KEY_ROOT + 'v' + VERSION;
const UI_KEY = GAME_KEY + ':ui';
// Game and UI keys of any version.
const VERSIONED_KEY = /^wikiest-link:v(\d+)(:|$)/;
const BOARD_ROOT = KEY_ROOT + 'board:';
const BOARD_PREFIX = BOARD_ROOT + 'r' + RULES + ':';
const MONTH_RANGE = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

/**
 * The twelve full calendar months before today, in UTC.
 * @returns {{from: string, to: string}} inclusive 'YYYY-MM' bounds
 */
export function lastTwelveMonths() {
  const now = new Date();
  function monthsAgo(n) {
    const m = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 1));
    return m.getUTCFullYear() + '-' + String(m.getUTCMonth() + 1).padStart(2, '0');
  }
  return { from: monthsAgo(12), to: monthsAgo(1) };
}

/**
 * Human label for a pageview period.
 * @param {{from: string, to: string}} period
 * @returns {string} e.g. 'Oct 2025 – Sep 2026', or 'Jan – Dec 2026' within one year
 */
export function periodLabel(period) {
  // Date-only strings such as '2025-10' parse as UTC midnight, matching the formatter's time zone.
  return MONTH_RANGE.formatRange(new Date(period.from), new Date(period.to));
}

/**
 * Fresh game state. Phases: welcome → lobby → setup → playing → ended → (setup …) → over.
 * @returns {object}
 */
export function defaultState() {
  return { settings: { picksPerPlayer: 2, order: 'snake' }, players: [], nextId: 1, phase: 'welcome', rounds: [] };
}

/**
 * Read game state, falling back to a fresh game when missing or unreadable.
 * @returns {object}
 */
export function load() {
  try {
    const state = JSON.parse(localStorage.getItem(GAME_KEY));
    if (state) return state;
  } catch (err) {
    console.log('Could not read saved game', err);
  }
  return defaultState();
}

/**
 * Delete stored data this version cannot use: boards for other periods or rules, and older game and UI keys.
 * Newer versions are kept so a stale tab cannot wipe a newer deploy's game. Only the host calls this.
 */
export function prune() {
  const current = BOARD_PREFIX + periodKey(lastTwelveMonths()) + ':';
  Object.keys(localStorage).forEach(function (key) {
    const versioned = VERSIONED_KEY.exec(key);
    if ((key.startsWith(BOARD_ROOT) && !key.startsWith(current)) || (versioned && Number(versioned[1]) < VERSION)) {
      localStorage.removeItem(key);
    }
  });
}

function clearBoards() {
  Object.keys(localStorage).forEach(function (key) {
    if (key.startsWith(BOARD_ROOT)) localStorage.removeItem(key);
  });
}

// Cached boards are the only expendable data, so a full store drops them and tries once more.
function setItem(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (err) {
    if (err.name !== 'QuotaExceededError') throw err;
    console.log('localStorage is full; clearing cached boards', err);
    clearBoards();
    localStorage.setItem(key, value);
  }
}

/**
 * Persist game state; other windows hear it as a storage event.
 * Throws when the write fails, including when storage is still full after cached boards are cleared.
 * @param {object} state
 */
export function save(state) {
  setItem(GAME_KEY, JSON.stringify(state));
}

/**
 * Call `onChange` when another window saves different game state. Browsers fire storage events only in other
 * windows and only when the value changes; a null key means storage was cleared.
 * @param {function} onChange
 */
export function subscribe(onChange) {
  window.addEventListener('storage', function (event) {
    if (event.key === GAME_KEY || event.key === null) onChange();
  });
}

/**
 * Host-only UI state (board under review, typed text, sort, live lookup), kept apart so it never wakes the scoreboard.
 * @returns {object}
 */
export function loadUi() {
  try {
    return JSON.parse(localStorage.getItem(UI_KEY)) || {};
  } catch (err) {
    console.log('Could not read host UI state', err);
    return {};
  }
}

/**
 * Persist host UI state. Never throws; a failed write is logged.
 * @param {object} ui
 */
export function saveUi(ui) {
  try {
    setItem(UI_KEY, JSON.stringify(ui));
  } catch (err) {
    console.log('Could not save host UI state', err);
  }
}

function periodKey(period) {
  return period.from + '..' + period.to;
}

function boardKey(title, period) {
  return BOARD_PREFIX + periodKey(period) + ':' + title;
}

/**
 * Cached board for a page title and pageview period, built under the current rules, or null.
 * @param {string} title canonical or user-entered page title
 * @param {{from: string, to: string}} period
 * @returns {object|null}
 */
export function getBoard(title, period) {
  try {
    return JSON.parse(localStorage.getItem(boardKey(title, period)));
  } catch (err) {
    console.log('Could not read cached board', err);
    return null;
  }
}

/**
 * Cache a finished board under its title, period, and the current rules. Never throws; a board that does not fit
 * even after cached boards are cleared is logged and skipped.
 * @param {object} board {title, period, items, dropped}
 */
export function putBoard(board) {
  try {
    setItem(boardKey(board.title, board.period), JSON.stringify(board));
  } catch (err) {
    console.log('Could not cache board', err);
  }
}
