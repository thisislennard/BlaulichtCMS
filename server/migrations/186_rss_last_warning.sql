-- RSS-Quellen (#249): Hinweis zum letzten Abruf, wenn einzelne Einträge nicht übernommen werden konnten. Der Abruf
-- selbst gilt dann als erfolgreich (last_error bleibt leer); NULL = alle Einträge übernommen.
ALTER TABLE rss_feeds ADD COLUMN IF NOT EXISTS last_warning text;
