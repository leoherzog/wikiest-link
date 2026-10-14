// Browser client for the MediaWiki Action API and the Wikimedia pageviews API:
// category search, page link extraction, title resolution, pageviews, and board building.

const API = 'https://en.wikipedia.org/w/api.php';
const PAGEVIEWS = 'https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/';
const WIKI_BASE = 'https://en.wikipedia.org/wiki/';
const USER_AGENT = 'WikiestLink/1.0 (https://spitball.show; podcast@spitball.show)';
const RETRIES = 5;
const ATTEMPT_TIMEOUT_MS = 30000;
const BATCH = 50;
// Wikimedia's published limit for unauthenticated browser requests is 200 per minute across its sites and APIs;
// this leaves headroom.
const RATE_LIMIT = 180;
const RATE_WINDOW_MS = 60000;

// Links inside these never become candidates.
const SKIP = '.navbox, .vertical-navbox, .sidebar, .reflist, .references, sup.reference, .hatnote, ' +
  '.shortdescription, .ambox, .metadata, .sistersitebox, .portalbox';
// Candidate links. Parsoid gives self-links an href, which legacy markup omits.
const LINK = 'a[href]:not(.mw-selflink)';
// Regions whose rows and list items are not list entries, though their links are still candidates.
const NOT_ITEMS = '.infobox, .gallery, figure, .thumb';
const END_SECTIONS = ['see also', 'notes', 'references', 'citations', 'sources', 'bibliography',
  'further reading', 'external links'];
const NAME_HEADER = /\b(name|title)s?\b/i;
const NAMESPACE = /^(file|image|media|category|template|help|wikipedia|wp|portal|special|talk|user|module|draft|mediawiki|timedtext)( talk)?:/i;
// Typicality thresholds, as a share of the median item's typicality: items below the first start unchecked,
// other links below the second are left off the board. Lists with fewer items than the minimum are not filtered.
const OUTLIER_SCORE = 0.25;
const EXTRA_SCORE = 0.5;
const PROFILE_MIN_ITEMS = 5;

/** Board rules version; cached boards built under other rules are rebuilt. */
export const RULES = 3;

