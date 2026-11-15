-- Hilfen für abgebildete Personen und Art.-9-Inhalte (#118):
--   sensitive_flags  Markierungen aus der Sichtung (persons, health, plates, sensitive)
--   redactions       unkenntlich gemachte Bereiche der öffentlichen Fassung [{x,y,w,h,mode}] (0..1, bezogen auf das
--                    richtig gedrehte Bild)
--   crop             Zuschnitt der öffentlichen Fassung {x,y,w,h} (0..1) oder NULL
--   strip_audio      Video ohne Ton veröffentlichen
--   public_rev       Zähler je neu erzeugter öffentlicher Fassung (Cache der Oberfläche)
-- Das Original bleibt unverändert.
ALTER TABLE media ADD COLUMN IF NOT EXISTS sensitive_flags text[] NOT NULL DEFAULT '{}';
ALTER TABLE media ADD COLUMN IF NOT EXISTS redactions jsonb NOT NULL DEFAULT '[]';
ALTER TABLE media ADD COLUMN IF NOT EXISTS crop jsonb;
ALTER TABLE media ADD COLUMN IF NOT EXISTS strip_audio boolean NOT NULL DEFAULT false;
ALTER TABLE media ADD COLUMN IF NOT EXISTS public_rev integer NOT NULL DEFAULT 0;
