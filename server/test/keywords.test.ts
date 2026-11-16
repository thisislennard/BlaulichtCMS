import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CATALOGS, entryDetails, entryLabel, normalizeCode, resolveKeyword, STATE_IDS, STATES, type CatalogEntry } from '../src/keywords/catalog.js';
import { parseKeywordList } from '../src/keywords/store.js';

/** Stichwortverzeichnisse (#195) – reine Unit-Tests ohne Datenbank. */
const he = CATALOGS.HE;
const by = CATALOGS.BY;
const entry = (code: string, c = he): CatalogEntry => {
  const e = c.eintraege.find((x) => x.code === code);
  if (!e) throw new Error(`${code} fehlt`);
  return e;
};

describe('Stichwortverzeichnis Hessen', () => {
  it('nennt Quelle, Titel und Stand des Erlasses', () => {
    expect(he.quelle).toBe('https://familie.hessen.de/sites/familie.hessen.de/files/2024-09/2024-08-30_gemeinsamer_runderlass_einsatzstichworte.pdf');
    expect(he.stand).toBe('30. August 2024');
    expect(he.gueltig).toBe('1. Oktober 2024 bis 31. Dezember 2029');
    expect(he.titel).toContain('zur Festlegung der Einsatzstichworte für Brand-, Hilfeleistungs- und Rettungsdiensteinsätze');
    expect(he.vorgaenger?.quelle).toBe('https://innen.hessen.de/sites/innen.hessen.de/files/2022-12/EinsatzstichworteErl-Endversion-gez.pdf');
  });

  it('enthält genau die Einsatzstichworte der Anlage in deren Reihenfolge', () => {
    expect(he.eintraege.map((e) => e.code)).toEqual([
      'F 1', 'F 2', 'F 2 Y', 'F 3', 'F 3 Y', 'F 4', 'F BMA', 'F BUS Y', 'F FLUG 1 Y', 'F FLUG 2 Y', 'F GAS 1', 'F GAS 2', 'F LKW', 'F Zug', 'F ZUG Y', 'F RWM',
      'F SCHIFF 1', 'F SCHIFF 2', 'F SCHIFF 2 Y', 'F SCHIFF 2 GEFAHR', 'F WALD 1', 'F WALD 2',
      'H 1', 'H 1 Y', 'H 2', 'H ABST Y', 'H ELEK', 'H EINST Y', 'H FLUSS', 'H FLUSS Y', 'H WASS Y', 'H GAS 1', 'H GAS 2', 'H GEFAHR 1', 'H GEFAHR 2',
      'H KLEMM 1 Y', 'H E-CALL Y', 'H KLEMM 2 Y', 'H ÖL FLUSS', 'H ÖL WASS', 'H RADIOAKTIV', 'H SCHIFF', 'H SCHIFF 1 Y', 'H SCHIFF 2 Y', 'H ZUG 1 Y', 'H ZUG 2 Y',
      'H UNWETTER STURM', 'H UNWETTER WASSER',
      'K', 'R 0 K', 'R 0', 'R 1', 'R 2', 'R 3', 'R LEBEL', 'R MANV', 'R MRW', 'BA',
    ]);
  });

  it('übernimmt den Wortlaut der Spalte „Meldebild“', () => {
    expect(entry('F 2').meldebild).toEqual([{ titel: 'Brand', punkte: ['Wohnungsbrand', 'Dachstuhlbrand', 'Kellerbrand', 'Zimmerbrand', 'Kaminbrand', 'Rauchentwicklung', 'ähnliche Meldebilder'] }]);
    expect(entry('F BUS Y').meldebild).toEqual([{ titel: 'Brand eines besetzten Busses', punkte: ['Reisebus', 'Bus des ÖPNV', 'Schulbus'] }, { titel: 'mit großer Anzahl von Menschenleben in Gefahr' }]);
    expect(entry('F RWM').meldebild[0].punkte).toEqual(['Meldung eines ausgelösten (Heim-)Rauchwarnmelders']);
    expect(entry('H GEFAHR 1').meldebild[0].titel).toBe('Unfall mit Gefahrstoffaustritt aus einzelnen Gebinden von');
    expect(entry('H UNWETTER STURM').meldebild[0].punkte).toContain('Schäden durch umhergewehte Gegenständen');
    expect(entry('R 2').meldebild[0].titel).toBe('Notfalleinsatz mit einem Notarztsystem; bei allen akut lebensbedrohlichen Situationen, die der Indikationsliste für den Notarzt entsprechen.');
    expect(entry('BA').meldebild[0].titel).toBe('Einsatzunabhängige befristete Außerdienstnahme eines Einsatzmittels.');
    // Änderungen 2024 gegenüber 2022
    expect(entry('H E-CALL Y').meldebild).toEqual([{ titel: 'VU-Meldung aufgrund eCall-Notruf-Eingang in', punkte: ['PKW / LKW nach VU'] }]);
    expect(entry('H KLEMM 1 Y').meldebild[0].punkte).toEqual(['PKW / LKW nach VU', 'Kfz / Maschine']);
    expect(entry('H SCHIFF 1 Y').aliase).toEqual(['H SCHIFF Y 1']);
  });

  it('Kategorien stammen aus den Seitenüberschriften, kein Eintrag ohne Meldebild', () => {
    expect(Object.keys(he.kategorien)).toEqual(['Brand', 'Hilfeleistung', 'Unwetter', 'Rettungsdienst']);
    for (const e of he.eintraege) {
      expect(he.kategorien[e.kategorie], e.code).toBeTruthy();
      expect(entryLabel(e).length, e.code).toBeGreaterThan(2);
    }
    expect(entry('H UNWETTER WASSER').kategorie).toBe('Unwetter');
    expect(entry('K').kategorie).toBe('Rettungsdienst');
  });

  it('Kurzbezeichnung und Beschreibung nur aus Wörtern des Dokuments', () => {
    expect(entryLabel(entry('F 2'))).toBe('Brand');
    expect(entryDetails(entry('F 2'))).toBe('Brand (Wohnungsbrand, Dachstuhlbrand, Kellerbrand, Zimmerbrand, Kaminbrand, Rauchentwicklung)');
    expect(entryLabel(entry('F 2 Y'))).toBe('Brand in Wohngebäuden mit Menschenleben in Gefahr');
    expect(entryLabel(entry('F GAS 2'))).toBe('Brand eines Gastanks, Gastankfahrzeugs, Gaskesselwagens');
    expect(entryLabel(entry('H KLEMM 1 Y'))).toBe('Person eingeklemmt in PKW / LKW nach VU, Kfz / Maschine; Person verschüttet');
    expect(entryLabel(entry('H 2'))).toBe('Fahrzeug umgestürzt, Bauunfall, Gerüsteinsturz, Kran umgestürzt, Unfall mit Einsturz von beteiligten Objekten ohne Menschenleben in Gefahr');
    for (const e of he.eintraege) {
      const words = new Set(e.meldebild.flatMap((p) => [p.titel ?? '', ...(p.punkte ?? [])]).join(' ').split(/[\s,;()]+/).filter(Boolean));
      for (const w of `${entryLabel(e)} ${entryDetails(e)}`.split(/[\s,;()]+/).filter(Boolean)) expect(words.has(w), `${e.code}: ${w}`).toBe(true);
    }
  });
});

