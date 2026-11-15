/* BlaulichtCMS Bridge: Banner nach Start/Ende auch in zwischengespeicherten Seiten ein-/ausblenden. */
(function () {
  function update() {
    var now = Math.floor(Date.now() / 1000);
    var list = document.querySelectorAll('[data-bcb-start]');
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      var active = now >= +el.getAttribute('data-bcb-start') && now < +el.getAttribute('data-bcb-end');
      if (active) el.removeAttribute('hidden');
      else el.setAttribute('hidden', '');
    }
  }
  update();
  setInterval(update, 30000);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) update();
  });
})();
