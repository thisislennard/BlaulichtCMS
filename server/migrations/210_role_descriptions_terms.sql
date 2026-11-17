-- Begriffe (#257): Beschreibungen der mitgelieferten Rollen ohne „Kanäle“/„Zielkanäle“ (verbindliche Begriffe in
-- docs/design-leitstand.md §12). Nur die Texte der Systemrollen; eigene Rollen bleiben unverändert.
UPDATE roles SET description = 'Vollzugriff: Konten, Rechte, Websites und Verbindungen, Systemzustand, Sicherungen. Hat immer alle Rechte und lässt sich nicht ändern.' WHERE id = 'platform_admin' AND is_system;
UPDATE roles SET description = 'Übergibt freigegebene Fassungen an die Veröffentlichungsziele.' WHERE id = 'publisher' AND is_system;