describe('Stichwortverzeichnis Bayern', () => {
  it('Stichwörter der Übersicht der ABek-Anlage mit Quelle', () => {
    expect(by.stand).toBe('15.03.2017');
    expect(by.quelle).toContain('gesetze-bayern.de');
    expect(by.eintraege).toHaveLength(125);
    const codes = by.eintraege.map((e) => e.code);
    for (const c of ['B 1', 'B 2 PERSON', 'THL HUBSCHRAUBERLANDUNG', 'ABC GEFAHRSTOFF-MELDEANLAGE', 'RD MANV 10 – 15', 'RD 2-KIND', 'SON HILFE / SONSTIGES FW', 'INF KASSENÄRZTLICHER BEREITSCHAFTSDIENST']) expect(codes).toContain(c);
    expect(new Set(by.eintraege.map((e) => e.kategorie))).toEqual(new Set(['Brand', 'THL', 'ABC', 'RD', 'Sonstige', 'Infoeinsätze']));
    // Übersicht ohne Meldebild: keine erfundenen Bezeichnungen
    for (const e of by.eintraege) expect(e.meldebild).toEqual([]);
  });
});

describe('Verzeichnisse allgemein', () => {
  it('keine doppelten Stichworte (auch nicht in anderer Schreibweise)', () => {
    for (const c of Object.values(CATALOGS)) {
      const all = c.eintraege.flatMap((e) => [e.code, ...(e.aliase ?? [])]).map(normalizeCode);
      expect(new Set(all).size, c.land).toBe(all.length);
    }
  });
  it('16 Länder plus eigene Liste; Verzeichnisse nur für Länder mit öffentlicher Quelle', () => {
    expect(STATES).toHaveLength(16);
    expect(new Set(STATES.map((s) => s.id)).size).toBe(16);
    expect(STATE_IDS).toContain('eigen');
    expect(Object.keys(CATALOGS).sort()).toEqual(['BY', 'HE']);
    for (const [id, c] of Object.entries(CATALOGS)) {
      expect(c.land).toBe(id);
      expect(c.quelle).toMatch(/^https:\/\//);
    }
  });
  it('Oberfläche (web/src/lib/keywords.ts) kennt dieselben Länder und Verzeichnisse', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../web/src/lib/keywords.ts'), 'utf8');
    const opts = src.slice(src.indexOf('STATE_OPTIONS'), src.indexOf('STATES_WITH_CATALOG'));
    expect([...opts.matchAll(/\{ id: '([A-Z]{2})', name: '([^']+)' \}/g)].map((m) => ({ id: m[1], name: m[2] }))).toEqual(STATES.map((s) => ({ id: s.id, name: s.name })));
    const withCatalog = /STATES_WITH_CATALOG = \[([^\]]*)\]/.exec(src)![1].match(/[A-Z]{2}/g);
    expect(withCatalog?.sort()).toEqual(Object.keys(CATALOGS).sort());
  });
});

describe('Stichwort einer Einsatzmeldung auflösen', () => {
  const list = he.eintraege.map((e) => ({ code: e.code, aliases: e.aliase }));
  const code = (raw: string) => resolveKeyword(raw, list)?.entry.code ?? null;
  it('Schreibweise egal, Untergliederungen zählen zum Stichwort', () => {
    expect(code('F2')).toBe('F 2');
    expect(code('f 2 y')).toBe('F 2 Y');
    expect(code('F ZUG')).toBe('F Zug');
    expect(code('HÖLFLUSS')).toBe('H ÖL FLUSS');
    expect(resolveKeyword('F2 W', list)).toEqual({ entry: expect.objectContaining({ code: 'F 2' }), partial: true });
    expect(code('F2.1')).toBe('F 2');
    expect(code('H SCHIFF Y 1')).toBe('H SCHIFF 1 Y');
  });
  it('unbekannt bleibt unbekannt', () => {
    expect(code('H 10')).toBeNull();
    expect(code('B3')).toBeNull();
    expect(code('')).toBeNull();
    expect(code('RX')).toBeNull();
  });
});

describe('Eigene Liste lesen', () => {
  it('CSV mit Kopfzeile, Anführungszeichen und Fehlern', () => {
    const r = parseKeywordList('﻿code;bezeichnung;kategorie\nB 1;Brand klein;Brand\n"B 2";"Brand; mittel";Brand\nB2;doppelt;Brand\n;ohne Kürzel;\nX;y;\n');
    expect(r.rows).toEqual([
      { code: 'B 1', bezeichnung: 'Brand klein', kategorie: 'Brand' },
      { code: 'B 2', bezeichnung: 'Brand; mittel', kategorie: 'Brand' },
    ]);
    expect(r.errors).toHaveLength(3);
  });
  it('Komma als Trenner und JSON', () => {
    expect(parseKeywordList('TH 1,Hilfeleistung klein,TH').rows).toEqual([{ code: 'TH 1', bezeichnung: 'Hilfeleistung klein', kategorie: 'TH' }]);
    expect(parseKeywordList('[{"code":"RD 1","bezeichnung":"Notfall","kategorie":"RD"}]').rows).toEqual([{ code: 'RD 1', bezeichnung: 'Notfall', kategorie: 'RD' }]);
    expect(parseKeywordList('[kaputt').errors[0]).toContain('JSON');
  });
});
