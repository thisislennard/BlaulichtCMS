/* BlaulichtCMS Bridge – Kopieren-Knöpfe im Reiter „Shortcodes“ (#227). Nur auf dieser Admin-Seite geladen. */
(function () {
  'use strict';
  var status = document.querySelector('.bcl-sc-status');

  function announce(text) {
    if (!status) return;
    status.textContent = '';
    window.setTimeout(function () {
      status.textContent = text;
    }, 50);
  }

  // Rückfall ohne Clipboard-API (z. B. Admin über http://): Text in ein unsichtbares Feld, markieren, kopieren.
  function fallback(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (e) {
      ok = false;
    }
    document.body.removeChild(ta);
    return ok;
  }

  function done(btn, ok) {
    var label = btn.firstChild;
    var original = btn.getAttribute('data-label') || label.nodeValue;
    btn.setAttribute('data-label', original);
    label.nodeValue = ok ? 'Kopiert' : 'Bitte markieren und kopieren';
    announce(ok ? 'Shortcode kopiert.' : 'Kopieren nicht möglich. Bitte den Shortcode markieren und kopieren.');
    window.clearTimeout(btn._bclTimer);
    btn._bclTimer = window.setTimeout(function () {
      label.nodeValue = original;
    }, 2500);
  }

  document.addEventListener('click', function (ev) {
    var btn = ev.target.closest ? ev.target.closest('.bcl-sc-copy') : null;
    if (!btn) return;
    var code = document.getElementById(btn.getAttribute('data-copy'));
    if (!code) return;
    var text = code.textContent;
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(
        function () {
          done(btn, true);
        },
        function () {
          done(btn, fallback(text));
        }
      );
    } else {
      done(btn, fallback(text));
    }
  });
})();
