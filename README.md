# The Wikiest Link

A host console and pop-out scoreboard for a Wikipedia pageviews game. Each round's category is an English Wikipedia page. Players name things that fit it, and each answer scores by its share of pageviews over the last twelve months. It is a static site with no build step and no backend.

## Running locally

Serve the folder over HTTP, because browsers refuse to load ES modules from `file://`.

```sh
uv run python -m http.server 8000
# or: python3 -m http.server 8000
```

Open http://localhost:8000/ for the host console. "Start game" opens the scoreboard in a popup named `wikiest-link-scoreboard`, which is the window to screen-share. If the browser blocks the popup, use the "Open scoreboard" button in the header.

## Deploying

Publish the repository root on any static host. On GitHub Pages, deploy from your branch's `/ (root)` folder. On Cloudflare Pages, use no framework preset, no build command, and `/` as the output directory, or run `npx wrangler pages deploy . --project-name wikiest-link`.

Cloudflare Pages applies the Content Security Policy in `_headers`. GitHub Pages and local servers ignore the file, so a violation shows up only once deployed: the policy blocks inline scripts, and any new origin must be added to it. It allows inline styles for the `<style>` element Font Awesome injects and for Wikipedia's HTML, which the parsed copy checks against the page's policy. It allows `data:` images because Pico draws its checkboxes and select chevrons that way.

Link previews and search engines need absolute URLs, so the host page's canonical link, Open Graph tags and structured data, along with `robots.txt` and `sitemap.xml`, name `https://wikiestlink.spitball.show/`. Change all of them if the site moves. The scoreboard carries `noindex`, since it shows nothing without the host's game.

## How a game runs

1. Press "Begin game" on the splash screen, then "Start new game" on the welcome page, which explains the game to first-time visitors and search engines. Add up to six players, reorder them, and press "Start game".
2. Search for a category page or paste its URL to build its board. Finished boards are cached per title and twelve-month period, so rebuilding one is instant.
3. Review the board, pick Market Share or Niche Market, mark the final round, and press "Start round". It stays disabled until a checked item has pageviews.
4. Type what each player says. Enter takes the top board match, and "Search Wikipedia" looks up anything off the board for you to rule on; Enter does the same when nothing on the board matches. "Miss" records 0, "Undo last" reverses the latest pick, and a status line under the answer box reads back the last pick and who is up. Click a player's name to give them the next answer out of turn.
5. End the round, optionally show the reveal on the scoreboard, and move on. "End game" shows final standings.

Settings sets the picks each player makes per round and the turn order, both applying from the next round. "New game" clears rounds and scores and returns to the lobby, keeping the players and settings. The theme button in the header cycles the host console through auto, light and dark, where auto follows the system setting. The scoreboard always uses Pico's dark theme.

The scoreboard never shows the board or would-be points, and unpicked answers appear only in the reveal. A player's pick rows shrink to fit their card, and past a minimum size the oldest clip so the newest stay visible.

## Which links make the board

The first link to an article in each list item counts as an entry, and so does the first in each table row's item column. The item column is the one headed Name or Title, or else the column holding most rows' first link. Only tables with a header cell supply entries, and lists and tables inside infoboxes, galleries, and figures supply none. These rules work the same on any list page.

Some links never reach the board. Everything after the first end-matter heading, such as See also, References, or External links, is skipped, as are links in navboxes, sidebars, hatnotes, reference lists, and maintenance or portal boxes. Red links, links back to the page, and links outside the article namespace are skipped too.

The app then compares every remaining link's Wikipedia categories with the categories the page's own entries share. Entries that look out of place, such as a country in a list of physicists, start unchecked, as do disambiguation pages and entries whose pageviews failed to load. Related links stay as unchecked extras. Unrelated links, such as actors on a list of musicals, are left off the board, and live lookup still finds them during play. Filtering needs at least five entries that are not disambiguation pages, and is skipped when those entries share no categories.

## Scoring

Share is an answer's pageviews over the twelve full calendar months before the board was built, divided by those of the most-viewed valid board item. That item is locked when the round starts. Market Share scores `min(100, round(100 × share))` and Niche Market scores `max(0, 100 − round(100 × share))`. Misses, answers that don't fit, and repeats score 0 in both. Equal totals are split by score in the last round marked final, or in the last round played when none is.

Snake order reverses direction each pass and linear order repeats it, and both start one seat later each round. With four players and two picks each, snake runs 1-2-3-4-4-3-2-1 and linear runs 1-2-3-4-1-2-3-4, and round 2 starts with player 2. Catch-up order snakes from the lowest running total upward, with ties in seating order, so its first round matches snake.

## Data and state

All data comes from the browser: the MediaWiki Action API on en.wikipedia.org and the Wikimedia pageviews API on wikimedia.org. Requests to en.wikipedia.org carry an `Api-User-Agent` header identifying the app. Requests to wikimedia.org omit it, because that host answers CORS preflight requests with HTTP 405 and a custom header would trigger one.

Every request from the host shares a budget of 180 per rolling minute, below Wikimedia's limit of 200 for unauthenticated browsers. A build spends one request per article on pageviews, on top of those that fetch the page and resolve its links, and category searches draw on the same budget. Builds that fit in about 180 requests finish in seconds; larger ones slow to three requests a second, so build them before recording.

