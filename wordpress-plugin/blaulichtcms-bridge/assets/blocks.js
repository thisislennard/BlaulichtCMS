/* Blöcke der BlaulichtCMS Bridge (ohne Build-Schritt). Inhalt wird serverseitig gerendert. */
(function (wp) {
  var el = wp.element.createElement;
  var SSR = wp.serverSideRender;
  var useBlockProps = wp.blockEditor.useBlockProps;
  wp.blocks.registerBlockType('blaulichtcms/banner', {
    title: 'BlaulichtCMS: Hinweise',
    icon: 'megaphone',
    category: 'widgets',
    edit: function () {
      return el('div', useBlockProps(), el(SSR, { block: 'blaulichtcms/banner' }), el('p', { style: { fontSize: '12px', opacity: 0.7 } }, 'Zeigt aktive Hinweise aus BlaulichtCMS.'));
    },
    save: function () {
      return null;
    },
  });
  wp.blocks.registerBlockType('blaulichtcms/incidents', {
    title: 'BlaulichtCMS: Einsatzübersicht',
    icon: 'list-view',
    category: 'widgets',
    attributes: { anzahl: { type: 'number', default: 10 } },
    edit: function (props) {
      return el('div', useBlockProps(), el(SSR, { block: 'blaulichtcms/incidents', attributes: props.attributes }));
    },
    save: function () {
      return null;
    },
  });
})(window.wp);
