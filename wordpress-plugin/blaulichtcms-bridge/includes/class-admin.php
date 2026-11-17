<?php
/**
 * Einstellungsseite „Einstellungen → BlaulichtCMS Bridge“: Kopplung, Status, Abrufweg, automatische Updates, Beiträge
 * (Autor, Standardkategorie) und Darstellung der Hinweise (Farbe und Banner/Popup je Schweregrad, #186).
 *
 * @package BlaulichtCMSBridge
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class BlaulichtCMS_Bridge_Admin {
	const SLUG = 'blaulichtcms-bridge';

	public static function boot(): void {
		add_action( 'admin_menu', array( __CLASS__, 'menu' ) );
		add_action( 'admin_post_blaulichtcms_bridge_pair', array( __CLASS__, 'handle_pair' ) );
		add_action( 'admin_post_blaulichtcms_bridge_save', array( __CLASS__, 'handle_save' ) );
		add_action( 'admin_post_blaulichtcms_bridge_poll', array( __CLASS__, 'handle_poll' ) );
		add_action( 'admin_post_blaulichtcms_bridge_unpair', array( __CLASS__, 'handle_unpair' ) );
		add_filter( 'plugin_action_links_' . plugin_basename( BLAULICHTCMS_BRIDGE_FILE ), array( __CLASS__, 'links' ) );
		add_action( 'admin_enqueue_scripts', array( __CLASS__, 'assets' ) );
	}

	/** Stylesheet der Hinweise für die Vorschau auf der Einstellungsseite. */
	public static function assets( string $hook ): void {
		if ( 'settings_page_' . self::SLUG !== $hook ) {
			return;
		}
		wp_enqueue_style( 'blaulichtcms-bridge-banner', plugins_url( 'assets/banner.css', BLAULICHTCMS_BRIDGE_FILE ), array(), BLAULICHTCMS_BRIDGE_VERSION );
		wp_add_inline_style( 'blaulichtcms-bridge-banner', BlaulichtCMS_Bridge_Banners::inline_css() );
	}

	public static function links( array $links ): array {
		array_unshift( $links, '<a href="' . esc_url( admin_url( 'options-general.php?page=' . self::SLUG ) ) . '">' . esc_html__( 'Einstellungen', 'blaulichtcms-bridge' ) . '</a>' );
		return $links;
	}

	public static function menu(): void {
		add_options_page( 'BlaulichtCMS Bridge', 'BlaulichtCMS Bridge', 'manage_options', self::SLUG, array( __CLASS__, 'render' ) );
	}

	private static function back( string $notice, string $type = 'success' ): void {
		set_transient( 'blaulichtcms_bridge_notice_' . get_current_user_id(), array( $type, $notice ), 60 );
		wp_safe_redirect( admin_url( 'options-general.php?page=' . self::SLUG ) );
		exit;
	}

	private static function guard( string $action ): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'Keine Berechtigung.', 'blaulichtcms-bridge' ), 403 );
		}
		check_admin_referer( $action );
	}

	public static function handle_pair(): void {
		self::guard( 'blaulichtcms_bridge_pair' );
		$url  = isset( $_POST['blaulichtcms_url'] ) ? sanitize_text_field( wp_unslash( $_POST['blaulichtcms_url'] ) ) : '';
		$code = isset( $_POST['pairing_code'] ) ? sanitize_text_field( wp_unslash( $_POST['pairing_code'] ) ) : '';
		$r    = BlaulichtCMS_Bridge_Client::pair( $url, $code );
		if ( is_wp_error( $r ) ) {
			self::back( 'Kopplung fehlgeschlagen: ' . $r->get_error_message(), 'error' );
		}
		BlaulichtCMS_Bridge_Sync::activate();
		self::back( 'Gekoppelt mit BlaulichtCMS („' . BlaulichtCMS_Bridge_Settings::get( 'site_name' ) . '“). Aufträge werden ab jetzt jede Minute abgeholt.' );
	}

	public static function handle_save(): void {
		self::guard( 'blaulichtcms_bridge_save' );
		$mode  = isset( $_POST['author_mode'] ) ? sanitize_key( wp_unslash( $_POST['author_mode'] ) ) : 'bridge';
		$name  = isset( $_POST['author_name'] ) ? trim( sanitize_text_field( wp_unslash( $_POST['author_name'] ) ) ) : '';
		$patch = array(
			'author_mode' => in_array( $mode, BlaulichtCMS_Bridge_Authors::MODES, true ) ? $mode : 'bridge',
			'author_name' => '' !== $name ? ( function_exists( 'mb_substr' ) ? mb_substr( $name, 0, 100 ) : substr( $name, 0, 100 ) ) : 'Redaktion',
			'author_id'   => isset( $_POST['author_id'] ) ? absint( $_POST['author_id'] ) : 0,
			'category_id' => isset( $_POST['category_id'] ) ? absint( $_POST['category_id'] ) : 0,
			'banner_auto' => ! empty( $_POST['banner_auto'] ),
		);
		if ( 'fixed' === $patch['author_mode'] && ! $patch['author_id'] ) {
			$patch['author_mode'] = 'bridge';
		}
		foreach ( array_keys( BlaulichtCMS_Bridge_Settings::TONES ) as $tone ) {
			$display = isset( $_POST[ 'display_' . $tone ] ) ? sanitize_key( wp_unslash( $_POST[ 'display_' . $tone ] ) ) : '';
			$color   = isset( $_POST[ 'color_' . $tone ] ) ? sanitize_hex_color( wp_unslash( $_POST[ 'color_' . $tone ] ) ) : '';
			$patch[ 'display_' . $tone ] = isset( BlaulichtCMS_Bridge_Settings::DISPLAYS[ $display ] ) ? $display : BlaulichtCMS_Bridge_Settings::TONES[ $tone ]['display'];
			$patch[ 'color_' . $tone ]   = $color ? $color : BlaulichtCMS_Bridge_Settings::TONES[ $tone ]['color'];
		}
		BlaulichtCMS_Bridge_Settings::update( $patch );
		BlaulichtCMS_Bridge_Settings::status( array( 'report_hash' => '' ) ); // beim nächsten Abruf an BlaulichtCMS melden
		BlaulichtCMS_Bridge_Banners::purge_cache(); // neue Farben/Darstellung auch in zwischengespeicherten Seiten
		self::back( 'Gespeichert.' );
	}

	public static function handle_poll(): void {
		self::guard( 'blaulichtcms_bridge_poll' );
		$r = BlaulichtCMS_Bridge_Sync::poll( true );
		if ( is_wp_error( $r ) ) {
			self::back( 'Abruf fehlgeschlagen: ' . $r->get_error_message(), 'error' );
		}
		self::back( sprintf( 'Abruf erfolgreich – %d Auftrag/Aufträge verarbeitet.', (int) $r ) );
	}

	public static function handle_unpair(): void {
		self::guard( 'blaulichtcms_bridge_unpair' );
		$revoked = BlaulichtCMS_Bridge_Settings::is_paired() ? BlaulichtCMS_Bridge_Client::unpair() : true;
		BlaulichtCMS_Bridge_Settings::unpair();
		wp_clear_scheduled_hook( BlaulichtCMS_Bridge_Sync::HOOK );
		BlaulichtCMS_Bridge_Banners::clear();
		if ( is_wp_error( $revoked ) ) {
			self::back( 'Kopplung auf dieser Website gelöst, Hinweis-Banner entfernt. BlaulichtCMS war nicht erreichbar – bitte den Schlüssel dort zusätzlich widerrufen.', 'warning' );
		}
		self::back( 'Kopplung gelöst und Hinweis-Banner entfernt; der Schlüssel ist auch in BlaulichtCMS widerrufen.', 'success' );
	}

	/** Abrufweg in Worten. */
	private static function mode_text(): string {
		switch ( BlaulichtCMS_Bridge_Sync::mode() ) {
			case 'wp-cron':
				return 'WP-Cron (jede Minute, sobald jemand die Website aufruft)';
			case 'host':
				return 'Host-Cron';
			case 'self':
				return 'Selbstauslösung der Bridge (WP-Cron ist abgeschaltet)';
			case 'manual':
				return 'bisher nur „Jetzt abrufen“';
			default:
				return 'noch kein Abruf';
		}
	}

	private static function time_text( int $ts ): string {
		return $ts ? sprintf( '%s (vor %s)', wp_date( 'd.m.Y H:i:s', $ts ), human_time_diff( $ts ) ) : '–';
	}

	public static function render(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$s      = BlaulichtCMS_Bridge_Settings::all();
		$notice = get_transient( 'blaulichtcms_bridge_notice_' . get_current_user_id() );
		delete_transient( 'blaulichtcms_bridge_notice_' . get_current_user_id() );
		$next = wp_next_scheduled( BlaulichtCMS_Bridge_Sync::HOOK );
		$mode = BlaulichtCMS_Bridge_Authors::mode();
		?>
		<div class="wrap">
			<h1>BlaulichtCMS Bridge</h1>
			<?php if ( $notice ) : ?>
				<div class="notice notice-<?php echo esc_attr( $notice[0] ); ?> is-dismissible"><p><?php echo esc_html( $notice[1] ); ?></p></div>
			<?php endif; ?>

			<?php if ( ! BlaulichtCMS_Bridge_Settings::is_paired() ) : ?>
				<p>Die Bridge holt freigegebene Beiträge aus BlaulichtCMS ab und veröffentlicht sie auf dieser Website. WordPress braucht dafür keinen offenen Eingang.</p>
				<ol>
					<li>In BlaulichtCMS unter <strong>Kanäle → Websites → Website koppeln</strong> einen Kopplungscode erzeugen.</li>
					<li>Adresse von BlaulichtCMS und den Code hier eintragen.</li>
				</ol>
				<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
					<input type="hidden" name="action" value="blaulichtcms_bridge_pair" />
					<?php wp_nonce_field( 'blaulichtcms_bridge_pair' ); ?>
					<table class="form-table" role="presentation">
						<tr>
							<th scope="row"><label for="blaulichtcms_url">BlaulichtCMS-Adresse</label></th>
							<td><input name="blaulichtcms_url" id="blaulichtcms_url" type="url" class="regular-text code" required placeholder="https://blaulichtcms.example.org" value="<?php echo esc_attr( $s['url'] ); ?>" /></td>
						</tr>
						<tr>
							<th scope="row"><label for="pairing_code">Kopplungscode</label></th>
							<td><input name="pairing_code" id="pairing_code" type="text" class="regular-text code" required autocomplete="off" placeholder="XXXX-XXXX" /></td>
						</tr>
					</table>
					<?php submit_button( 'Koppeln' ); ?>
				</form>
			<?php else : ?>
				<h2>Status</h2>
				<table class="widefat striped" style="max-width:780px">
					<tbody>
						<tr><th scope="row">BlaulichtCMS</th><td><code><?php echo esc_html( $s['url'] ); ?></code></td></tr>
						<tr><th scope="row">Gekoppelt als</th><td><?php echo esc_html( $s['site_name'] ); ?></td></tr>
						<tr><th scope="row">Letzter Abruf</th><td><?php echo esc_html( self::time_text( (int) $s['last_poll'] ) ); ?></td></tr>
						<tr><th scope="row">Letzter erfolgreicher Abruf</th><td><?php echo esc_html( self::time_text( (int) $s['last_success'] ) ); ?></td></tr>
						<tr><th scope="row">Abrufweg</th><td><?php echo esc_html( self::mode_text() ); ?></td></tr>
						<?php if ( ! BlaulichtCMS_Bridge_Sync::wp_cron_disabled() ) : ?>
						<tr><th scope="row">Nächster geplanter Abruf</th><td><?php echo esc_html( $next ? wp_date( 'd.m.Y H:i:s', $next ) : 'nicht geplant' ); ?></td></tr>
						<?php endif; ?>
						<tr><th scope="row">Letzter Fehler</th><td><?php echo $s['last_error'] ? '<strong style="color:#b32d2e">' . esc_html( $s['last_error'] ) . '</strong>' : '–'; ?></td></tr>
						<tr><th scope="row">Version</th><td><?php echo esc_html( BLAULICHTCMS_BRIDGE_VERSION ); ?></td></tr>
						<tr><th scope="row">Update-Signatur</th><td><?php echo esc_html( BlaulichtCMS_Bridge_Signature::enforced() ? 'aktiv – Updates werden nur mit gültiger Signatur installiert' : 'nicht eingerichtet – Updates werden nur gegen die Prüfsumme aus BlaulichtCMS geprüft' ); ?></td></tr>
						<tr>
							<th scope="row">Automatische Updates</th>
							<td>
								<?php echo esc_html( BlaulichtCMS_Bridge_Updater::auto_update_enabled() ? 'an – WordPress installiert freigegebene Versionen selbst' : 'aus' ); ?>
								<?php if ( current_user_can( 'update_plugins' ) ) : ?>
									· <a href="<?php echo esc_url( self_admin_url( 'plugins.php' ) ); ?>">in der Plugin-Liste ändern („Automatische Updates aktivieren“)</a>
								<?php endif; ?>
								<?php if ( '' !== (string) $s['auto_update_note'] ) : ?>
									<br /><strong style="color:#b32d2e"><?php echo esc_html( $s['auto_update_note'] ); ?></strong>
								<?php endif; ?>
							</td>
						</tr>
					</tbody>
				</table>
				<?php if ( BlaulichtCMS_Bridge_Sync::wp_cron_disabled() ) : ?>
					<p style="max-width:780px">WP-Cron ist auf dieser Website abgeschaltet (<code>DISABLE_WP_CRON</code>). Ein Host-Cron ist trotzdem nicht nötig: Die Bridge stößt den Abruf selbst an, sobald jemand die Website aufruft, und holt dann auch ihre automatischen Updates nach. Bei sehr wenig Besuchern oder einem Seitencache, der PHP ganz umgeht, kann ein Abruf länger dauern – dann hilft optional ein Host-Cron: <code>* * * * * wp --path=/pfad/zu/wordpress blaulichtcms-bridge poll</code>.</p>
				<?php endif; ?>
				<?php if ( '' !== BlaulichtCMS_Bridge_Sync::hint() ) : ?>
					<div class="notice notice-warning inline"><p><?php echo esc_html( BlaulichtCMS_Bridge_Sync::hint() ); ?></p></div>
				<?php endif; ?>
				<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" style="margin-top:1em">
					<input type="hidden" name="action" value="blaulichtcms_bridge_poll" />
					<?php wp_nonce_field( 'blaulichtcms_bridge_poll' ); ?>
					<?php submit_button( 'Jetzt abrufen', 'secondary', 'submit', false ); ?>
				</form>

				<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
					<input type="hidden" name="action" value="blaulichtcms_bridge_save" />
					<?php wp_nonce_field( 'blaulichtcms_bridge_save' ); ?>
					<h2>Beiträge</h2>
					<p class="description" style="max-width:780px">Titel, Text, Kurzfassung, Titelbild, Medien und Kategorie kommen aus BlaulichtCMS. Wie ein Beitrag aussieht (Schrift, Aufbau, Beitragsbild, Autorenangabe), bestimmt das Theme dieser Website.</p>
					<table class="form-table" role="presentation">
						<tr>
							<th scope="row">Autor</th>
							<td>
								<fieldset>
									<legend class="screen-reader-text">Autor der Beiträge</legend>
									<label><input type="radio" name="author_mode" value="bridge" <?php checked( 'bridge', $mode ); ?> /> Eigener Autor der Bridge</label><br />
									<label><input type="radio" name="author_mode" value="person" <?php checked( 'person', $mode ); ?> /> Person aus BlaulichtCMS (je Person ein eigener Autor)</label><br />
									<label><input type="radio" name="author_mode" value="fixed" <?php checked( 'fixed', $mode ); ?> /> Vorhandener Benutzer:</label>
									<?php
									wp_dropdown_users(
										array(
											'name'              => 'author_id',
											'id'                => 'author_id',
											'selected'          => (int) $s['author_id'],
											'show_option_none'  => '– bitte wählen –',
											'option_none_value' => 0,
											'capability'        => array( 'publish_posts' ),
										)
									);
									?>
								</fieldset>
								<p>
									<label for="author_name">Anzeigename des eigenen Autors</label><br />
									<input name="author_name" id="author_name" type="text" class="regular-text" maxlength="100" value="<?php echo esc_attr( (string) $s['author_name'] ); ?>" />
								</p>
								<p class="description" style="max-width:640px">Die Bridge legt den eigenen Autor bzw. die Autoren aus BlaulichtCMS beim ersten Beitrag selbst an – mit der Rolle „BlaulichtCMS-Autor“ ohne Rechte und ohne Anmeldung (kein Passwort bekannt, keine E-Mail-Adresse, Anmeldung gesperrt). Für „Person aus BlaulichtCMS“ muss in BlaulichtCMS bei dieser Website „Autorenname übertragen“ eingeschaltet sein<?php echo esc_html( $s['send_author'] ? ' (ist eingeschaltet)' : ' (ist derzeit aus – es gilt der eigene Autor)' ); ?>.</p>
							</td>
						</tr>
						<tr>
							<th scope="row"><label for="category_id">Standardkategorie</label></th>
							<td>
								<?php
								wp_dropdown_categories(
									array(
										'name'              => 'category_id',
										'id'                => 'category_id',
										'selected'          => (int) $s['category_id'],
										'show_option_none'  => '– Standard von WordPress –',
										'option_none_value' => 0,
										'hide_empty'        => false,
										'hierarchical'      => true,
									)
								);
								?>
								<p class="description">Gilt, wenn im Beitrag oder im Ausgang der Automation in BlaulichtCMS keine Kategorie gewählt ist. Die Kategorien dieser Website meldet die Bridge an BlaulichtCMS.</p>
							</td>
						</tr>
					</table>

					<h2>Darstellung der Hinweise</h2>
					<p class="description" style="max-width:780px">Der Schweregrad ist die Art, die in BlaulichtCMS beim Hinweis gewählt wird. Je Schweregrad hier Farbe und Darstellung festlegen. <strong>Banner</strong> erscheint am Seitenanfang bzw. an der Stelle des Shortcodes <code>[blaulichtcms_banner]</code> oder des Blocks „BlaulichtCMS: Hinweise“, solange der Hinweis gilt. <strong>Popup</strong> öffnet sich beim Aufruf der Seite als Dialog; wer ihn schließt, sieht denselben Hinweis in diesem Browser nicht erneut. Ein einzelner Hinweis kann in BlaulichtCMS eine feste Darstellung haben.</p>
					<table class="form-table" role="presentation">
						<?php foreach ( BlaulichtCMS_Bridge_Settings::TONES as $tone => $def ) : ?>
							<tr>
								<th scope="row"><?php echo esc_html( $def['label'] ); ?></th>
								<td>
									<label for="<?php echo esc_attr( 'display_' . $tone ); ?>">Darstellung</label>
									<select name="<?php echo esc_attr( 'display_' . $tone ); ?>" id="<?php echo esc_attr( 'display_' . $tone ); ?>">
										<?php foreach ( BlaulichtCMS_Bridge_Settings::DISPLAYS as $value => $text ) : ?>
											<option value="<?php echo esc_attr( $value ); ?>" <?php selected( BlaulichtCMS_Bridge_Settings::display_for_tone( $tone ), $value ); ?>><?php echo esc_html( $text ); ?></option>
										<?php endforeach; ?>
									</select>
									&nbsp; <label for="<?php echo esc_attr( 'color_' . $tone ); ?>">Farbe</label>
									<input type="color" name="<?php echo esc_attr( 'color_' . $tone ); ?>" id="<?php echo esc_attr( 'color_' . $tone ); ?>" value="<?php echo esc_attr( BlaulichtCMS_Bridge_Settings::color_for_tone( $tone ) ); ?>" />
									<span class="description">Vorgabe <?php echo esc_html( $def['color'] ); ?></span>
								</td>
							</tr>
						<?php endforeach; ?>
						<tr>
							<th scope="row">Banner</th>
							<td>
								<label><input type="checkbox" name="banner_auto" value="1" <?php checked( false !== $s['banner_auto'] && '0' !== $s['banner_auto'] ); ?> /> automatisch am Seitenanfang anzeigen</label>
								<p class="description">Ohne diese Einstellung erscheinen Banner nur über Shortcode <code>[blaulichtcms_banner]</code> oder Block „BlaulichtCMS: Hinweise“. Popups erscheinen immer, wenn ein Schweregrad auf „Popup“ steht. Einsatzübersicht: <code>[blaulichtcms_einsaetze anzahl="10"]</code>. Alle Shortcodes mit Beispielen: <a href="<?php echo esc_url( admin_url( 'options-general.php?page=' . BlaulichtCMS_Bridge_Incidents_Admin::SLUG . '&tab=shortcodes' ) ); ?>">Einstellungen → BlaulichtCMS Einsatzliste → Shortcodes</a>. Aktuell gespeichert: <?php echo (int) count( BlaulichtCMS_Bridge_Banners::all() ); ?> Hinweis(e).</p>
							</td>
						</tr>
						<tr>
							<th scope="row">Vorschau</th>
							<td>
								<div style="max-width:780px;display:flex;flex-direction:column;gap:6px">
									<?php
									foreach ( BlaulichtCMS_Bridge_Settings::TONES as $tone => $def ) {
										echo BlaulichtCMS_Bridge_Banners::banner_html( // phpcs:ignore WordPress.Security.EscapeOutput -- in banner_html() escaped
											array(
												'tone'      => $tone,
												'title'     => $def['label'] . ': Beispiel',
												'text'      => 'So erscheint ein Banner dieses Schweregrads (gespeicherte Farben).',
												'link_url'  => '',
												'link_text' => '',
												'starts_at' => 0,
												'ends_at'   => 0,
											),
											false,
											true
										);
									}
									?>
								</div>
							</td>
						</tr>
					</table>
					<?php submit_button( 'Speichern' ); ?>
				</form>

				<h2>Kopplung</h2>
				<p>Der Schlüssel gilt nur für diese Website. In BlaulichtCMS lässt er sich jederzeit widerrufen.</p>
				<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" onsubmit="return confirm('Kopplung wirklich lösen?');">
					<input type="hidden" name="action" value="blaulichtcms_bridge_unpair" />
					<?php wp_nonce_field( 'blaulichtcms_bridge_unpair' ); ?>
					<?php submit_button( 'Kopplung lösen', 'delete', 'submit', false ); ?>
				</form>
			<?php endif; ?>
		</div>
		<?php
	}
}
