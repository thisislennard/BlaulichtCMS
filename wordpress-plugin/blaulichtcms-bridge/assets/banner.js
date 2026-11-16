/* BlaulichtCMS Bridge: Banner nach Start/Ende auch in zwischengespeicherten Seiten ein-/ausblenden; Popups (#186). */
(function () {
  var STORE = 'bcb-dismissed';
  var now = function () {
    return Math.floor(Date.now() / 1000);
  };
  function update() {
    var t = now();
    var list = document.querySelectorAll('[data-bcb-start]');
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      var active = t >= +el.getAttribute('data-bcb-start') && t < +el.getAttribute('data-bcb-end');
      if (active) el.removeAttribute('hidden');
      else el.setAttribute('hidden', '');
    }
  }

  /* Geschlossene Popups je Hinweis und Fassung merken (ohne Speicher, z. B. privates Fenster: nur für diese Seite). */
  var memory = [];
  function dismissed() {
    try {
      var v = JSON.parse(window.localStorage.getItem(STORE) || '[]');
      return Array.isArray(v) ? v : [];
    } catch (e) {
      return memory;
    }
  }
  function remember(key) {
    var list = dismissed().filter(function (k) {
      return k !== key;
    });
    list.push(key);
    memory = list.slice(-50);
    try {
      window.localStorage.setItem(STORE, JSON.stringify(memory));
    } catch (e) {
      /* Speicher nicht verfügbar */
    }
  }

  var open = null;
  function nextPopup() {
    if (open) return;
    var t = now();
    var done = dismissed();
    var list = document.querySelectorAll('dialog[data-bcb-popup]');
    for (var i = 0; i < list.length; i++) {
      var d = list[i];
      var key = d.getAttribute('data-bcb-key');
      if (t < +d.getAttribute('data-bcb-pstart') || t >= +d.getAttribute('data-bcb-pend') || done.indexOf(key) !== -1) continue;
      show(d, key);
      return;
    }
  }
  function show(d, key) {
    open = d;
    var trigger = document.activeElement;
    var closed = false;
    function close() {
      if (closed) return;
      closed = true;
      remember(key);
      if (d.open) d.close();
      open = null;
      if (trigger && typeof trigger.focus === 'function' && document.contains(trigger)) trigger.focus();
      nextPopup();
    }
    var buttons = d.querySelectorAll('[data-bcb-close]');
    for (var i = 0; i < buttons.length; i++) buttons[i].addEventListener('click', close);
    /* Esc (cancel) schließt und merkt sich den Hinweis ebenso */
    d.addEventListener('close', close);
    if (typeof d.showModal === 'function') {
      d.showModal(); /* modal: Hintergrund inert, Fokus bleibt im Dialog, Esc schließt */
    } else {
      d.setAttribute('open', '');
      var ok = d.querySelector('.bcb-popup-ok');
      if (ok) ok.focus();
      d.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') close();
      });
    }
  }

  function tick() {
    update();
    nextPopup();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tick);
  else tick();
  setInterval(tick, 30000);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) tick();
  });
})();
