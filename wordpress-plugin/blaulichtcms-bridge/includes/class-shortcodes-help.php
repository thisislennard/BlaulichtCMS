<?php
/**
 * Reiter „Shortcodes“ auf der Seite „Einstellungen → BlaulichtCMS Einsatzliste“ (#227): alle Shortcodes der Bridge mit
 * allen Attributen, erlaubten Werten, Vorgaben und Wirkung sowie fertigen Beispielen zum Kopieren.
 *
 * Die Angaben folgen dem Code: BlaulichtCMS_Bridge_Incidents::list_atts()/stats_atts() und
 * BlaulichtCMS_Bridge_Banners::shortcode_incidents(). Vorgaben aus den Einstellungen werden mit dem aktuell gespeicherten
 * Wert angezeigt. Texte werden escaped; `Backticks` werden danach zu <code>.
 *
 * @package BlaulichtCMSBridge
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class BlaulichtCMS_Bridge_Shortcodes_Help {

	/** Text escapen, danach `…` als Code auszeichnen. */
	private static function fmt( string $s ): string {
		return (string) preg_replace( '/`([^`]+)`/', '<code>$1</code>', esc_html( $s ) );
	}

	/** Rahmen, der breite Tabellen auf schmalen Bildschirmen waagerecht scrollbar macht (per Tastatur erreichbar). */
	private static function open_scroll( string $label ): string {
		return '<div class="bcl-sc-scroll" role="region" tabindex="0" aria-label="' . esc_attr( $label ) . '">';
	}

	/** Aktuelle Einstellung als lesbarer Wert. */
	private static function current( string $v ): string {
		return 'Einstellung, derzeit `' . $v . '`';
	}

	/**
	 * Tabelle der Attribute.
	 *
	 * @param string $caption Beschriftung der Tabelle.
	 * @param array  $rows    Je Zeile: Attribut, erlaubte Werte, Vorgabe, Wirkung.
	 */
	private static function attr_table( string $caption, array $rows ): string {
		$h = self::open_scroll( $caption ) . '<table class="widefat striped bcl-sc-table"><caption class="screen-reader-text">' . esc_html( $caption ) . '</caption><thead><tr>'
			. '<th scope="col">Attribut</th><th scope="col">Erlaubte Werte</th><th scope="col">Vorgabe</th><th scope="col">Wirkung</th></tr></thead><tbody>';
		foreach ( $rows as $r ) {
			$h .= '<tr><th scope="row"><code>' . esc_html( $r[0] ) . '</code></th><td>' . self::fmt( $r[1] ) . '</td><td>' . self::fmt( $r[2] ) . '</td><td>' . self::fmt( $r[3] ) . '</td></tr>';
		}
		return $h . '</tbody></table></div>';
	}

	/**
	 * Beispiele mit Kopieren-Knopf.
	 *
	 * @param string $caption Beschriftung der Tabelle.
	 * @param array  $rows    Je Zeile: Zweck, Shortcode, Erläuterung.
	 */
	private static function examples( string $caption, array $rows ): string {
		static $n = 0;
		$h = self::open_scroll( $caption ) . '<table class="widefat striped bcl-sc-table bcl-sc-examples"><caption class="screen-reader-text">' . esc_html( $caption ) . '</caption><thead><tr>'
			. '<th scope="col">Zweck</th><th scope="col">Shortcode</th><th scope="col"><span class="screen-reader-text">Kopieren</span></th></tr></thead><tbody>';
		foreach ( $rows as $r ) {
			++$n;
			$id = 'bcl-sc-ex-' . $n;
			$h .= '<tr><th scope="row">' . esc_html( $r[0] ) . ( '' !== $r[2] ? '<span class="bcl-sc-note">' . self::fmt( $r[2] ) . '</span>' : '' ) . '</th>'
				. '<td><code id="' . esc_attr( $id ) . '" class="bcl-sc-code">' . esc_html( $r[1] ) . '</code></td>'
				. '<td class="bcl-sc-copy-cell"><button type="button" class="button bcl-sc-copy" data-copy="' . esc_attr( $id ) . '">Kopieren<span class="screen-reader-text">: ' . esc_html( $r[0] ) . '</span></button></td></tr>';
		}
		return $h . '</tbody></table></div>';
	}

	public static function render(): void {
		$s    = BlaulichtCMS_Bridge_Incidents::settings();
		$cols = implode( ', ', array_map( static fn( $k ) => '`' . $k . '` (' . BlaulichtCMS_Bridge_Incidents::COLUMNS[ $k ] . ')', array_keys( BlaulichtCMS_Bridge_Incidents::COLUMNS ) ) );
		$prev = (int) wp_date( 'Y' ) - 1;
		$bool = 'Als „ja“ gelten `ja`, `1`, `true`, `an` und `yes`; alles andere gilt als „nein“.';
		// phpcs:disable WordPress.Security.EscapeOutput.OutputNotEscaped -- alle Texte über esc_html()/self::fmt() escaped
		?>
		<div class="bcl-sc">
			<p>Shortcodes setzen Inhalte der Bridge an eine beliebige Stelle einer Seite oder eines Beitrags – im Block-Editor über den Block „Shortcode“, im klassischen Editor direkt im Text, in Elementor über das Widget „Shortcode“. Attribute stehen in Anführungszeichen hinter dem Namen, z. B. <code>[blaulichtcms_einsatzstatistik ansicht="summe"]</code>. Fehlt ein Attribut, gilt die Vorgabe; unbekannte Werte werden ignoriert.</p>
			<div class="notice notice-info inline"><p><strong>Alternative: Blöcke.</strong> Im Block-Editor gibt es dieselben Inhalte als Blöcke „BlaulichtCMS: Einsatzliste“, „BlaulichtCMS: Einsatzstatistik“, „BlaulichtCMS: Hinweise“, „BlaulichtCMS: Einsatzübersicht“ und „BlaulichtCMS: Social-Feed“. Die Attribute stehen dort als Felder in der Seitenleiste; ein leeres Feld bedeutet „Vorgabe der Einstellungen“.</p></div>

			<h2 id="bcl-sc-overview">Übersicht</h2>
			<?php echo self::open_scroll( 'Shortcodes der BlaulichtCMS Bridge' ); ?>
			<table class="widefat striped bcl-sc-table"><caption class="screen-reader-text">Shortcodes der BlaulichtCMS Bridge</caption>
				<thead><tr><th scope="col">Shortcode</th><th scope="col">Zeigt</th><th scope="col">Block im Block-Editor</th><th scope="col">Attribute</th></tr></thead>
				<tbody>
					<tr><th scope="row"><code>[blaulichtcms_einsatzliste]</code></th><td>Einsatzliste als Tabelle oder Karten, mit Filtern, Seiten oder Jahresabschnitten</td><td>BlaulichtCMS: Einsatzliste</td><td><a href="#bcl-sc-liste">11 Attribute</a></td></tr>
					<tr><th scope="row"><code>[blaulichtcms_einsatzstatistik]</code></th><td>Jahresstatistik: große Zahl, je Monat, je Kategorie, je Jahr – einzeln oder zusammen</td><td>BlaulichtCMS: Einsatzstatistik</td><td><a href="#bcl-sc-statistik">5 Attribute</a></td></tr>
					<tr><th scope="row"><code>[blaulichtcms_banner]</code></th><td>Aktive Hinweise aus BlaulichtCMS als Banner an dieser Stelle</td><td>BlaulichtCMS: Hinweise</td><td><a href="#bcl-sc-weitere">keine</a></td></tr>
					<tr><th scope="row"><code>[blaulichtcms_einsaetze]</code></th><td>Kurze Liste der letzten Einsatzberichte (Beiträge aus BlaulichtCMS) mit Datum und Link</td><td>BlaulichtCMS: Einsatzübersicht</td><td><a href="#bcl-sc-weitere">1 Attribut</a></td></tr>
					<tr><th scope="row"><code>[blaulichtcms_social]</code></th><td>Freigegebene Beiträge von Facebook und Instagram aus BlaulichtCMS als Kacheln oder Liste</td><td>BlaulichtCMS: Social-Feed</td><td><a href="#bcl-sc-social">5 Attribute</a></td></tr>
				</tbody>
			</table></div>

			<h2 id="bcl-sc-statistik">Einsatzstatistik in Teilen: <code>[blaulichtcms_einsatzstatistik]</code></h2>
			<p>Die Statistik besteht aus vier Teilen. Mit <code>ansicht</code> zeigt ein Shortcode nur die gewählten Teile – so lässt sich z. B. die große Zahl auf der Startseite und das Monatsdiagramm auf einer anderen Seite zeigen. Mehrere Teile stehen immer in dieser Reihenfolge untereinander.</p>
			<?php echo self::open_scroll( 'Teile der Einsatzstatistik' ); ?>
			<table class="widefat striped bcl-sc-table"><caption class="screen-reader-text">Teile der Einsatzstatistik</caption>
				<thead><tr><th scope="col">Wert für <code>ansicht</code></th><th scope="col">Zeigt</th><th scope="col">Hinweis</th></tr></thead>
				<tbody>
					<tr><th scope="row"><code>summe</code></th><td>Große Zahl „Einsätze im Jahr …“, darunter Vorjahr und „davon Fehlalarme“</td><td>Bei <code>jahr="alle"</code>: „Einsätze insgesamt“ ohne Vorjahr</td></tr>
					<tr><th scope="row"><code>monate</code></th><td>Einsätze je Monat (Januar bis Dezember)</td><td>Nur bei einem einzelnen Jahr; bei <code>jahr="alle"</code> entfällt dieser Teil</td></tr>
					<tr><th scope="row"><code>kategorien</code></th><td>Einsätze je Kategorie, die häufigste zuerst, in den Farben der Kategorien</td><td>Bei <code>jahr="alle"</code> über alle Jahre zusammengezählt</td></tr>
					<tr><th scope="row"><code>jahre</code></th><td>Einsätze je Jahr im Vergleich</td><td>Zeigt immer alle Jahre, unabhängig von <code>jahr</code></td></tr>
				</tbody>
			</table></div>
			<h3>Attribute</h3>
			<?php
			echo self::attr_table(
				'Attribute von blaulichtcms_einsatzstatistik',
				array(
					array( 'ansicht', '`summe`, `monate`, `kategorien`, `jahre` – einzeln oder mit Komma kombiniert, z. B. `summe,monate`', self::current( $s['stats_views'] ? implode( ',', $s['stats_views'] ) : 'summe,monate,kategorien' ) . ' (Einstellung „Ansichten“)', 'Welche Teile erscheinen (siehe oben). Ohne gültigen Wert: `summe,monate,kategorien`.' ),
					array( 'jahr', '`aktuell` (neuestes Jahr mit Einsätzen), `alle` oder eine Jahreszahl wie `' . $prev . '`', '`aktuell`', 'Welches Jahr ausgewertet wird. Wählen Besucher in der Jahresauswahl ein Jahr, gilt dieses (nur bei `auswahl="ja"`).' ),
					array( 'diagramm', '`balken` oder `aus`', '`balken`', '`balken`: Balkendiagramm mit Zahlen, darunter aufklappbar „Als Tabelle“. `aus`: nur Tabellen. Gilt für `monate`, `kategorien` und `jahre`.' ),
					array( 'auswahl', '`ja` oder `nein`', '`ja`', 'Jahresauswahl für Besucher über diesem Shortcode (erscheint erst ab zwei Jahren mit Einsätzen). ' . $bool ),
					array( 'titel', 'beliebiger Text', 'leer (keine Überschrift)', 'Überschrift über der Statistik.' ),
				)
			);
			?>
			<div class="notice notice-warning inline" id="bcl-sc-auswahl">
				<p><strong>Jahresauswahl (<code>auswahl</code>) wirkt nur im jeweiligen Shortcode.</strong> Das Attribut gilt nur für den Shortcode, in dem es steht: Es blendet dort die Auswahl ein oder aus und legt fest, ob dieser Teil einem von Besuchern gewählten Jahr folgt. Mit <code>auswahl="nein"</code> bleibt ein Teil immer bei seinem <code>jahr</code> – auch wenn auf derselben Seite an anderer Stelle ein Jahr gewählt wird. Für die große Zahl auf der Startseite oder einzelne Diagramme ist <code>auswahl="nein"</code> meist richtig.</p>
				<p>Gut zu wissen: Das gewählte Jahr steht in der Adresse der Seite. Alle Teile derselben Seite, deren Auswahl eingeschaltet ist (Statistik mit <code>auswahl="ja"</code>, Liste mit Filter <code>jahr</code>), zeigen danach dieses Jahr.</p>
			</div>
			<h3>Beispiele</h3>
			<?php
			echo self::examples(
				'Beispiele für blaulichtcms_einsatzstatistik',
				array(
					array( 'Nur die große Zahl auf der Startseite', '[blaulichtcms_einsatzstatistik ansicht="summe" auswahl="nein"]', 'Einsätze im neuesten Jahr mit Vorjahr und Fehlalarmen.' ),
					array( 'Monatsdiagramm', '[blaulichtcms_einsatzstatistik ansicht="monate" auswahl="nein" titel="Einsätze je Monat"]', '' ),
					array( 'Kategorien als Tabelle', '[blaulichtcms_einsatzstatistik ansicht="kategorien" diagramm="aus" auswahl="nein"]', '' ),
					array( 'Alle Jahre im Vergleich', '[blaulichtcms_einsatzstatistik ansicht="jahre" auswahl="nein"]', '' ),
					array( 'Gesamtzahl über alle Jahre', '[blaulichtcms_einsatzstatistik ansicht="summe" jahr="alle" auswahl="nein"]', '' ),
					array( 'Ein bestimmtes Jahr, vollständig', '[blaulichtcms_einsatzstatistik jahr="' . $prev . '" ansicht="summe,monate,kategorien" auswahl="nein"]', 'Jahreszahl nach Bedarf ändern.' ),
					array( 'Komplette Statistik mit Jahresauswahl', '[blaulichtcms_einsatzstatistik ansicht="summe,monate,kategorien,jahre"]', '' ),
				)
			);
			?>

			<h2 id="bcl-sc-liste">Einsatzliste: <code>[blaulichtcms_einsatzliste]</code></h2>
			<p>Ohne Attribute zeigt der Shortcode die Liste so, wie sie im Reiter „Einstellungen“ eingestellt ist. Jedes Attribut überschreibt die jeweilige Einstellung nur für diesen Shortcode.</p>
			<h3>Attribute</h3>
			<?php
			echo self::attr_table(
				'Attribute von blaulichtcms_einsatzliste',
				array(
					array( 'jahr', '`aktuell` (neuestes Jahr mit Einsätzen), `alle` oder eine Jahreszahl wie `' . $prev . '`', self::current( (string) $s['year'] ), 'Welche Einsätze erscheinen. Mit Filter `jahr` gilt das von Besuchern gewählte Jahr. Mit `gruppierung="jahr"`: eine Jahreszahl zeigt nur diesen Abschnitt, sonst erscheinen alle Jahre.' ),
					array( 'kategorie', 'Name einer Kategorie genau wie in BlaulichtCMS, z. B. `Brand`', 'leer (alle Kategorien)', 'Nur Einsätze dieser Kategorie. Mit Filter `kategorie` gilt die Auswahl der Besucher.' ),
					array( 'spalten', $cols . ' – mit Komma getrennt', self::current( implode( ',', $s['columns'] ) ), 'Welche Spalten in welcher Reihenfolge. In der Kartenansicht erscheinen sie als Angaben je Karte; `bild` zeigt das Vorschaubild.' ),
					array( 'sortierung', '`absteigend` oder `aufsteigend`', self::current( 'asc' === $s['sort'] ? 'aufsteigend' : 'absteigend' ), '`absteigend`: neueste zuerst, `aufsteigend`: älteste zuerst.' ),
					array( 'anzahl', 'Zahl von `0` bis `500`', self::current( (string) (int) $s['per_page'] ), 'Einträge je Seite; bei mehr Einträgen erscheint eine Seitennavigation. `0` = alle auf einer Seite. Ohne Wirkung bei `gruppierung="jahr"`.' ),
					array( 'filter', '`jahr`, `kategorie`, `jahr,kategorie` oder `aus`', self::current( $s['filters'] ? implode( ',', $s['filters'] ) : 'aus' ), 'Auswahlfelder für Besucher über der Liste. Bei `gruppierung="jahr"` erscheinen keine Filter.' ),
					array( 'darstellung', '`tabelle` oder `karten`', self::current( (string) $s['display'] ), 'Tabelle (auf schmalen Bildschirmen als Blöcke mit Beschriftung) oder Karten.' ),
					array( 'gruppierung', '`keine` oder `jahr`', self::current( (string) $s['group'] ), '`jahr`: je Jahr ein aufklappbarer Abschnitt mit Anzahl (Historie), das neueste Jahr ist geöffnet.' ),
					array( 'detail', '`ja` oder `nein`', self::current( ! empty( $s['detail'] ) ? 'ja' : 'nein' ), 'Einsatzmeldung zur Detailseite verlinken. Wirkt nur, wenn „Detailseiten“ in den Einstellungen eingeschaltet sind. ' . $bool ),
					array( 'nur_besondere', '`ja` oder `nein`', '`nein`', 'Nur als „Besonderer Einsatz“ markierte Einsätze. ' . $bool ),
					array( 'titel', 'beliebiger Text', 'leer (keine Überschrift)', 'Überschrift über der Liste.' ),
				)
			);
			?>
			<h3>Beispiele</h3>
			<?php
			echo self::examples(
				'Beispiele für blaulichtcms_einsatzliste',
				array(
					array( 'Liste der letzten 20 Einsätze', '[blaulichtcms_einsatzliste anzahl="20" jahr="alle" filter="aus" titel="Die letzten 20 Einsätze"]', 'Ältere Einsätze über die Seitennavigation.' ),
					array( 'Historie nach Jahren', '[blaulichtcms_einsatzliste gruppierung="jahr" jahr="alle" titel="Historie"]', 'Je Jahr ein aufklappbarer Abschnitt.' ),
					array( 'Besondere Einsätze als Karten', '[blaulichtcms_einsatzliste nur_besondere="ja" darstellung="karten" anzahl="5" filter="aus" titel="Besondere Einsätze"]', '' ),
					array( 'Nur eine Kategorie', '[blaulichtcms_einsatzliste kategorie="Brand" filter="jahr" titel="Brandeinsätze"]', 'Kategorienamen anpassen.' ),
					array( 'Kompakte Tabelle ohne Detaillinks', '[blaulichtcms_einsatzliste spalten="datum,stichwort,ort" detail="nein" anzahl="10"]', '' ),
					array( 'Vollständige Liste mit Filtern', '[blaulichtcms_einsatzliste filter="jahr,kategorie" anzahl="20"]', '' ),
				)
			);
			?>

			<h2 id="bcl-sc-weitere">Hinweise und Einsatzübersicht</h2>
			<?php
			echo self::attr_table(
				'Attribute von blaulichtcms_banner und blaulichtcms_einsaetze',
				array(
					array( 'anzahl', 'Zahl von `1` bis `50`', '`10`', 'Nur `[blaulichtcms_einsaetze]`: so viele der neuesten Einsatzberichte (Beiträge aus BlaulichtCMS) erscheinen.' ),
				)
			);
			?>
			<p><code>[blaulichtcms_banner]</code> hat keine Attribute. Farbe und Darstellung je Schweregrad und ob Banner automatisch am Seitenanfang erscheinen, stehen unter <a href="<?php echo esc_url( admin_url( 'options-general.php?page=' . BlaulichtCMS_Bridge_Admin::SLUG ) ); ?>">Einstellungen → BlaulichtCMS Bridge</a>.</p>
			<?php
			echo self::examples(
				'Beispiele für blaulichtcms_banner und blaulichtcms_einsaetze',
				array(
					array( 'Hinweise an einer festen Stelle', '[blaulichtcms_banner]', '' ),
					array( 'Die letzten 5 Einsatzberichte', '[blaulichtcms_einsaetze anzahl="5"]', '' ),
				)
			);
			?>
			<h2 id="bcl-sc-social">Social-Feed: <code>[blaulichtcms_social]</code></h2>
			<p>Zeigt die Beiträge, die in BlaulichtCMS unter <strong>Reichweite → Social-Feed</strong> freigegeben sind – neueste zuerst, mit Bild, Datum, Text und Link zum Original. Die Bilder liegen auf dieser Website; Besucher laden nichts von Facebook oder Instagram nach (keine eingebetteten Skripte, kein Tracking). Neue Beiträge erscheinen mit dem nächsten Abruf.</p>
			<?php
			echo self::attr_table(
				'Attribute von blaulichtcms_social',
				array(
					array( 'anzahl', 'Zahl von `1` bis `50`', '`6`', 'So viele der neuesten freigegebenen Beiträge erscheinen (höchstens so viele, wie in BlaulichtCMS freigegeben sind).' ),
					array( 'darstellung', '`kacheln` oder `liste`', '`kacheln`', '`kacheln`: quadratische Bilder im Raster, `liste`: Bild links, Text rechts (auf schmalen Bildschirmen untereinander).' ),
					array( 'netzwerk', '`facebook` oder `instagram`', 'leer (beide)', 'Nur Beiträge dieses Netzwerks.' ),
					array( 'text', '`ja` oder `nein`', '`ja`', 'Text der Beiträge (gekürzt) anzeigen. ' . $bool ),
					array( 'titel', 'beliebiger Text', 'leer (keine Überschrift)', 'Überschrift über dem Feed.' ),
				)
			);
			echo self::examples(
				'Beispiele für blaulichtcms_social',
				array(
					array( 'Die neuesten 6 Beiträge als Kacheln', '[blaulichtcms_social]', '' ),
					array( 'Nur Instagram, nur Bilder', '[blaulichtcms_social netzwerk="instagram" text="nein" anzahl="9"]', '' ),
					array( 'Liste mit Überschrift', '[blaulichtcms_social darstellung="liste" anzahl="5" titel="Aktuelles aus den sozialen Netzwerken"]', '' ),
				)
			);
			?>
			<p class="bcl-sc-status screen-reader-text" role="status" aria-live="polite"></p>
		</div>
		<?php
		// phpcs:enable
	}
}
