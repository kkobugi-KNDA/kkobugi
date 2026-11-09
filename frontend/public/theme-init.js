(() => {
  let theme = 'light';
  try {
    if (localStorage.getItem('kkobugi:theme') === 'dark') theme = 'dark';
  } catch {}
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').content =
    theme === 'dark' ? '#0d1522' : '#f2f4f7';
})();
