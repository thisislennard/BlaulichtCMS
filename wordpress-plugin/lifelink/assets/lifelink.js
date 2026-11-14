/**
 * LifeLink – Banner im Browser aktuell halten.
 *
 * - Entfernt abgelaufene Banner (data-lifelink-ends) auch aus zwischengespeichertem HTML.
 * - Lädt optional aktive Banner vom öffentlichen Endpunkt nach.
 * - Kündigt Änderungen über eine aria-live-Region an.
 *
 * Reines ES5, keine Abhängigkeiten.
 */
(function () {
	'use strict';

	var cfg = window.lifelinkBanners || {};
	var i18n = cfg.i18n || {};
	var labels = cfg.labels || {};
	var COLORS = ['rot', 'orange', 'gelb', 'blau', 'gruen', 'neutral'];
	var PRIORITIES = ['niedrig', 'normal', 'hoch'];
	var MAX_TIMEOUT = 2147483647;
	var live = null;
	var pruneTimer = null;

	function indexOf(list, value) {
		for (var i = 0; i < list.length; i++) {
			if (list[i] === value) {
				return i;
			}
		}
		return -1;
	}

	function ensureLive() {
		if (live) {
			return live;
		}
		live = document.createElement('div');
		live.className = 'lifelink-visually-hidden';
		live.setAttribute('aria-live', 'polite');
		live.setAttribute('aria-atomic', 'true');
		document.body.appendChild(live);
		return live;
	}

	function announce(message) {
		if (!message) {
			return;
		}
		var region = ensureLive();
		region.textContent = '';
		window.setTimeout(function () {
			region.textContent = message;
		}, 150);
	}

	function containers() {
		return document.querySelectorAll('.lifelink-banners[data-lifelink-context]');
	}

	function bannersOf(container) {
		var result = [];
		var children = container.children;
		for (var i = 0; i < children.length; i++) {
			if ((' ' + children[i].className + ' ').indexOf(' lifelink-banner ') !== -1) {
				result.push(children[i]);
			}
		}
		return result;
	}

	function updateVisibility(container) {
		if (bannersOf(container).length > 0) {
			container.removeAttribute('hidden');
		} else {
			container.setAttribute('hidden', '');
		}
	}

	function parseTime(value) {
		if (!value) {
			return NaN;
		}
		return Date.parse(value);
	}

	/* Abgelaufene Banner entfernen. */
	function prune() {
		var now = Date.now();
		var removed = 0;
		var next = Infinity;
		var list = containers();

		for (var c = 0; c < list.length; c++) {
			var banners = bannersOf(list[c]);
			for (var b = 0; b < banners.length; b++) {
				var ends = parseTime(banners[b].getAttribute('data-lifelink-ends'));
				if (isNaN(ends)) {
					continue;
				}
				if (ends <= now) {
					banners[b].parentNode.removeChild(banners[b]);
					removed++;
				} else if (ends < next) {
					next = ends;
				}
			}
			updateVisibility(list[c]);
		}

		if (removed === 1) {
			announce(i18n.expiredOne);
		} else if (removed > 1) {
			announce(String(i18n.expiredMany || '').replace('%d', String(removed)));
		}

		if (pruneTimer) {
			window.clearTimeout(pruneTimer);
			pruneTimer = null;
		}
		if (next !== Infinity) {
			pruneTimer = window.setTimeout(prune, Math.min(next - now + 500, MAX_TIMEOUT));
		}
	}

	/* Ein Banner wie der PHP-Renderer aufbauen (nur textContent, kein innerHTML). */
	function buildBanner(data) {
		var color = indexOf(COLORS, data.color) !== -1 ? data.color : 'neutral';
		var priority = indexOf(PRIORITIES, data.priority) !== -1 ? data.priority : 'normal';

		var banner = document.createElement('div');
		banner.className = 'lifelink-banner lifelink-banner--' + color + ' lifelink-banner--prio-' + priority;
		banner.setAttribute('role', priority === 'hoch' ? 'alert' : 'status');
		banner.setAttribute('data-lifelink-id', String(data.external_id || ''));
		banner.setAttribute('data-lifelink-ends', data.ends_at ? String(data.ends_at) : '');

		var inner = document.createElement('div');
		inner.className = 'lifelink-banner__inner';

		var label = document.createElement('span');
		label.className = 'lifelink-banner__label';
		label.appendChild(document.createTextNode(String(data.label || labels[color] || '')));
		var sep = document.createElement('span');
		sep.className = 'lifelink-visually-hidden';
		sep.appendChild(document.createTextNode(': '));
		label.appendChild(sep);
		inner.appendChild(label);

		var content = document.createElement('div');
		content.className = 'lifelink-banner__content';

		var title = document.createElement('strong');
		title.className = 'lifelink-banner__title';
		title.appendChild(document.createTextNode(String(data.title || '')));
		content.appendChild(title);

		if (data.text) {
			var text = document.createElement('p');
			text.className = 'lifelink-banner__text';
			text.appendChild(document.createTextNode(String(data.text)));
			content.appendChild(text);
		}

		if (data.link_url && /^https?:\/\//i.test(String(data.link_url))) {
			var link = document.createElement('a');
			link.className = 'lifelink-banner__link';
			link.setAttribute('href', String(data.link_url));
			link.appendChild(document.createTextNode(String(data.link_text || i18n.linkText || '')));
			content.appendChild(link);
		}

		inner.appendChild(content);
		banner.appendChild(inner);
		return banner;
	}

	function signature(el) {
		var link = el.querySelector('.lifelink-banner__link');
		return [
			el.getAttribute('data-lifelink-id') || '',
			el.className.replace(/\s*lifelink-banner--new/g, ''),
			el.getAttribute('data-lifelink-ends') || '',
			link ? link.getAttribute('href') : '',
			el.textContent
		].join('\u0001');
	}

	function isCurrent(data, now) {
		var starts = parseTime(data.starts_at);
		var ends = parseTime(data.ends_at);
		return (isNaN(starts) || starts <= now) && (isNaN(ends) || ends > now);
	}

	function apply(container, list) {
		var now = Date.now();
		var fresh = [];
		for (var i = 0; i < list.length; i++) {
			if (list[i] && isCurrent(list[i], now)) {
				fresh.push(buildBanner(list[i]));
			}
		}

		var current = bannersOf(container);
		var changed = current.length !== fresh.length;
		for (var j = 0; !changed && j < fresh.length; j++) {
			changed = signature(current[j]) !== signature(fresh[j]);
		}
		if (!changed) {
			return false;
		}

		var known = {};
		for (var k = 0; k < current.length; k++) {
			known[signature(current[k])] = true;
			container.removeChild(current[k]);
		}
		for (var f = 0; f < fresh.length; f++) {
			if (!known[signature(fresh[f])]) {
				fresh[f].className += ' lifelink-banner--new';
			}
			container.appendChild(fresh[f]);
		}
		updateVisibility(container);
		return true;
	}

	function refresh() {
		if (!cfg.refresh || !cfg.endpoint || !window.fetch) {
			return;
		}
		var list = containers();
		var byContext = {};
		for (var i = 0; i < list.length; i++) {
			var ctx = list[i].getAttribute('data-lifelink-context') || 'all';
			(byContext[ctx] = byContext[ctx] || []).push(list[i]);
		}

		Object.keys(byContext).forEach(function (ctx) {
			var url = cfg.endpoint + (cfg.endpoint.indexOf('?') === -1 ? '?' : '&') + 'page=' + encodeURIComponent(ctx);
			window.fetch(url, { credentials: 'omit', headers: { Accept: 'application/json' } })
				.then(function (response) {
					return response.ok ? response.json() : null;
				})
				.then(function (data) {
					if (!data || !data.banners || typeof data.banners.length !== 'number') {
						return;
					}
					var changed = false;
					byContext[ctx].forEach(function (container) {
						changed = apply(container, data.banners) || changed;
					});
					if (changed) {
						announce(i18n.updated);
						prune();
					}
				})
				['catch'](function () {
					/* Fehler beim Nachladen lassen die vorhandene Anzeige unverändert. */
				});
		});
	}

	function init() {
		if (!containers().length) {
			return;
		}
		ensureLive();
		prune();
		window.setInterval(prune, 30000);

		if (cfg.refresh) {
			refresh();
			var interval = Math.max(30, parseInt(cfg.interval, 10) || 120) * 1000;
			window.setInterval(function () {
				if (!document.hidden) {
					refresh();
				}
			}, interval);
		}

		document.addEventListener('visibilitychange', function () {
			if (!document.hidden) {
				prune();
				if (cfg.refresh) {
					refresh();
				}
			}
		});
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}
})();
