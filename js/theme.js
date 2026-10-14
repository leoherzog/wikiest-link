// Host console color scheme: auto, light or dark, remembered per browser. Pico follows the OS setting when
// <html> has no data-theme. This is a classic blocking script in <head> so the stored theme applies before first paint.

(function () {
  const KEY = 'wikiest-link:theme';
  const NEXT = { auto: 'light', light: 'dark', dark: 'auto' };
  const root = document.documentElement;

  function current() {
    return root.dataset.theme || 'auto';
  }

  function apply(theme) {
    if (theme === 'auto') delete root.dataset.theme;
    else root.dataset.theme = theme;
  }

  // Storage throws in some private windows, so the theme falls back to auto and the choice lasts only this page.
  function read() {
    try {
      return localStorage.getItem(KEY);
    } catch (err) {
      console.log('Could not read theme', err);
      return null;
    }
  }

  function write(theme) {
    try {
      if (theme === 'auto') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, theme);
    } catch (err) {
      console.log('Could not save theme', err);
    }
  }

  function label(button) {
    const text = 'Theme: ' + current();
    button.setAttribute('aria-label', text);
    button.title = text;
  }

  const saved = read();
  apply(saved === 'light' || saved === 'dark' ? saved : 'auto');

  document.addEventListener('DOMContentLoaded', function () {
    const button = document.getElementById('theme');
    label(button);
    button.addEventListener('click', function () {
      const theme = NEXT[current()];
      apply(theme);
      write(theme);
      label(button);
    });
  });
})();
