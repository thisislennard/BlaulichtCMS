<?php
/**
 * Einstellungsseite „Einstellungen → BlaulichtCMS Einsatzliste“ (#213): Spalten und Reihenfolge, Sortierung, Filter,
 * Anzahl je Seite, Tabelle oder Karten, Jahresabschnitte, Detailseiten, Farben, Kategorienfarben und -symbole,
 * Ansichten der Statistik – mit Vorschau (echte Einträge oder Beispieldaten).
 *
 * @package BlaulichtCMSBridge
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class BlaulichtCMS_Bridge_Incidents_Admin {
	const SLUG = 'blaulichtcms-einsatzliste';

	public static function boot(): void {
		add_action( 'admin_menu', array( __CLASS__, 'menu' ) );
		add_action( 'admin_post_blaulichtcms_bridge_incidents_save', array( __CLASS__, 'save' ) );
		add_action( 'admin_enqueue_scripts', array( __CLASS__, 'assets' ) );
	}

	public static function menu(): void {
		add_options_page( 'BlaulichtCMS Einsatzliste', 'BlaulichtCMS Einsatzliste', 'manage_options', self::SLUG, array( __CLASS__, 'render' ) );
	}

	public static function assets( string $hook ): void {
		if ( 'settings_page_' . self::SLUG !== $hook ) {
			return;
		}
		wp_enqueue_style( 'wp-color-picker' );
		wp_enqueue_script( 'wp-color-picker' );
		wp_add_inline_script( 'wp-color-picker', 'jQuery(function($){$(".bcl-color").wpColorPicker();});' );
		wp_enqueue_style( 'blaulichtcms-bridge-incidents', plugins_url( 'assets/incidents.css', BLAULICHTCMS_BRIDGE_FILE ), array(), BLAULICHTCMS_BRIDGE_VERSION );
		wp_add_inline_style( 'blaulichtcms-bridge-incidents', BlaulichtCMS_Bridge_Incidents::inline_css() . '.bcl-preview{background:#fff;color:#1d2327;border:1px solid #c3c4c7;padding:1em 1.25em;max-width:70rem}.bcl-cols td{padding:2px 8px}' );
	}

	public static function save(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'Keine Berechtigung.', 'blaulichtcms-bridge' ), 403 );
		}
		check_admin_referer( 'blaulichtcms_bridge_incidents_save' );
		$in = isset( $_POST['bcl'] ) && is_array( $_POST['bcl'] ) ? map_deep( wp_unslash( $_POST['bcl'] ), 'sanitize_text_field' ) : array(); // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized
		// Spalten in der gewählten Reihenfolge
		$order = (array) ( $in['order'] ?? array() );
		$cols  = array_keys( array_filter( (array) ( $in['col'] ?? array() ) ) );
		usort( $cols, static fn( $a, $b ) => (int) ( $order[ $a ] ?? 99 ) <=> (int) ( $order[ $b ] ?? 99 ) );
		$in['columns'] = $cols;
		update_option( BlaulichtCMS_Bridge_Incidents::OPTION, BlaulichtCMS_Bridge_Incidents::sanitize_settings( $in ), false );
		BlaulichtCMS_Bridge_Banners::purge_cache();
		set_transient( 'blaulichtcms_bridge_notice_' . get_current_user_id(), array( 'success', 'Einstellungen der Einsatzliste gespeichert.' ), 60 );
		wp_safe_redirect( admin_url( 'options-general.php?page=' . self::SLUG ) );
		exit;
	}

	private static function radio( string $name, string $value, string $cur, string $label ): string {
		return '<label style="margin-right:1.2em"><input type="radio" name="' . esc_attr( $name ) . '" value="' . esc_attr( $value ) . '"' . checked( $cur, $value, false ) . '> ' . esc_html( $label ) . '</label>';
	}

	public static function render(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$s      = BlaulichtCMS_Bridge_Incidents::settings();
		$notice = get_transient( 'blaulichtcms_bridge_notice_' . get_current_user_id() );
		if ( $notice ) {
			delete_transient( 'blaulichtcms_bridge_notice_' . get_current_user_id() );
		}
		$known = BlaulichtCMS_Bridge_Incidents::categories();
		$cats  = $s['categories'];
		foreach ( $known as $k ) {
			$cats[ $k ] = $cats[ $k ] ?? array( 'color' => '', 'icon' => '' );
		}
		if ( ! $cats ) {
			// Noch nichts übertragen: gängige Kategorien als Vorschlag
			$cats = array(
				'Brand'         => array( 'color' => '', 'icon' => 'feuer' ),
				'Hilfeleistung' => array( 'color' => '', 'icon' => 'technik' ),
			);
		}
		$order = array_merge( $s['columns'], array_diff( array_keys( BlaulichtCMS_Bridge_Incidents::COLUMNS ), $s['columns'] ) );
		$has   = (bool) BlaulichtCMS_Bridge_Incidents::years();
		?>
		<div class="wrap">
			<h1>BlaulichtCMS Einsatzliste</h1>
			<?php if ( $notice ) : ?>
				<div class="notice notice-<?php echo esc_attr( $notice[0] ); ?> is-dismissible"><p><?php echo esc_html( $notice[1] ); ?></p></div>
			<?php endif; ?>
			<p>Die Einträge kommen aus BlaulichtCMS (nur freigegebene, ohne Adressen und Namen). Hier legen Sie fest, wie die Liste und die Statistik auf der Website aussehen. Schrift und Grundfarben übernimmt die Liste vom Theme.</p>
			<p>Einbinden: Shortcode <code>[blaulichtcms_einsatzliste]</code> bzw. <code>[blaulichtcms_einsatzstatistik]</code> (auch im Elementor-Widget „Shortcode“) oder die Blöcke „BlaulichtCMS: Einsatzliste“ und „BlaulichtCMS: Einsatzstatistik“. Attribute überschreiben die Vorgaben dieser Seite – siehe unten.</p>
			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
				<input type="hidden" name="action" value="blaulichtcms_bridge_incidents_save">
				<?php wp_nonce_field( 'blaulichtcms_bridge_incidents_save' ); ?>
				<h2>Liste</h2>
				<table class="form-table" role="presentation">
					<tr><th scope="row">Spalten und Reihenfolge</th><td>
						<table class="bcl-cols"><tbody>
						<?php foreach ( $order as $i => $c ) : ?>
							<tr>
								<td><label><input type="checkbox" name="bcl[col][<?php echo esc_attr( $c ); ?>]" value="1" <?php checked( in_array( $c, $s['columns'], true ) ); ?>> <?php echo esc_html( BlaulichtCMS_Bridge_Incidents::COLUMNS[ $c ] ); ?></label></td>
								<td><label>Position <input type="number" min="1" max="20" style="width:4.5em" name="bcl[order][<?php echo esc_attr( $c ); ?>]" value="<?php echo (int) ( $i + 1 ); ?>"></label></td>
							</tr>
						<?php endforeach; ?>
						</tbody></table>
						<p class="description">Auf schmalen Bildschirmen erscheint jede Zeile als Block mit Beschriftung. Shortcode: <code>spalten="nr,datum,stichwort,meldung,ort"</code></p>
					</td></tr>
					<tr><th scope="row">Darstellung</th><td>
						<?php echo self::radio( 'bcl[display]', 'tabelle', $s['display'], 'Tabelle' ) . self::radio( 'bcl[display]', 'karten', $s['display'], 'Karten' ); // phpcs:ignore WordPress.Security.EscapeOutput ?>
						<p class="description"><code>darstellung="tabelle"</code> oder <code>"karten"</code></p>
					</td></tr>
					<tr><th scope="row">Gliederung</th><td>
						<?php echo self::radio( 'bcl[group]', 'keine', $s['group'], 'Eine Liste mit Filtern und Seiten' ) . self::radio( 'bcl[group]', 'jahr', $s['group'], 'Je Jahr ein aufklappbarer Abschnitt (Historie)' ); // phpcs:ignore WordPress.Security.EscapeOutput ?>
						<p class="description"><code>gruppierung="jahr"</code></p>
					</td></tr>
					<tr><th scope="row">Jahr</th><td>
						<?php echo self::radio( 'bcl[year]', 'aktuell', $s['year'], 'Neuestes Jahr' ) . self::radio( 'bcl[year]', 'alle', $s['year'], 'Alle Jahre' ); // phpcs:ignore WordPress.Security.EscapeOutput ?>
						<p class="description"><code>jahr="aktuell"</code>, <code>"alle"</code> oder eine Jahreszahl</p>
					</td></tr>
					<tr><th scope="row"><label for="bcl-sort">Sortierung</label></th><td>
						<select id="bcl-sort" name="bcl[sort]"><option value="desc" <?php selected( $s['sort'], 'desc' ); ?>>Neueste zuerst</option><option value="asc" <?php selected( $s['sort'], 'asc' ); ?>>Älteste zuerst</option></select>
						<p class="description"><code>sortierung="absteigend"</code> oder <code>"aufsteigend"</code></p>
					</td></tr>
					<tr><th scope="row"><label for="bcl-per">Einträge je Seite</label></th><td>
						<input id="bcl-per" type="number" min="1" max="200" name="bcl[per_page]" value="<?php echo (int) $s['per_page']; ?>" class="small-text">
						<p class="description"><code>anzahl="20"</code>; <code>anzahl="0"</code> = alle auf einer Seite</p>
					</td></tr>
					<tr><th scope="row">Filter für Besucher</th><td>
						<label style="margin-right:1.2em"><input type="checkbox" name="bcl[filters][]" value="jahr" <?php checked( in_array( 'jahr', $s['filters'], true ) ); ?>> Jahr</label>
						<label style="margin-right:1.2em"><input type="checkbox" name="bcl[filters][]" value="kategorie" <?php checked( in_array( 'kategorie', $s['filters'], true ) ); ?>> Kategorie</label>
						<p class="description"><code>filter="jahr,kategorie"</code> oder <code>filter="aus"</code>; feste Kategorie: <code>kategorie="Brand"</code>; nur besondere Einsätze: <code>nur_besondere="ja"</code></p>
					</td></tr>
					<tr><th scope="row">Detailseiten</th><td>
						<label><input type="checkbox" name="bcl[detail]" value="1" <?php checked( ! empty( $s['detail'] ) ); ?>> Je Einsatz eine eigene Seite (Einsatzmeldung in der Liste verlinkt)</label><br>
						<label>Adresse: <code><?php echo esc_html( home_url( '/' ) ); ?></code><input type="text" name="bcl[slug]" value="<?php echo esc_attr( $s['slug'] ); ?>" class="regular-text" style="width:12em"><code>/…</code></label>
					</td></tr>
				</table>
				<input type="hidden" name="bcl[filters][]" value="">
				<h2>Farben und Kategorien</h2>
				<table class="form-table" role="presentation">
					<tr><th scope="row">Akzentfarbe</th><td><input type="text" class="bcl-color" name="bcl[accent]" value="<?php echo esc_attr( $s['accent'] ); ?>" data-default-color=""><p class="description">Leer = Primärfarbe des Themes, sonst Rot. Für Jahresabschnitte, Hervorhebungen und Diagramme.</p></td></tr>
					<tr><th scope="row">Tabellenkopf</th><td>Hintergrund <input type="text" class="bcl-color" name="bcl[head_bg]" value="<?php echo esc_attr( $s['head_bg'] ); ?>"> Schrift <input type="text" class="bcl-color" name="bcl[head_fg]" value="<?php echo esc_attr( $s['head_fg'] ); ?>"><p class="description">Leer = Akzentfarbe mit weißer Schrift. Auf ausreichenden Kontrast achten (mindestens 4,5:1).</p></td></tr>
					<tr><th scope="row">Kategorien</th><td>
						<table class="widefat striped" style="max-width:40rem"><thead><tr><th>Kategorie</th><th>Farbe</th><th>Symbol</th></tr></thead><tbody>
						<?php
						$i = 0;
						foreach ( $cats + array( '' => array( 'color' => '', 'icon' => '' ) ) as $name => $c ) :
							?>
							<tr>
								<td><input type="text" name="bcl[categories][<?php echo (int) $i; ?>][name]" value="<?php echo esc_attr( (string) $name ); ?>" placeholder="weitere Kategorie" aria-label="Kategorie"></td>
								<td><input type="text" class="bcl-color" name="bcl[categories][<?php echo (int) $i; ?>][color]" value="<?php echo esc_attr( (string) $c['color'] ); ?>"></td>
								<td><select name="bcl[categories][<?php echo (int) $i; ?>][icon]" aria-label="Symbol">
									<?php foreach ( BlaulichtCMS_Bridge_Incidents::ICONS as $k => $label ) : ?>
										<option value="<?php echo esc_attr( $k ); ?>" <?php selected( (string) $c['icon'], $k ); ?>><?php echo esc_html( $label ); ?></option>
									<?php endforeach; ?>
								</select></td>
							</tr>
							<?php
							++$i;
						endforeach;
						?>
						</tbody></table>
						<p class="description">Kategorien kommen aus dem Stichwortverzeichnis in BlaulichtCMS (z. B. Brand, Hilfeleistung). Name leeren = Zeile entfernen.</p>
					</td></tr>
				</table>
				<h2>Statistik</h2>
				<table class="form-table" role="presentation">
					<tr><th scope="row">Ansichten</th><td>
						<?php
						foreach ( array( 'summe' => 'Anzahl im Jahr (mit Vorjahr)', 'monate' => 'Je Monat', 'kategorien' => 'Je Kategorie', 'jahre' => 'Je Jahr' ) as $k => $label ) {
							echo '<label style="margin-right:1.2em"><input type="checkbox" name="bcl[stats_views][]" value="' . esc_attr( $k ) . '"' . checked( in_array( $k, $s['stats_views'], true ), true, false ) . '> ' . esc_html( $label ) . '</label>';
						}
						?>
						<p class="description"><code>[blaulichtcms_einsatzstatistik ansicht="summe,monate,kategorien,jahre" jahr="aktuell" diagramm="balken" auswahl="ja"]</code> – <code>diagramm="aus"</code> zeigt nur Tabellen, <code>auswahl="nein"</code> blendet die Jahresauswahl aus.</p>
					</td></tr>
				</table>
				<?php submit_button( 'Speichern' ); ?>
			</form>
			<h2>Vorschau<?php echo $has ? '' : ' (Beispieldaten)'; ?></h2>
			<p class="description">So erscheinen Liste und Statistik mit den gespeicherten Einstellungen. Auf der Website kommen Schrift und Grundfarben vom Theme.</p>
			<div class="bcl-preview">
				<?php
				$a = BlaulichtCMS_Bridge_Incidents::list_atts( array() );
				// phpcs:ignore WordPress.Security.EscapeOutput -- in der Klasse escaped
				echo BlaulichtCMS_Bridge_Incidents::render_list( $a, $has ? null : BlaulichtCMS_Bridge_Incidents::demo_rows() );
				// phpcs:ignore WordPress.Security.EscapeOutput -- in der Klasse escaped
				echo BlaulichtCMS_Bridge_Incidents::render_stats( BlaulichtCMS_Bridge_Incidents::stats_atts( array( 'auswahl' => 'nein' ) ), $has ? null : BlaulichtCMS_Bridge_Incidents::demo_stats() );
				?>
			</div>
		</div>
		<?php
	}
}
