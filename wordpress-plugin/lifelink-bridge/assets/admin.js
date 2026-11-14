/**
 * LifeLink – Admin-Seite: Kopieren-Knöpfe und Sicherheitsabfragen. Reines ES5.
 */
(function () {
	'use strict';

	var strings = window.lifelinkAdmin || {};

	function status(message) {
		var el = document.querySelector('.lifelink-copy-status');
		if (el) {
			el.textContent = message;
		}
	}

	function fallbackCopy(input) {
		input.focus();
		input.select();
		try {
			return document.execCommand('copy');
		} catch (e) {
			return false;
		}
	}

	document.addEventListener('click', function (event) {
		var target = event.target;
		if (!target || !target.getAttribute) {
			return;
		}

		var copyId = target.getAttribute('data-lifelink-copy');
		if (copyId) {
			var input = document.getElementById(copyId);
			if (!input) {
				return;
			}
			if (navigator.clipboard && window.isSecureContext) {
				navigator.clipboard.writeText(input.value).then(function () {
					status(strings.copied);
				}, function () {
					status(fallbackCopy(input) ? strings.copied : strings.copyFailed);
				});
			} else {
				status(fallbackCopy(input) ? strings.copied : strings.copyFailed);
			}
			return;
		}

		var confirmText = target.getAttribute('data-lifelink-confirm');
		if (confirmText && !window.confirm(confirmText)) {
			event.preventDefault();
		}
	});
})();