function sleep(ms, signal) {
  if (signal) signal.throwIfAborted();
  return new Promise(function (resolve, reject) {
    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    const timer = setTimeout(function () {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

const sent = [];

// Waits until one more request keeps this window under RATE_LIMIT per rolling minute, then records it.
async function throttle(signal) {
  for (;;) {
    const now = Date.now();
    while (sent.length && now - sent[0] >= RATE_WINDOW_MS) sent.shift();
    if (sent.length < RATE_LIMIT) {
      sent.push(now);
      return;
    }
    await sleep(RATE_WINDOW_MS - (now - sent[0]), signal);
  }
}

/**
 * Rate-limited fetch() that retries 429, 5xx, network errors, and attempts that time out, honoring Retry-After where
 * the host exposes it. Rejects with the caller's abort reason once `init.signal` aborts.
 * @param {string} url
 * @param {object} init
 * @returns {Promise<Response>}
 */
async function fetchRetry(url, init) {
  const signal = init.signal;
  for (let attempt = 0; ; attempt++) {
    await throttle(signal);
    // The timeout stays armed while the caller reads the body, so a stalled body rejects with TimeoutError, unretried.
    const timeout = AbortSignal.timeout(ATTEMPT_TIMEOUT_MS);
    const attemptSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res = null;
    let failure = null;
    try {
      res = await fetch(url, Object.assign({}, init, { signal: attemptSignal }));
    } catch (err) {
      if ((signal && signal.aborted) || attempt >= RETRIES) throw err;
      failure = err.name === 'TimeoutError' ? 'timed out' : 'network error';
    }
    if (res && ((res.status !== 429 && res.status < 500) || attempt >= RETRIES)) return res;
    // Doubling from 2 s, the retries span just over a minute: the window Wikimedia's limits are measured over.
    const retryAfter = res ? Number(res.headers.get('Retry-After')) : 0;
    const delay = retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** (attempt + 1);
    console.log('Retrying in ' + delay + ' ms (' + (res ? 'HTTP ' + res.status : failure) + '): ' + url);
    await sleep(delay, signal);
  }
}

async function api(params, signal) {
  const query = new URLSearchParams(Object.assign({}, params, { format: 'json', formatversion: '2', origin: '*' }));
  const res = await fetchRetry(API + '?' + query.toString(), {
    headers: { 'Api-User-Agent': USER_AGENT },
    signal: signal
  });
  if (!res.ok) throw new Error('Wikipedia API HTTP ' + res.status);
  const data = await res.json();
  if (data.error) throw new Error(data.error.info || data.error.code);
  return data;
}

/**
 * Article suggestions for a search box. Unresolved suggestions keep the typed text, so a datalist still shows them.
 * @param {string} text
 * @param {AbortSignal} [signal]
 * @param {boolean} [resolve] return redirect targets instead of the redirects themselves
 * @returns {Promise<Array<string>>} titles, canonical when `resolve` is set
 */
export async function search(text, signal, resolve) {
  const params = { action: 'opensearch', search: text, namespace: '0', limit: '10' };
  if (resolve) params.redirects = 'resolve';
  const data = await api(params, signal);
  return data[1] || [];
}

/**
 * Page title from a pasted English Wikipedia URL.
 * @param {string} text
 * @returns {string|null} null when `text` is not a URL; throws for non-English Wikipedia URLs
 */
export function titleFromUrl(text) {
  let url;
  try {
    url = new URL(text.trim());
  } catch (err) {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  if (!/^en\.(m\.)?wikipedia\.org$/.test(url.hostname)) {
    throw new Error('Only English Wikipedia URLs are supported.');
  }
  const title = urlTitle(url);
  if (!title) throw new Error('That URL does not point to a Wikipedia page.');
  return title;
}

// Page title in a URL's `title` parameter or /wiki/ path, with underscores as spaces; null when there is none.
function urlTitle(url) {
  let raw = url.searchParams.get('title');
  if (!raw && url.pathname.startsWith('/wiki/')) {
    try {
      raw = decodeURIComponent(url.pathname.slice(6));
    } catch (err) {
      return null;
    }
  }
  const title = raw ? raw.replace(/_/g, ' ').trim() : '';
  return title || null;
}

// Page title a link in parsed HTML points to, or null for links off en.wikipedia.org/wiki/. Hrefs resolve against
// the /wiki/ base because the parsers differ: '/wiki/X', './X', and absolute URLs all occur.
function titleFromHref(href) {
  let url;
  try {
    url = new URL(href, WIKI_BASE);
  } catch (err) {
    return null;
  }
  // Red links carry ?action=edit&redlink=1, and no plain article link has a query.
  if (url.hostname !== 'en.wikipedia.org' || url.search) return null;
  return urlTitle(url);
}

/**
 * Rendered HTML of a page, following redirects.
 * @param {string} title
 * @param {AbortSignal} [signal]
 * @returns {Promise<{title: string, html: string}>}
 */
async function fetchPage(title, signal) {
  const data = await api({
    action: 'parse',
    page: title,
    prop: 'text',
    redirects: '1',
    disableeditsection: '1',
    disabletoc: '1',
    disablelimitreport: '1'
  }, signal);
  return { title: data.parse.title, html: data.parse.text };
}

// First end-matter h2; everything after it is skipped. With edit links disabled, an h2's text is its heading.
function findCutoff(doc) {
  return Array.from(doc.querySelectorAll('h2')).find(function (h2) {
    return END_SECTIONS.includes(h2.textContent.replace(/\s+/g, ' ').trim().toLowerCase());
  });
}

// Cell grid that accounts for rowspan and colspan, so column indexes line up across rows.
function tableGrid(table) {
  const rows = Array.from(table.rows);
  const grid = rows.map(function () { return []; });
  rows.forEach(function (row, r) {
    let c = 0;
    Array.from(row.cells).forEach(function (cell) {
      while (grid[r][c]) c++;
      const rowSpan = Math.min(Math.max(1, cell.rowSpan || 1), rows.length - r);
      const colSpan = Math.max(1, cell.colSpan || 1);
      for (let i = 0; i < rowSpan; i++) {
        for (let j = 0; j < colSpan; j++) grid[r + i][c + j] = cell;
      }
      c += colSpan;
    });
  });
  return { rows: rows, grid: grid };
}

// Links in `container` that belong to `scope` rather than a nested table or list, and that can be articles:
// files, categories, and other namespaces never count as a row's item.
function articleLinks(container, scope) {
  return Array.from(container.querySelectorAll(LINK)).filter(function (a) {
    const title = titleFromHref(a.getAttribute('href'));
    return a.closest(scope.tagName) === scope && title && !NAMESPACE.test(title);
  });
}

function isHeaderRow(row) {
  return row.cells.length > 0 && Array.from(row.cells).every(function (cell) { return cell.tagName === 'TH'; });
}

// Leading all-th rows, or the first all-th row when the table does not open with one.
function headerRows(rows) {
  const lead = [];
  while (lead.length < rows.length && isHeaderRow(rows[lead.length])) lead.push(lead.length);
  if (lead.length) return lead;
  const first = rows.findIndex(isHeaderRow);
  return first === -1 ? [] : [first];
}

// Every grid column under the first Name/Title header cell, so a header spanning columns covers them all.
function nameColumns(grid, header) {
  for (let h = 0; h < header.length; h++) {
    const cells = grid[header[h]];
    const match = cells.find(function (cell) { return cell && NAME_HEADER.test(cell.textContent); });
    if (match) {
      const cols = [];
      cells.forEach(function (cell, c) { if (cell === match) cols.push(c); });
      return cols;
    }
  }
  return [];
}

// The column holding each row's first article link in most rows, so one unlinked row cannot borrow a neighbor.
function linkColumn(layout, start, table) {
  const counts = [];
  for (let r = start; r < layout.rows.length; r++) {
    if (isHeaderRow(layout.rows[r])) continue;
    const cells = layout.grid[r];
    for (let c = 0; c < cells.length; c++) {
      if (cells[c] && articleLinks(cells[c], table).length) {
        counts[c] = (counts[c] || 0) + 1;
        break;
      }
    }
  }
  let best = -1;
  counts.forEach(function (n, c) {
    if (best === -1 || n > counts[best]) best = c;
  });
  return best === -1 ? [] : [best];
}

// Maps each candidate item link to its group (one table row or list item). After resolution,
// the first link in a group that is an article becomes that group's default-valid item.
function itemGroups(doc) {
  const groups = new Map();
  let next = 0;

  doc.querySelectorAll('table').forEach(function (table) {
    if (table.closest(SKIP) || table.closest(NOT_ITEMS)) return;
    if (!table.querySelector('th')) return;
    const layout = tableGrid(table);
    const header = headerRows(layout.rows);
    const lastHeader = header.length ? header[header.length - 1] : -1;
    let itemCols = nameColumns(layout.grid, header);
    if (!itemCols.length) itemCols = linkColumn(layout, lastHeader + 1, table);
    const seenCells = new Set();
    layout.rows.forEach(function (row, r) {
      if (r <= lastHeader || isHeaderRow(row)) return;
      let links = [];
      itemCols.forEach(function (c) {
        const cell = layout.grid[r][c];
        if (!cell || seenCells.has(cell)) return;
        seenCells.add(cell);
        links = links.concat(articleLinks(cell, table));
      });
      if (!links.length) return;
      const group = next++;
      links.forEach(function (a) { groups.set(a, group); });
    });
  });

  doc.querySelectorAll('li').forEach(function (li) {
    if (li.closest(SKIP) || li.closest(NOT_ITEMS)) return;
    const cell = li.closest('td, th');
    if (cell && cell.closest('table').querySelector('th')) return;
    const group = next++;
    articleLinks(li, li).forEach(function (a) {
      if (!groups.has(a)) groups.set(a, group);
    });
  });

  return groups;
}

/**
 * Article-namespace candidate links from a page's HTML, in document order.
 * @param {string} html parse.text from the Action API
 * @returns {Array<{title: string, alias: string, group: number}>} group is -1 for non-item links
 */
function extractLinks(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const cutoff = findCutoff(doc);
  const groups = itemGroups(doc);
  const links = [];
  doc.querySelectorAll(LINK).forEach(function (a) {
    if (a.closest(SKIP)) return;
    if (cutoff && (cutoff.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING)) return;
    const title = titleFromHref(a.getAttribute('href'));
    if (!title) return;
    links.push({
      title: title,
      alias: a.textContent.replace(/\s+/g, ' ').trim(),
      group: groups.has(a) ? groups.get(a) : -1
    });
  });
  return links;
}

/**
 * Resolve titles to canonical article titles in batches of 50, following normalization and redirects.
 * @param {Array<string>} titles
 * @param {function(number, number)} [onProgress] called with (batches done, total batches)
 * @param {AbortSignal} [signal]
 * @returns {Promise<Map<string, {title: string, description: string, disambig: boolean, categories: Array<string>}|null>>}
 *   null for missing pages and non-article namespaces; categories exclude hidden maintenance categories
 */
async function resolveTitles(titles, onProgress, signal) {
  const unique = Array.from(new Set(titles));
  const result = new Map();
  const total = Math.ceil(unique.length / BATCH);
  for (let start = 0; start < unique.length; start += BATCH) {
    const batch = unique.slice(start, start + BATCH);
    const normalized = new Map();
    const redirects = new Map();
    const pages = new Map();
    let cont = {};
    while (cont) {
      const data = await api(Object.assign({
        action: 'query',
        titles: batch.join('|'),
        redirects: '1',
        prop: 'description|pageprops|categories',
        ppprop: 'disambiguation',
        clshow: '!hidden',
        cllimit: 'max'
      }, cont), signal);
      const q = data.query || {};
      (q.normalized || []).forEach(function (n) { normalized.set(n.from, n.to); });
      (q.redirects || []).forEach(function (r) { redirects.set(r.from, r.to); });
      (q.pages || []).forEach(function (p) {
        const prev = pages.get(p.title) || { categories: [] };
        pages.set(p.title, Object.assign(prev, p, {
          pageprops: Object.assign({}, prev.pageprops, p.pageprops),
          categories: prev.categories.concat((p.categories || []).map(function (c) { return c.title; }))
        }));
      });
      cont = data.continue || null;
    }
    batch.forEach(function (title) {
      let name = normalized.get(title) || title;
      for (let hops = 0; redirects.has(name) && hops < 5; hops++) name = redirects.get(name);
      const page = pages.get(name);
      if (!page || page.missing || page.invalid || page.ns !== 0) {
        result.set(title, null);
        return;
      }
      result.set(title, {
        title: page.title,
        description: page.description ?? '',
        disambig: Object.hasOwn(page.pageprops, 'disambiguation'),
        categories: page.categories
      });
    });
    if (onProgress) onProgress(start / BATCH + 1, total);
  }
  return result;
}

/**
 * User pageviews for one canonical article, summed over a period of whole months. A 404 means no data: 0 views.
 * @param {string} title canonical title
 * @param {{from: string, to: string}} period inclusive 'YYYY-MM' bounds
 * @param {AbortSignal} [signal]
 * @returns {Promise<{views: number, noData: boolean}>}
 */
async function fetchViews(title, period, signal) {
  const end = period.to.split('-').map(Number);
  const lastDay = new Date(Date.UTC(end[0], end[1], 0)).getUTCDate();
  // The API has no yearly granularity, so one monthly request spans the period and its months are summed.
  // The end timestamp is inclusive of days, not whole months, so it must be the final month's last day.
  const url = PAGEVIEWS + encodeURIComponent(title.replace(/ /g, '_')) + '/monthly/' +
    period.from.replace('-', '') + '0100/' + period.to.replace('-', '') + String(lastDay).padStart(2, '0') + '00';
  // wikimedia.org rejects CORS preflight (HTTP 405), so this request sends no Api-User-Agent header.
  const res = await fetchRetry(url, { signal: signal });
  if (res.status === 404) return { views: 0, noData: true };
  if (!res.ok) throw new Error('Pageviews HTTP ' + res.status + ' for ' + title);
  const data = await res.json();
  const months = data.items || [];
  if (!months.length) return { views: 0, noData: true };
  return { views: months.reduce(function (sum, m) { return sum + m.views; }, 0), noData: false };
}

function normKey(text) {
  return text.toLocaleLowerCase('en');
}

function addAlias(entry, alias) {
  if (!alias) return;
  const key = normKey(alias);
  if (key === normKey(entry.title)) return;
  if (entry.aliases.some(function (a) { return normKey(a) === key; })) return;
  entry.aliases.push(alias);
}

/**
 * Board entry for a resolved article.
 * @param {{title: string, description: string, disambig: boolean}} page
 * @returns {object}
 */
function newItem(page) {
  return {
    title: page.title,
    description: page.description,
    aliases: [],
    views: 0,
    noData: false,
    disambig: page.disambig,
    item: false,
    outlier: false,
    valid: false,
    offList: false
  };
}

// Words that start a category's qualifier: "Cocktails with beer", "Films directed by …", "Musicals set in …".
const QUALIFIER = /\s(of|in|by|from|with|for|on|about|at|to|based|set|featuring|starring|written|directed|produced|composed|released|published|established|disestablished|named|adapted|made)\s.*$/;

// A category's head noun, so "French desserts", "Cocktails with beer", and "1957 musicals" reduce to their type.
function categoryKey(name) {
  const words = name.replace(/^Category:/, '').toLowerCase().replace(QUALIFIER, '').trim().split(/\s+/);
  return words[words.length - 1];
}

/**
 * Keep the links that resemble the list's own items. A link's typicality sums, over its category heads, the share
 * of items carrying each head, and is compared with the median item's. Items far below it start unchecked as
 * outliers; other links below half of it are dropped.
 * @param {Array<object>} entries board entries with `item` flags and `categoryKeys`
 * @returns {Array<object>} entries to keep; all of them when the list is too small or its items share nothing
 */
function fitToItems(entries) {
  const seeds = entries.filter(function (e) { return e.item && !e.disambig; });
  if (seeds.length < PROFILE_MIN_ITEMS) return entries;
  const counts = new Map();
  seeds.forEach(function (e) {
    e.categoryKeys.forEach(function (key) { counts.set(key, (counts.get(key) ?? 0) + 1); });
  });
  function typicality(e) {
    return e.categoryKeys.reduce(function (sum, key) {
      const n = counts.get(key) ?? 0;
      return n >= 2 ? sum + n / seeds.length : sum;
    }, 0);
  }
  const scores = seeds.map(typicality).sort(function (a, b) { return a - b; });
  const median = scores[Math.floor(scores.length / 2)];
  if (!median) return entries;
  return entries.filter(function (e) {
    const ratio = typicality(e) / median;
    if (e.item) {
      e.outlier = ratio < OUTLIER_SCORE;
      return true;
    }
    return ratio >= EXTRA_SCORE;
  });
}

/**
 * Board candidates before pageviews: links resolved, deduped, flagged as items, and fitted to the list.
 * @param {{title: string, html: string}} page from fetchPage
 * @param {function(string, number, number)} onProgress (step label, done, total)
 * @param {AbortSignal} [signal]
 * @returns {Promise<{items: Array<object>, dropped: number}>}
 */
async function collectCandidates(page, onProgress, signal) {
  const links = extractLinks(page.html);
  console.log('Extracted ' + links.length + ' links from ' + page.title);
  const resolved = await resolveTitles(links.map(function (l) { return l.title; }), function (done, total) {
    onProgress('Resolving titles', done, total);
  }, signal);

  const byTitle = new Map();
  const claimedGroups = new Set();
  links.forEach(function (link) {
    const target = resolved.get(link.title);
    if (!target || target.title === page.title) return;
    let entry = byTitle.get(target.title);
    if (!entry) {
      entry = newItem(target);
      entry.categoryKeys = Array.from(new Set(target.categories.map(categoryKey)));
      byTitle.set(target.title, entry);
    }
    addAlias(entry, link.title);
    addAlias(entry, link.alias);
    if (link.group !== -1 && !claimedGroups.has(link.group)) {
      claimedGroups.add(link.group);
      entry.item = true;
    }
  });

  const all = Array.from(byTitle.values());
  const items = fitToItems(all);
  items.forEach(function (e) { delete e.categoryKeys; });
  console.log('Kept ' + items.length + ' of ' + all.length + ' candidates');
  return { items: items, dropped: all.length - items.length };
}

/**
 * Build a board: page HTML → links → canonical titles → pageviews (one request at a time).
 * @param {string} title page to build from
 * @param {{from: string, to: string}} period pageview months, inclusive
 * @param {function(string, number, number)} onProgress (step label, done, total)
 * @param {AbortSignal} [signal]
 * @param {function(string): object|null} [cached] returns a cached board for a canonical title, or null
 * @returns {Promise<{title: string, period: object, items: Array, dropped: number}>} the cached board on a hit
 */
export async function buildBoard(title, period, onProgress, signal, cached) {
  onProgress('Fetching page', 0, 0);
  const page = await fetchPage(title, signal);
  const hit = cached ? cached(page.title) : null;
  if (hit) return hit;

  const candidates = await collectCandidates(page, onProgress, signal);
  const items = candidates.items;
  for (let i = 0; i < items.length; i++) {
    onProgress('Pageviews', i, items.length);
    try {
      Object.assign(items[i], await fetchViews(items[i].title, period, signal));
    } catch (err) {
      if (signal && signal.aborted) throw err;
      console.log('Pageviews failed for ' + items[i].title, err);
      items[i].error = true;
      items[i].noData = true;
    }
  }
  onProgress('Pageviews', items.length, items.length);
  // Items whose views failed to load start unchecked so a false 0 cannot score.
  items.forEach(function (item) { item.valid = item.item && !item.outlier && !item.disambig && !item.error; });
  return { title: page.title, period: period, items: items, dropped: candidates.dropped };
}

/**
 * Resolve one title and fetch its pageviews, for live rulings during play.
 * @param {string} title
 * @param {{from: string, to: string}} period pageview months, inclusive
 * @param {AbortSignal} [signal]
 * @returns {Promise<object|null>} board entry, or null when it is not an article
 */
export async function lookup(title, period, signal) {
  const resolved = await resolveTitles([title], null, signal);
  const page = resolved.get(title);
  if (!page) return null;
  const entry = newItem(page);
  addAlias(entry, title);
  Object.assign(entry, await fetchViews(page.title, period, signal));
  return entry;
}