Game state lives in `localStorage` under `wikiest-link:v1`, and host UI state under `wikiest-link:v1:ui` so that typing never wakes the scoreboard. Each cached board has its own key, `wikiest-link:board:r<rules>:<from>..<to>:<title>`, so bump `RULES` in `js/wiki.js` whenever the board rules change. At startup the host deletes boards from other periods or rules and game and UI keys from older versions, but keeps newer ones so a stale tab cannot wipe a newer deploy's game. When storage fills, cached boards go first. The host's theme choice lives under `wikiest-link:theme`, which cleanup leaves alone.

The host console is the only writer. The scoreboard re-renders on `storage` events, which browsers fire only in other windows. Refreshing either window restores the game, and the host resumes an interrupted build or lookup.

## Files

| File | Role |
| --- | --- |
| `index.html`, `js/host.js` | Host console |
| `js/theme.js` | Host theme button; a blocking script in `<head>` so the saved theme applies before first paint |
| `scoreboard.html`, `js/scoreboard.js` | Screen-shared scoreboard |
| `js/store.js` | State, persistence, board cache, cross-window sync |
| `js/wiki.js` | Wikipedia and pageviews client, board building |
| `js/scoring.js` | Round scoring, turn order, standings |
| `js/dom.js` | Element lookup, number formatting, icons, and round type copy shared by both pages |
| `css/app.css` | Scoreboard stage, type scaling, fonts and mark colors; the host's few rules sit in `index.html` |
| `favicon.svg` | Tab icon: Font Awesome's `link` in Pico's orange-550, or orange-350 in dark mode, as literal hex because an SVG image cannot read CSS variables |
| `apple-touch-icon.png` | Home screen icon: the favicon's link on Pico's dark background, opaque because iOS fills transparency with black |
| `og-image.png` | 1200×630 link preview card in the scoreboard's dark style |
| `robots.txt`, `sitemap.xml` | Crawler rules and the one-page sitemap |
| `_headers` | Content Security Policy for Cloudflare Pages |

Both pages load Pico CSS 2.1.1's orange theme, `pico.orange.min.css`, from jsDelivr with a Subresource Integrity hash, so a version change means updating `integrity` in both pages. They load the Acme and Permanent Marker fonts from Fontsource on jsDelivr the same way, hashing each package's `index.css`, because jsDelivr minifies `.min.css` files on request and their hashes can change. Headings and the scoreboard's labels, names and scores use Acme, and the host's wordmark and the scoreboard's title use Permanent Marker. The scoreboard also loads Pico's color palette, `pico.colors.min.css`, from the floating `@2` tag with no integrity hash, and takes its amber and violet mark colors from it. They also load Font Awesome Free 7 from jsDelivr. Icons are `<span class="fa-solid fa-…">` elements, built in scripts with `icon()` from `js/dom.js`, and Font Awesome's script swaps each for an inline SVG, including spans added later.

## License

The MIT License (MIT)

Copyright © 2026 Leo Herzog

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## About Me

<a href="https://herzog.tech/" target="_blank">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://herzog.tech/signature/link-light.svg.png">
    <source media="(prefers-color-scheme: light)" srcset="https://herzog.tech/signature/link.svg.png">
    <img src="https://herzog.tech/signature/link.svg.png" width="32px">
  </picture>
</a>
<a href="https://mastodon.social/@herzog" target="_blank">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://herzog.tech/signature/mastodon-light.svg.png">
    <source media="(prefers-color-scheme: light)" srcset="https://herzog.tech/signature/mastodon.svg.png">
    <img src="https://herzog.tech/signature/mastodon.svg.png" width="32px">
  </picture>
</a>
<a href="https://github.com/leoherzog" target="_blank">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://herzog.tech/signature/github-light.svg.png">
    <source media="(prefers-color-scheme: light)" srcset="https://herzog.tech/signature/github.svg.png">
    <img src="https://herzog.tech/signature/github.svg.png" width="32px">
  </picture>
</a>
<a href="https://keybase.io/leoherzog" target="_blank">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://herzog.tech/signature/keybase-light.svg.png">
    <source media="(prefers-color-scheme: light)" srcset="https://herzog.tech/signature/keybase.svg.png">
    <img src="https://herzog.tech/signature/keybase.svg.png" width="32px">
  </picture>
</a>
<a href="https://www.linkedin.com/in/leoherzog" target="_blank">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://herzog.tech/signature/linkedin-light.svg.png">
    <source media="(prefers-color-scheme: light)" srcset="https://herzog.tech/signature/linkedin.svg.png">
    <img src="https://herzog.tech/signature/linkedin.svg.png" width="32px">
  </picture>
</a>
<a href="https://hope.edu/directory/people/herzog-leo/" target="_blank">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://herzog.tech/signature/anchor-light.svg.png">
    <source media="(prefers-color-scheme: light)" srcset="https://herzog.tech/signature/anchor.svg.png">
    <img src="https://herzog.tech/signature/anchor.svg.png" width="32px">
  </picture>
</a>
<br />
<a href="https://herzog.tech/$" target="_blank">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://herzog.tech/signature/mug-tea-saucer-solid-light.svg.png">
    <source media="(prefers-color-scheme: light)" srcset="https://herzog.tech/signature/mug-tea-saucer-solid.svg.png">
    <img src="https://herzog.tech/signature/mug-tea-saucer-solid.svg.png" alt="Buy Me A Tea" width="32px">
  </picture>
  Found this helpful? Buy me a tea!
</a>
