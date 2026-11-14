/**
 * LifeLink-Block im Editor. Reines ES5 mit den wp.*-Globals, kein Build-Schritt.
 * Die Ausgabe im Frontend erfolgt serverseitig (render.php).
 */
(function (blocks, element, blockEditor, components, i18n) {
	'use strict';

	var el = element.createElement;
	var __ = i18n.__;

	blocks.registerBlockType('lifelink/banners', {
		edit: function () {
			var blockProps = blockEditor.useBlockProps ? blockEditor.useBlockProps() : {};
			return el(
				'div',
				blockProps,
				el(components.Placeholder, {
					icon: 'megaphone',
					label: __('LifeLink-Hinweise', 'lifelink'),
					instructions: __('Hier erscheinen auf der Website die aktiven Hinweis-Banner aus LifeLink für die jeweilige Seite. Sind keine Banner aktiv, wird nichts angezeigt.', 'lifelink')
				})
			);
		},
		save: function () {
			return null;
		}
	});
})(window.wp.blocks, window.wp.element, window.wp.blockEditor, window.wp.components, window.wp.i18n);
