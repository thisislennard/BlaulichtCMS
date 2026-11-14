/* Blöcke der LifeLink Bridge (ohne Build-Schritt). Inhalt wird serverseitig gerendert. */
(function (wp) {
  var el = wp.element.createElement;
  var SSR = wp.serverSideRender;
  var useBlockProps = wp.blockEditor.useBlockProps;
  wp.blocks.registerBlockType('lifelink/banner', {
    title: 'LifeLink: Hinweise',
    icon: 'megaphone',
    category: 'widgets',
    edit: function () {
      return el('div', useBlockProps(), el(SSR, { block: 'lifelink/banner' }), el('p', { style: { fontSize: '12px', opacity: 0.7 } }, 'Zeigt aktive Hinweise aus LifeLink.'));
    },
    save: function () {
      return null;
    },
  });
  wp.blocks.registerBlockType('lifelink/incidents', {
    title: 'LifeLink: Einsatzübersicht',
    icon: 'list-view',
    category: 'widgets',
    attributes: { anzahl: { type: 'number', default: 10 } },
    edit: function (props) {
      return el('div', useBlockProps(), el(SSR, { block: 'lifelink/incidents', attributes: props.attributes }));
    },
    save: function () {
      return null;
    },
  });
})(window.wp);
