-- #186: Darstellung eines Hinweises auf der Website. 'auto' = nach Schweregrad, wie in der Bridge eingestellt;
-- sonst fest Banner, Popup oder beides.
ALTER TABLE banners ADD COLUMN display text NOT NULL DEFAULT 'auto' CHECK (display IN ('auto','banner','popup','both'));
