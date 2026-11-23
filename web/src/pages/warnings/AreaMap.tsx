import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Button } from '../../components/ui/core';

/**
 * Betroffenes Gebiet auf der Karte einzeichnen (#277). Kacheln kommen über BlaulichtCMS (/api/v1/map/tiles), nie direkt
 * von OpenStreetMap. Das Gebiet ist ein Vieleck aus Punkten (Breite, Länge) und Teil der Fassung (data.area_geo);
 * im PDF erscheint es als Kartenausschnitt unter „Betroffenes Gebiet“. Maßgeblich bleibt die Beschreibung im Textfeld.
 */
export interface AreaGeo {
  type: 'polygon';
  points: [number, number][];
}

const VIEW_KEY = 'bc-warning-map-view';
const RED = '#C8102E';

function lastView(): { center: [number, number]; zoom: number } {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) ?? 'null');
    if (Array.isArray(v?.center) && typeof v?.zoom === 'number') return v;
  } catch {
    /* Speicher nicht verfügbar */
  }
  return { center: [51.2, 10.4], zoom: 6 };
}

export default function AreaMap({ value, onChange, disabled }: { value: AreaGeo | null | undefined; onChange: (v: AreaGeo | null) => void; disabled?: boolean }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [points, setPoints] = useState<[number, number][]>(value?.points ?? []);
  const pointsRef = useRef(points);
  pointsRef.current = points;
  const drawingRef = useRef(drawing);
  drawingRef.current = drawing;

  // Karte einmal anlegen
  useEffect(() => {
    if (!el.current || map.current) return;
    const m = L.map(el.current, { zoomControl: true, attributionControl: true });
    L.tileLayer('/api/v1/map/tiles/{z}/{x}/{y}.png', { maxZoom: 18, minZoom: 3, attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>-Mitwirkende' }).addTo(m);
    m.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener noreferrer">Leaflet</a>');
    layer.current = L.layerGroup().addTo(m);
    const pts = pointsRef.current;
    if (pts.length >= 3) m.fitBounds(L.latLngBounds(pts), { padding: [24, 24], maxZoom: 16 });
    else {
      const v = lastView();
      m.setView(v.center, v.zoom);
    }
    m.on('click', (e: L.LeafletMouseEvent) => {
      if (!drawingRef.current) return;
      setPoints((p) => [...p, [Number(e.latlng.lat.toFixed(6)), Number(e.latlng.lng.toFixed(6))]]);
    });
    m.on('moveend', () => {
      try {
        const c = m.getCenter();
        localStorage.setItem(VIEW_KEY, JSON.stringify({ center: [c.lat, c.lng], zoom: m.getZoom() }));
      } catch {
        /* Speicher nicht verfügbar */
      }
    });
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
    };
  }, []);

  // Gespeicherten Stand übernehmen, wenn er sich von außen ändert (andere Fassung geladen)
  useEffect(() => {
    if (!drawingRef.current) setPoints(value?.points ?? []);
  }, [value]);

  // Vieleck und Punkte zeichnen
  useEffect(() => {
    const g = layer.current;
    if (!g) return;
    g.clearLayers();
    if (points.length >= 2) (points.length >= 3 ? L.polygon(points, { color: RED, weight: 3, fillOpacity: 0.18 }) : L.polyline(points, { color: RED, weight: 3, dashArray: '6 6' })).addTo(g);
    if (drawing) for (const p of points) L.circleMarker(p, { radius: 5, color: RED, weight: 2, fillColor: '#fff', fillOpacity: 1 }).addTo(g);
  }, [points, drawing]);

  useEffect(() => {
    if (el.current) el.current.style.cursor = drawing ? 'crosshair' : '';
  }, [drawing]);

  const finish = () => {
    setDrawing(false);
    onChange(points.length >= 3 ? { type: 'polygon', points } : null);
  };
  const clear = () => {
    setPoints([]);
    onChange(null);
  };

  return (
    <div className="flex flex-col gap-2">
      <div ref={el} className="h-[380px] w-full rounded-node border border-line overflow-hidden z-0" role="region" aria-label="Karte zum Einzeichnen des betroffenen Gebiets" />
      <div className="flex flex-wrap items-center gap-2">
        {!drawing ? (
          <Button size="sm" icon="Pencil" disabled={disabled} onClick={() => { setDrawing(true); if (points.length >= 3) setPoints(points); }}>
            {points.length >= 3 ? 'Gebiet bearbeiten' : 'Gebiet einzeichnen'}
          </Button>
        ) : (
          <>
            <Button size="sm" variant="primary" icon="Check" disabled={points.length > 0 && points.length < 3} onClick={finish}>
              Fertig
            </Button>
            <Button size="sm" icon="Undo2" disabled={!points.length} onClick={() => setPoints((p) => p.slice(0, -1))}>
              Letzten Punkt entfernen
            </Button>
          </>
        )}
        {points.length > 0 && (
          <Button size="sm" variant="danger" icon="Trash2" disabled={disabled} onClick={clear}>
            Gebiet entfernen
          </Button>
        )}
        <span className="text-meta text-fg-muted" aria-live="polite">
          {drawing ? `Punkte durch Klicken in die Karte setzen (${points.length} gesetzt, mindestens 3).` : points.length >= 3 ? `Gebiet mit ${points.length} Punkten markiert – erscheint im PDF als Kartenausschnitt.` : 'Optional: Gebiet auf der Karte markieren.'}
        </span>
      </div>
    </div>
  );
}
