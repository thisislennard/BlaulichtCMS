<?php
/**
 * Einstellungsseite „Einstellungen → BlaulichtCMS Bridge“: Kopplung, Status, Autor/Kategorie, Abruf.
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
		BlaulichtCMS_Bridge_Settings::update(
			array(
				'author_id'   => isset( $_POST['author_id'] ) ? absint( $_POST['author_id'] ) : 0,
				'category_id' => isset( $_POST['category_id'] ) ? absint( $_POST['category_id'] ) : 0,
				'banner_auto' => ! empty( $_POST['banner_auto'] ),
			)
		);
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
						<tr><th scope="row">Nächster geplanter Abruf</th><td><?php echo esc_html( $next ? wp_date( 'd.m.Y H:i:s', $next ) : 'nicht geplant' ); ?></td></tr>
						<tr><th scope="row">Letzter Fehler</th><td><?php echo $s['last_error'] ? '<strong style="color:#b32d2e">' . esc_html( $s['last_error'] ) . '</strong>' : '–'; ?></td></tr>
						<tr><th scope="row">Version</th><td><?php echo esc_html( BLAULICHTCMS_BRIDGE_VERSION ); ?></td></tr>
						<tr><th scope="row">Update-Signatur</th><td><?php echo esc_html( BlaulichtCMS_Bridge_Signature::enforced() ? 'aktiv – Updates werden nur mit gültiger Signatur installiert' : 'nicht eingerichtet – Updates werden nur gegen die Prüfsumme aus BlaulichtCMS geprüft' ); ?></td></tr>
					</tbody>
				</table>
				<?php if ( defined( 'DISABLE_WP_CRON' ) && DISABLE_WP_CRON ) : ?>
					<p><strong>WP-Cron ist deaktiviert.</strong> Bitte einen Host-Cron einrichten, z. B. <code>* * * * * wp --path=/pfad/zu/wordpress blaulichtcms-bridge poll</code>.</p>
				<?php endif; ?>
				<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" style="margin-top:1em">
					<input type="hidden" name="action" value="blaulichtcms_bridge_poll" />
					<?php wp_nonce_field( 'blaulichtcms_bridge_poll' ); ?>
					<?php submit_button( 'Jetzt abrufen', 'secondary', 'submit', false ); ?>
				</form>

				<h2>Beiträge</h2>
				<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
					<input type="hidden" name="action" value="blaulichtcms_bridge_save" />
					<?php wp_nonce_field( 'blaulichtcms_bridge_save' ); ?>
					<table class="form-table" role="presentation">
						<tr>
							<th scope="row"><label for="author_id">Autor</label></th>
							<td>
								<?php
								wp_dropdown_users(
									array(
										'name'             => 'author_id',
										'id'               => 'author_id',
										'selected'         => (int) $s['author_id'],
										'show_option_none' => '– Standard –',
										'option_none_value' => 0,
										'capability'       => array( 'publish_posts' ),
									)
								);
								?>
							</td>
						</tr>
						<tr>
							<th scope="row"><label for="category_id">Kategorie</label></th>
							<td>
								<?php
								wp_dropdown_categories(
									array(
										'name'              => 'category_id',
										'id'                => 'category_id',
										'selected'          => (int) $s['category_id'],
										'show_option_none'  => '– Standard –',
										'option_none_value' => 0,
										'hide_empty'        => false,
									)
								);
								?>
							</td>
						</tr>
						<tr>
							<th scope="row">Hinweis-Banner</th>
							<td>
								<label><input type="checkbox" name="banner_auto" value="1" <?php checked( false !== $s['banner_auto'] ); ?> /> automatisch am Seitenanfang anzeigen</label>
								<p class="description">Alternativ per Shortcode <code>[blaulichtcms_banner]</code> oder Block „BlaulichtCMS: Hinweise“ platzieren. Einsatzübersicht: <code>[blaulichtcms_einsaetze anzahl="10"]</code>. Aktuell gespeichert: <?php echo (int) count( BlaulichtCMS_Bridge_Banners::all() ); ?> Banner.</p>
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
