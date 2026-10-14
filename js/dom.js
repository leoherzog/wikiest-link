// DOM helpers and view copy shared by the host console and the scoreboard:
// element lookup, number formatting, Font Awesome icons, and round type labels.

export const fmt = new Intl.NumberFormat('en-US');

// Icons are Font Awesome names.
export const ROUND_TYPES = {
  market: {
    name: 'Market Share', goal: 'most views wins', icon: 'arrow-trend-up',
    flash: 'MARKET LEADER!', flashIcon: 'crown', reveal: 'Most-viewed answers nobody picked'
  },
  niche: {
    name: 'Niche Market', goal: 'fewest views wins', icon: 'arrow-trend-down',
    flash: 'NICHE!', flashIcon: 'gem', reveal: 'Least-viewed answers nobody picked'
  }
};

export function $(id) {
  return document.getElementById(id);
}

/**
 * A decorative Font Awesome icon; the Font Awesome script swaps the span for an inline SVG.
 * @param {string} name Font Awesome name without the fa- prefix
 * @returns {HTMLSpanElement}
 */
export function icon(name) {
  const span = document.createElement('span');
  span.className = 'fa-solid fa-' + name;
  span.setAttribute('aria-hidden', 'true');
  return span;
}
