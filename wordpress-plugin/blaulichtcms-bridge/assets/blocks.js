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

  // Einsatzliste und Jahresstatistik (#213): leere Felder = Vorgabe aus „Einstellungen → BlaulichtCMS Einsatzliste“
  var C = wp.components;
  var Inspector = wp.blockEditor.InspectorControls;
  function field(props, key, label, help, options) {
    var set = function (v) {
      var o = {};
      o[key] = v;
      props.setAttributes(o);
    };
    if (options) return el(C.SelectControl, { key: key, label: label, help: help, value: props.attributes[key] || '', options: options, onChange: set });
    return el(C.TextControl, { key: key, label: label, help: help, value: props.attributes[key] || '', onChange: set });
  }
  var STD = { label: 'Vorgabe der Einstellungen', value: '' };
  function attrs(keys) {
    var a = {};
    keys.forEach(function (k) {
      a[k] = { type: 'string', default: '' };
    });
    return a;
  }
  wp.blocks.registerBlockType('blaulichtcms/einsatzliste', {
    title: 'BlaulichtCMS: Einsatzliste',
    icon: 'list-view',
    category: 'widgets',
    attributes: attrs(['jahr', 'kategorie', 'spalten', 'sortierung', 'anzahl', 'filter', 'darstellung', 'gruppierung', 'detail', 'nur_besondere', 'titel']),
    edit: function (props) {
      return el(
        'div',
        useBlockProps(),
        el(
          Inspector,
          null,
          el(
            C.PanelBody,
            { title: 'Einsatzliste' },
            field(props, 'titel', 'Überschrift (optional)'),
            field(props, 'darstellung', 'Darstellung', null, [STD, { label: 'Tabelle', value: 'tabelle' }, { label: 'Karten', value: 'karten' }]),
            field(props, 'gruppierung', 'Gliederung', null, [STD, { label: 'Eine Liste', value: 'keine' }, { label: 'Je Jahr aufklappbar', value: 'jahr' }]),
            field(props, 'jahr', 'Jahr', 'aktuell, alle oder eine Jahreszahl'),
            field(props, 'kategorie', 'Nur Kategorie', 'z. B. Brand'),
            field(props, 'spalten', 'Spalten', 'nr, datum, stichwort, bedeutung, kategorie, meldung, ort, fahrzeuge, kraefte, bild'),
            field(props, 'sortierung', 'Sortierung', null, [STD, { label: 'Neueste zuerst', value: 'absteigend' }, { label: 'Älteste zuerst', value: 'aufsteigend' }]),
            field(props, 'anzahl', 'Einträge je Seite', '0 = alle'),
            field(props, 'filter', 'Filter', 'jahr, kategorie oder aus'),
            field(props, 'detail', 'Detailseiten verlinken', null, [STD, { label: 'Ja', value: 'ja' }, { label: 'Nein', value: 'nein' }]),
            field(props, 'nur_besondere', 'Nur besondere Einsätze', null, [STD, { label: 'Ja', value: 'ja' }, { label: 'Nein', value: 'nein' }])
          )
        ),
        el(SSR, { block: 'blaulichtcms/einsatzliste', attributes: props.attributes })
      );
    },
    save: function () {
      return null;
    },
  });
  wp.blocks.registerBlockType('blaulichtcms/einsatzstatistik', {
    title: 'BlaulichtCMS: Einsatzstatistik',
    icon: 'chart-bar',
    category: 'widgets',
    attributes: attrs(['jahr', 'ansicht', 'diagramm', 'auswahl', 'titel']),
    edit: function (props) {
      return el(
        'div',
        useBlockProps(),
        el(
          Inspector,
          null,
          el(
            C.PanelBody,
            { title: 'Einsatzstatistik' },
            field(props, 'titel', 'Überschrift (optional)'),
            field(props, 'jahr', 'Jahr', 'aktuell, alle oder eine Jahreszahl'),
            field(props, 'ansicht', 'Ansichten', 'summe, monate, kategorien, jahre'),
            field(props, 'diagramm', 'Diagramm', null, [STD, { label: 'Balken', value: 'balken' }, { label: 'Nur Tabellen', value: 'aus' }]),
            field(props, 'auswahl', 'Jahresauswahl für Besucher', null, [STD, { label: 'Ja', value: 'ja' }, { label: 'Nein', value: 'nein' }])
          )
        ),
        el(SSR, { block: 'blaulichtcms/einsatzstatistik', attributes: props.attributes })
      );
    },
    save: function () {
      return null;
    },
  });

  // Social-Feed (ab 0.10.0): freigegebene Beiträge von Facebook und Instagram aus BlaulichtCMS
  var STD6 = { label: 'Vorgabe', value: '' };
  wp.blocks.registerBlockType('blaulichtcms/social', {
    title: 'BlaulichtCMS: Social-Feed',
    icon: 'share',
    category: 'widgets',
    attributes: attrs(['anzahl', 'darstellung', 'netzwerk', 'text', 'titel']),
    edit: function (props) {
      return el(
        'div',
        useBlockProps(),
        el(
          Inspector,
          null,
          el(
            C.PanelBody,
            { title: 'Social-Feed' },
            field(props, 'titel', 'Überschrift (optional)'),
            field(props, 'anzahl', 'Anzahl', '1 bis 50, Vorgabe 6'),
            field(props, 'darstellung', 'Darstellung', null, [STD6, { label: 'Kacheln', value: 'kacheln' }, { label: 'Liste', value: 'liste' }]),
            field(props, 'netzwerk', 'Netzwerk', null, [{ label: 'Alle', value: '' }, { label: 'Facebook', value: 'facebook' }, { label: 'Instagram', value: 'instagram' }]),
            field(props, 'text', 'Text anzeigen', null, [STD6, { label: 'Ja', value: 'ja' }, { label: 'Nein', value: 'nein' }])
          )
        ),
        el(SSR, { block: 'blaulichtcms/social', attributes: props.attributes })
      );
    },
    save: function () {
      return null;
    },
  });
})(window.wp);
