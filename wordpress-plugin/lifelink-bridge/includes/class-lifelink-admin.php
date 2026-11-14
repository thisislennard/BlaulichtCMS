<?php
/**
 * Admin-Seite Einstellungen → LifeLink.
 *
 * @package LifeLink
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Admin-Oberfläche: Verbindung, Schlüssel, Einstellungen, Banner, Verlauf.
 */
final class LifeLink_Admin {

	private const SLUG       = 'lifelink';
	private const CAPABILITY = 'manage_options';
	private const ONCE_TTL   = 300;

	/**
	 * Hook-Suffix der Einstellungsseite.
	 *
	 * @var string
	 */
	private string $hook_suffix = '';

	/**
	 * Konstruktor.
	 *
	 * @param LifeLink_Settings          $settings   Einstellungen.
	 * @param LifeLink_Keys              $keys       Schlüssel.
	 * @param LifeLink_Audit_Log         $audit      Audit-Log.
	 * @param LifeLink_Banner_Repository $repository Banner.
	 * @param LifeLink_Targets           $targets    Zielseiten.
	 * @param LifeLink_Renderer          $renderer   Renderer.
	 * @param LifeLink_Cache_Purger      $purger     Cache-Purger.
	 * @param LifeLink_Cron              $cron       Zeitsteuerung.
	 */
	public function __construct(
		private LifeLink_Settings $settings,
		private LifeLink_Keys $keys,
		private LifeLink_Audit_Log $audit,
		private LifeLink_Banner_Repository $repository,
		private LifeLink_Targets $targets,
		private LifeLink_Renderer $renderer,
		private LifeLink_Cache_Purger $purger,
		private LifeLink_Cron $cron
	) {}

	/**
	 * Hooks registrieren.
	 */
	public function register(): void {
		add_action( 'admin_menu', array( $this, 'add_menu' ) );
		add_action( 'admin_enqueue_scripts', array( $this, 'enqueue' ) );
		add_action( 'admin_post_lifelink_generate_key', array( $this, 'handle_generate_key' ) );
		add_action( 'admin_post_lifelink_revoke_key', array( $this, 'handle_revoke_key' ) );
		add_action( 'admin_post_lifelink_save_settings', array( $this, 'handle_save_settings' ) );
		add_action( 'admin_post_lifelink_deactivate_banner', array( $this, 'handle_deactivate_banner' ) );
		add_filter( 'plugin_action_links_' . plugin_basename( LIFELINK_FILE ), array( $this, 'action_links' ) );
	}

	/**
	 * Menüeintrag unter Einstellungen.
	 */
	public function add_menu(): void {
		$hook = add_options_page(
			__( 'LifeLink', 'lifelink' ),
			__( 'LifeLink', 'lifelink' ),
			self::CAPABILITY,
			self::SLUG,
			array( $this, 'render_page' )
		);
		$this->hook_suffix = is_string( $hook ) ? $hook : '';
	}

	/**
	 * Link "Einstellungen" in der Pluginliste.
	 *
	 * @param array $links Links.
	 * @return array
	 */
	public function action_links( $links ) {
		$links   = is_array( $links ) ? $links : array();
		$settings = sprintf(
			'<a href="%1$s">%2$s</a>',
			esc_url( $this->page_url() ),
			esc_html__( 'Einstellungen', 'lifelink' )
		);
		array_unshift( $links, $settings );
		return $links;
	}

	/**
	 * Assets nur auf der eigenen Seite laden.
	 *
	 * @param string $hook Hook-Suffix.
	 */
	public function enqueue( $hook ): void {
		if ( '' === $this->hook_suffix || $hook !== $this->hook_suffix ) {
			return;
		}
		wp_enqueue_style( 'lifelink-banners', LIFELINK_URL . 'assets/lifelink.css', array(), LIFELINK_VERSION );
		wp_enqueue_style( 'lifelink-admin', LIFELINK_URL . 'assets/admin.css', array( 'lifelink-banners' ), LIFELINK_VERSION );
		wp_enqueue_script( 'lifelink-admin', LIFELINK_URL . 'assets/admin.js', array(), LIFELINK_VERSION, true );
		wp_localize_script(
			'lifelink-admin',
			'lifelinkAdmin',
			array(
				'copied'     => __( 'Kopiert.', 'lifelink' ),
				'copyFailed' => __( 'Kopieren nicht möglich – bitte manuell markieren und kopieren.', 'lifelink' ),
			)
		);
	}

	/**
	 * URL der Einstellungsseite.
	 *
	 * @param array $args Query-Argumente.
	 */
	private function page_url( array $args = array() ): string {
		return add_query_arg( array_merge( array( 'page' => self::SLUG ), $args ), admin_url( 'options-general.php' ) );
	}

	/**
	 * Berechtigung und Nonce prüfen.
	 *
	 * @param string $action Nonce-Aktion.
	 */
	private function guard( string $action ): void {
		if ( ! current_user_can( self::CAPABILITY ) ) {
			wp_die( esc_html__( 'Sie haben keine Berechtigung für diese Aktion.', 'lifelink' ), '', array( 'response' => 403 ) );
		}
		check_admin_referer( $action );
	}

	/**
	 * Zurück zur Einstellungsseite mit Meldungscode.
	 *
	 * @param string $message Meldungscode.
	 */
	private function back( string $message ): never {
		wp_safe_redirect( $this->page_url( array( 'lifelink_msg' => $message ) ) );
		exit;
	}

	/**
	 * Akteur für das Protokoll.
	 */
	private function actor(): string {
		$user = wp_get_current_user();
		return 'admin:' . ( $user instanceof WP_User && $user->exists() ? $user->user_login : '?' );
	}

	/**
	 * Name des Einmal-Transients für das neue Geheimnis.
	 */
	private function once_name(): string {
		return 'lifelink_once_' . get_current_user_id();
	}

	/**
	 * Schlüssel erzeugen.
	 */
	public function handle_generate_key(): void {
		$this->guard( 'lifelink_generate_key' );
		$result = $this->keys->generate();
		if ( is_wp_error( $result ) ) {
			$this->back( 'too_many' );
		}
		// Nur für die einmalige Anzeige nach dem Redirect; wird beim Anzeigen sofort gelöscht.
		set_transient( $this->once_name(), $result, self::ONCE_TTL );
		$this->audit->add( $this->actor(), 'key.generate', $result['id'], 'ok' );
		$this->back( 'key_created' );
	}

	/**
	 * Schlüssel widerrufen.
	 */
	public function handle_revoke_key(): void {
		$this->guard( 'lifelink_revoke_key' );
		$key_id = isset( $_POST['key_id'] ) ? sanitize_text_field( wp_unslash( $_POST['key_id'] ) ) : '';
		if ( ! LifeLink_Keys::is_key_id( $key_id ) || ! $this->keys->revoke( $key_id ) ) {
			$this->back( 'revoke_failed' );
		}
		$this->audit->add( $this->actor(), 'key.revoke', $key_id, 'ok' );
		$this->back( 'key_revoked' );
	}

	/**
	 * Einstellungen speichern.
	 */
	public function handle_save_settings(): void {
		$this->guard( 'lifelink_save_settings' );

		// phpcs:disable WordPress.Security.NonceVerification.Missing -- verified in guard().
		$author_id = isset( $_POST['lifelink_author_id'] ) ? absint( wp_unslash( $_POST['lifelink_author_id'] ) ) : 0;
		if ( $author_id > 0 ) {
			$user = get_userdata( $author_id );
			if ( ! $user instanceof WP_User || ! user_can( $user, 'edit_posts' ) ) {
				$this->back( 'author_invalid' );
			}
		}

		$this->settings->update(
			array(
				'author_id'        => $author_id,
				'allow_future'     => ! empty( $_POST['lifelink_allow_future'] ),
				'allow_categories' => ! empty( $_POST['lifelink_allow_categories'] ),
				'auto_output'      => ! empty( $_POST['lifelink_auto_output'] ),
				'refresh'          => ! empty( $_POST['lifelink_refresh'] ),
			)
		);
		// phpcs:enable

		$this->audit->add( $this->actor(), 'settings.save', '-', 'ok' );
		$this->purger->purge( array( 'all' ) );
		$this->back( 'settings_saved' );
	}

	/**
	 * Banner manuell deaktivieren.
	 */
	public function handle_deactivate_banner(): void {
		$this->guard( 'lifelink_deactivate_banner' );
		$external_id = isset( $_POST['external_id'] ) ? sanitize_text_field( wp_unslash( $_POST['external_id'] ) ) : '';
		if ( ! LifeLink_Validator::is_uuid( $external_id ) ) {
			$this->back( 'banner_unknown' );
		}
		$external_id = strtolower( $external_id );
		$row         = $this->repository->deactivate( $external_id );
		if ( null === $row ) {
			$this->back( 'banner_unknown' );
		}
		$this->cron->clear_transitions( $external_id );
		$this->purger->purge( LifeLink_Banner_Repository::pages( $row ) );
		$this->cron->remember_fingerprint();
		$this->audit->add( $this->actor(), 'banner.deactivate', $external_id, 'ok' );
		$this->back( 'banner_deactivated' );
	}

	/**
	 * Meldungstexte (feste Codes, keine reflektierten Eingaben).
	 *
	 * @return array<string,array{0:string,1:string}>
	 */
	private function messages(): array {
		return array(
			'key_created'        => array( 'success', __( 'Schlüssel erzeugt.', 'lifelink' ) ),
			'key_revoked'        => array( 'success', __( 'Schlüssel widerrufen. Er ist ab sofort ungültig.', 'lifelink' ) ),
			'revoke_failed'      => array( 'error', __( 'Schlüssel konnte nicht widerrufen werden.', 'lifelink' ) ),
			'too_many'           => array( 'error', __( 'Es sind bereits zwei gültige Schlüssel vorhanden. Widerrufen Sie zuerst einen.', 'lifelink' ) ),
			'settings_saved'     => array( 'success', __( 'Einstellungen gespeichert.', 'lifelink' ) ),
			'author_invalid'     => array( 'error', __( 'Der gewählte Benutzer darf keine Beiträge bearbeiten.', 'lifelink' ) ),
			'banner_deactivated' => array( 'success', __( 'Banner deaktiviert.', 'lifelink' ) ),
			'banner_unknown'     => array( 'error', __( 'Banner nicht gefunden.', 'lifelink' ) ),
		);
	}

	/**
	 * Formatiert eine Zeit in der Zeitzone der Website.
	 *
	 * @param int|null $timestamp Unix-Zeit.
	 */
	private function format_time( ?int $timestamp ): string {
		if ( null === $timestamp || $timestamp <= 0 ) {
			return '—';
		}
		$formatted = wp_date( get_option( 'date_format' ) . ' ' . get_option( 'time_format' ), $timestamp );
		return false === $formatted ? '—' : $formatted;
	}

	/**
	 * Rendert die Seite.
	 */
	public function render_page(): void {
		if ( ! current_user_can( self::CAPABILITY ) ) {
			wp_die( esc_html__( 'Sie haben keine Berechtigung, diese Seite aufzurufen.', 'lifelink' ), '', array( 'response' => 403 ) );
		}

		// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- display only, fixed message codes.
		$code     = isset( $_GET['lifelink_msg'] ) ? sanitize_key( wp_unslash( $_GET['lifelink_msg'] ) ) : '';
		$messages = $this->messages();

		echo '<div class="wrap lifelink-admin">';
		echo '<h1>' . esc_html__( 'LifeLink', 'lifelink' ) . '</h1>';

		if ( isset( $messages[ $code ] ) ) {
			printf(
				'<div class="notice notice-%1$s is-dismissible"><p>%2$s</p></div>',
				esc_attr( $messages[ $code ][0] ),
				esc_html( $messages[ $code ][1] )
			);
		}

		if ( 'key_created' === $code ) {
			$this->render_once_secret();
		}

		$this->render_connection();
		$this->render_keys();
		$this->render_settings();
		$this->render_banners();
		$this->render_audit();

		echo '</div>';
	}

	/**
	 * Zeigt das neue Geheimnis genau einmal an.
	 */
	private function render_once_secret(): void {
		$once = get_transient( $this->once_name() );
		delete_transient( $this->once_name() );
		if ( ! is_array( $once ) || empty( $once['id'] ) || empty( $once['secret'] ) ) {
			return;
		}
		?>
		<div class="notice notice-warning lifelink-secret">
			<h2><?php esc_html_e( 'Neuer Schlüssel – jetzt kopieren', 'lifelink' ); ?></h2>
			<p><strong><?php esc_html_e( 'Das Geheimnis wird nur dieses eine Mal angezeigt.', 'lifelink' ); ?></strong>
				<?php esc_html_e( 'Kopieren Sie Schlüssel-ID, Geheimnis und Website-URL und tragen Sie sie in LifeLink im Einrichtungsassistenten („WordPress verbinden“) ein. Nach dem Verlassen dieser Seite kann das Geheimnis nicht mehr angezeigt werden – erzeugen Sie dann einen neuen Schlüssel.', 'lifelink' ); ?></p>
			<table class="form-table" role="presentation">
				<?php
				$fields = array(
					'lifelink-new-key-id' => array( __( 'Schlüssel-ID', 'lifelink' ), (string) $once['id'] ),
					'lifelink-new-secret' => array( __( 'Geheimnis', 'lifelink' ), (string) $once['secret'] ),
					'lifelink-site-url'   => array( __( 'Website-URL', 'lifelink' ), home_url() ),
				);
				foreach ( $fields as $id => $field ) :
					?>
					<tr>
						<th scope="row"><label for="<?php echo esc_attr( $id ); ?>"><?php echo esc_html( $field[0] ); ?></label></th>
						<td>
							<input type="text" id="<?php echo esc_attr( $id ); ?>" class="regular-text code" value="<?php echo esc_attr( $field[1] ); ?>" readonly autocomplete="off" spellcheck="false">
							<button type="button" class="button lifelink-copy" data-lifelink-copy="<?php echo esc_attr( $id ); ?>"><?php esc_html_e( 'Kopieren', 'lifelink' ); ?></button>
						</td>
					</tr>
				<?php endforeach; ?>
			</table>
			<p class="lifelink-copy-status" aria-live="polite"></p>
		</div>
		<?php
	}

	/**
	 * Verbindungsstatus.
	 */
	private function render_connection(): void {
		$valid     = $this->keys->valid();
		$last_used = null;
		foreach ( array_keys( $valid ) as $id ) {
			$used = $this->keys->last_used( $id );
			if ( null !== $used && ( null === $last_used || $used > $last_used ) ) {
				$last_used = $used;
			}
		}
		$error = $this->audit->last_error();
		?>
		<h2><?php esc_html_e( 'Verbindung', 'lifelink' ); ?></h2>
		<table class="form-table" role="presentation">
			<tr>
				<th scope="row"><?php esc_html_e( 'Status', 'lifelink' ); ?></th>
				<td>
					<?php if ( empty( $valid ) ) : ?>
						<span class="lifelink-badge lifelink-badge--deaktiviert"><?php esc_html_e( 'Nicht verbunden', 'lifelink' ); ?></span>
						<?php esc_html_e( 'Erzeugen Sie einen Schlüssel und tragen Sie ihn in LifeLink ein.', 'lifelink' ); ?>
					<?php elseif ( null === $last_used ) : ?>
						<span class="lifelink-badge lifelink-badge--geplant"><?php esc_html_e( 'Wartet auf erste Anfrage', 'lifelink' ); ?></span>
					<?php else : ?>
						<span class="lifelink-badge lifelink-badge--aktiv"><?php esc_html_e( 'Verbunden', 'lifelink' ); ?></span>
						<?php
						/* translators: %s: date and time */
						echo esc_html( sprintf( __( 'Letzte erfolgreiche Anfrage: %s', 'lifelink' ), $this->format_time( $last_used ) ) );
						?>
					<?php endif; ?>
				</td>
			</tr>
			<?php foreach ( $valid as $id => $key ) : ?>
				<tr>
					<th scope="row"><code><?php echo esc_html( $id ); ?></code></th>
					<td>
						<?php
						/* translators: %s: date and time */
						echo esc_html( sprintf( __( 'Letzte erfolgreiche Anfrage: %s', 'lifelink' ), $this->format_time( $this->keys->last_used( $id ) ) ) );
						?>
					</td>
				</tr>
			<?php endforeach; ?>
			<tr>
				<th scope="row"><?php esc_html_e( 'Letzte Abweisung', 'lifelink' ); ?></th>
				<td>
					<?php
					if ( null === $error ) {
						esc_html_e( 'Keine', 'lifelink' );
					} else {
						echo esc_html( $this->format_time( $error['time'] ) . ' – ' . $error['code'] . ( '' !== $error['key_id'] ? ' (' . $error['key_id'] . ')' : '' ) );
					}
					?>
				</td>
			</tr>
			<tr>
				<th scope="row"><?php esc_html_e( 'Website-URL für LifeLink', 'lifelink' ); ?></th>
				<td><code><?php echo esc_html( home_url() ); ?></code></td>
			</tr>
			<tr>
				<th scope="row"><?php esc_html_e( 'Schnittstelle', 'lifelink' ); ?></th>
				<td><code><?php echo esc_html( rest_url( LifeLink_REST_Controller::REST_NAMESPACE . '/' ) ); ?></code></td>
			</tr>
		</table>
		<?php
	}

	/**
	 * Schlüsselliste und Aktionen.
	 */
	private function render_keys(): void {
		$all   = $this->keys->all();
		$valid = $this->keys->valid();
		?>
		<h2><?php esc_html_e( 'Schlüssel', 'lifelink' ); ?></h2>
		<p class="description"><?php esc_html_e( 'Höchstens zwei Schlüssel sind gleichzeitig gültig. Zum Wechseln einen neuen Schlüssel erzeugen, in LifeLink eintragen und danach den alten widerrufen. Widerrufen wirkt sofort.', 'lifelink' ); ?></p>
		<table class="widefat striped lifelink-table">
			<thead>
				<tr>
					<th scope="col"><?php esc_html_e( 'Schlüssel-ID', 'lifelink' ); ?></th>
					<th scope="col"><?php esc_html_e( 'Erzeugt', 'lifelink' ); ?></th>
					<th scope="col"><?php esc_html_e( 'Zuletzt benutzt', 'lifelink' ); ?></th>
					<th scope="col"><?php esc_html_e( 'Zustand', 'lifelink' ); ?></th>
					<th scope="col"><?php esc_html_e( 'Aktion', 'lifelink' ); ?></th>
				</tr>
			</thead>
			<tbody>
				<?php if ( empty( $all ) ) : ?>
					<tr><td colspan="5"><?php esc_html_e( 'Noch kein Schlüssel vorhanden.', 'lifelink' ); ?></td></tr>
				<?php endif; ?>
				<?php foreach ( array_reverse( $all, true ) as $id => $key ) : ?>
					<?php $is_valid = isset( $valid[ $id ] ); ?>
					<tr>
						<td><code><?php echo esc_html( $id ); ?></code></td>
						<td><?php echo esc_html( $this->format_time( $key['created_at'] ) ); ?></td>
						<td><?php echo esc_html( $this->format_time( $this->keys->last_used( $id ) ) ); ?></td>
						<td>
							<?php if ( $is_valid ) : ?>
								<span class="lifelink-badge lifelink-badge--aktiv"><?php esc_html_e( 'Gültig', 'lifelink' ); ?></span>
							<?php else : ?>
								<span class="lifelink-badge lifelink-badge--deaktiviert">
									<?php
									/* translators: %s: date and time */
									echo esc_html( sprintf( __( 'Widerrufen am %s', 'lifelink' ), $this->format_time( $key['revoked_at'] ) ) );
									?>
								</span>
							<?php endif; ?>
						</td>
						<td>
							<?php if ( $is_valid ) : ?>
								<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" class="lifelink-inline-form">
									<input type="hidden" name="action" value="lifelink_revoke_key">
									<input type="hidden" name="key_id" value="<?php echo esc_attr( $id ); ?>">
									<?php wp_nonce_field( 'lifelink_revoke_key' ); ?>
									<button type="submit" class="button button-link-delete" data-lifelink-confirm="<?php esc_attr_e( 'Diesen Schlüssel wirklich widerrufen? LifeLink kann ihn danach sofort nicht mehr verwenden.', 'lifelink' ); ?>"><?php esc_html_e( 'Widerrufen', 'lifelink' ); ?></button>
								</form>
							<?php else : ?>
								—
							<?php endif; ?>
						</td>
					</tr>
				<?php endforeach; ?>
			</tbody>
		</table>
		<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" class="lifelink-generate">
			<input type="hidden" name="action" value="lifelink_generate_key">
			<?php wp_nonce_field( 'lifelink_generate_key' ); ?>
			<?php if ( count( $valid ) >= LifeLink_Keys::MAX_VALID ) : ?>
				<button type="submit" class="button button-primary" disabled><?php esc_html_e( 'Neuen Schlüssel erzeugen', 'lifelink' ); ?></button>
				<span class="description"><?php esc_html_e( 'Es sind bereits zwei gültige Schlüssel vorhanden.', 'lifelink' ); ?></span>
			<?php else : ?>
				<button type="submit" class="button button-primary">
					<?php echo empty( $valid ) ? esc_html__( 'Schlüssel erzeugen', 'lifelink' ) : esc_html__( 'Neuen Schlüssel erzeugen', 'lifelink' ); ?>
				</button>
			<?php endif; ?>
		</form>
		<?php
	}

	/**
	 * Einstellungen.
	 */
	private function render_settings(): void {
		$settings = $this->settings->all();
		$dropdown = wp_dropdown_users(
			array(
				'capability'        => array( 'edit_posts' ),
				'name'              => 'lifelink_author_id',
				'id'                => 'lifelink-author-id',
				'selected'          => (int) $settings['author_id'],
				'show_option_none'  => __( '— Bitte wählen —', 'lifelink' ),
				'option_none_value' => '0',
				'echo'              => false,
			)
		);
		$checkboxes = array(
			'lifelink_allow_future'     => array( (bool) $settings['allow_future'], __( 'Geplante Veröffentlichung durch LifeLink erlauben', 'lifelink' ), __( 'Aus: Beiträge mit Status „geplant“ werden als „Ausstehender Review“ angelegt und erst in WordPress freigegeben.', 'lifelink' ) ),
			'lifelink_allow_categories' => array( (bool) $settings['allow_categories'], __( 'Anlegen von Kategorien erlauben', 'lifelink' ), __( 'Aus: Unbekannte Kategorien werden ignoriert.', 'lifelink' ) ),
			'lifelink_auto_output'      => array( (bool) $settings['auto_output'], __( 'Banner automatisch am Seitenanfang ausgeben', 'lifelink' ), __( 'Nutzt den Theme-Hook wp_body_open. Ausschalten, wenn Sie Shortcode [lifelink_banners], Block oder Widget verwenden.', 'lifelink' ) ),
			'lifelink_refresh'          => array( (bool) $settings['refresh'], __( 'Banner im Browser nachladen', 'lifelink' ), __( 'Lädt aktive Banner alle zwei Minuten nach, damit neue Hinweise auch auf zwischengespeicherten Seiten erscheinen.', 'lifelink' ) ),
		);
		?>
		<h2><?php esc_html_e( 'Einstellungen', 'lifelink' ); ?></h2>
		<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
			<input type="hidden" name="action" value="lifelink_save_settings">
			<?php wp_nonce_field( 'lifelink_save_settings' ); ?>
			<table class="form-table" role="presentation">
				<tr>
					<th scope="row"><label for="lifelink-author-id"><?php esc_html_e( 'Autor für Beiträge', 'lifelink' ); ?></label></th>
					<td>
						<?php echo $dropdown; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- core-generated, escaped markup. ?>
						<p class="description"><?php esc_html_e( 'Pflicht für Beiträge aus LifeLink. Nur Benutzer mit der Berechtigung „Beiträge bearbeiten“.', 'lifelink' ); ?></p>
					</td>
				</tr>
				<?php foreach ( $checkboxes as $name => $box ) : ?>
					<tr>
						<th scope="row"><?php echo esc_html( $box[1] ); ?></th>
						<td>
							<label for="<?php echo esc_attr( $name ); ?>">
								<input type="checkbox" id="<?php echo esc_attr( $name ); ?>" name="<?php echo esc_attr( $name ); ?>" value="1" <?php checked( $box[0] ); ?>>
								<?php echo esc_html( $box[1] ); ?>
							</label>
							<p class="description"><?php echo esc_html( $box[2] ); ?></p>
						</td>
					</tr>
				<?php endforeach; ?>
			</table>
			<?php submit_button( __( 'Einstellungen speichern', 'lifelink' ) ); ?>
		</form>
		<?php
	}

	/**
	 * Bannerliste mit Vorschau.
	 */
	private function render_banners(): void {
		$rows   = $this->repository->all_recent();
		$states = array(
			'geplant'     => __( 'Geplant', 'lifelink' ),
			'aktiv'       => __( 'Aktiv', 'lifelink' ),
			'abgelaufen'  => __( 'Abgelaufen', 'lifelink' ),
			'deaktiviert' => __( 'Deaktiviert', 'lifelink' ),
		);
		$priorities = array(
			'niedrig' => __( 'Niedrig', 'lifelink' ),
			'normal'  => __( 'Normal', 'lifelink' ),
			'hoch'    => __( 'Hoch', 'lifelink' ),
		);
		$colors = LifeLink_Renderer::color_names();
		?>
		<h2><?php esc_html_e( 'Banner', 'lifelink' ); ?></h2>
		<p class="description"><?php esc_html_e( 'Alle Banner aus LifeLink, inklusive abgelaufener und deaktivierter der letzten 30 Tage. Ältere werden automatisch gelöscht.', 'lifelink' ); ?></p>
		<table class="widefat striped lifelink-table lifelink-banner-table">
			<thead>
				<tr>
					<th scope="col"><?php esc_html_e( 'Vorschau', 'lifelink' ); ?></th>
					<th scope="col"><?php esc_html_e( 'Zeitraum', 'lifelink' ); ?></th>
					<th scope="col"><?php esc_html_e( 'Seiten', 'lifelink' ); ?></th>
					<th scope="col"><?php esc_html_e( 'Farbe / Priorität', 'lifelink' ); ?></th>
					<th scope="col"><?php esc_html_e( 'Zustand', 'lifelink' ); ?></th>
					<th scope="col"><?php esc_html_e( 'Aktion', 'lifelink' ); ?></th>
				</tr>
			</thead>
			<tbody>
				<?php if ( empty( $rows ) ) : ?>
					<tr><td colspan="6"><?php esc_html_e( 'Keine Banner vorhanden.', 'lifelink' ); ?></td></tr>
				<?php endif; ?>
				<?php foreach ( $rows as $row ) : ?>
					<?php
					$state  = LifeLink_Banner_Repository::state( $row );
					$starts = LifeLink_Banner_Repository::ts( $row['starts_at'] );
					$ends   = LifeLink_Banner_Repository::ts( $row['ends_at'] );
					$pages  = array_map( array( $this->targets, 'label' ), LifeLink_Banner_Repository::pages( $row ) );
					?>
					<tr>
						<td class="lifelink-preview-cell">
							<div class="lifelink-banners lifelink-banners--preview">
								<?php echo $this->renderer->render_banner( $row, true ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- escaped in renderer. ?>
							</div>
							<small class="lifelink-meta">
								<?php
								/* translators: 1: revision, 2: date and time */
								echo esc_html( sprintf( __( 'Revision %1$d · geändert %2$s', 'lifelink' ), (int) $row['revision'], $this->format_time( LifeLink_Banner_Repository::ts( $row['updated_at'] ) ) ) );
								?>
							</small>
						</td>
						<td>
							<?php echo esc_html( $this->format_time( $starts ) ); ?><br>
							<?php echo null === $ends ? esc_html__( 'ohne Ende', 'lifelink' ) : esc_html( '– ' . $this->format_time( $ends ) ); ?>
						</td>
						<td><?php echo esc_html( implode( ', ', $pages ) ); ?></td>
						<td>
							<?php echo esc_html( ( $colors[ $row['color'] ] ?? $row['color'] ) . ' / ' . ( $priorities[ $row['priority'] ] ?? $row['priority'] ) ); ?>
						</td>
						<td><span class="lifelink-badge lifelink-badge--<?php echo esc_attr( $state ); ?>"><?php echo esc_html( $states[ $state ] ?? $state ); ?></span></td>
						<td>
							<?php if ( 'deaktiviert' !== $state && 'abgelaufen' !== $state ) : ?>
								<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" class="lifelink-inline-form">
									<input type="hidden" name="action" value="lifelink_deactivate_banner">
									<input type="hidden" name="external_id" value="<?php echo esc_attr( $row['external_id'] ); ?>">
									<?php wp_nonce_field( 'lifelink_deactivate_banner' ); ?>
									<button type="submit" class="button" data-lifelink-confirm="<?php esc_attr_e( 'Dieses Banner sofort deaktivieren?', 'lifelink' ); ?>"><?php esc_html_e( 'Deaktivieren', 'lifelink' ); ?></button>
								</form>
							<?php else : ?>
								—
							<?php endif; ?>
						</td>
					</tr>
				<?php endforeach; ?>
			</tbody>
		</table>
		<?php
	}

	/**
	 * Audit-Verlauf.
	 */
	private function render_audit(): void {
		$entries = $this->audit->entries();
		?>
		<h2><?php esc_html_e( 'Verlauf', 'lifelink' ); ?></h2>
		<p class="description"><?php esc_html_e( 'Die letzten 200 Zugriffe und Änderungen. Geheimnisse und Signaturen werden nie protokolliert.', 'lifelink' ); ?></p>
		<table class="widefat striped lifelink-table">
			<thead>
				<tr>
					<th scope="col"><?php esc_html_e( 'Zeit', 'lifelink' ); ?></th>
					<th scope="col"><?php esc_html_e( 'Schlüssel / Benutzer', 'lifelink' ); ?></th>
					<th scope="col"><?php esc_html_e( 'Aktion', 'lifelink' ); ?></th>
					<th scope="col"><?php esc_html_e( 'Objekt', 'lifelink' ); ?></th>
					<th scope="col"><?php esc_html_e( 'Ergebnis', 'lifelink' ); ?></th>
				</tr>
			</thead>
			<tbody>
				<?php if ( empty( $entries ) ) : ?>
					<tr><td colspan="5"><?php esc_html_e( 'Noch keine Einträge.', 'lifelink' ); ?></td></tr>
				<?php endif; ?>
				<?php foreach ( $entries as $entry ) : ?>
					<tr>
						<td><?php echo esc_html( $this->format_time( (int) ( $entry['time'] ?? 0 ) ) ); ?></td>
						<td><code><?php echo esc_html( (string) ( $entry['actor'] ?? '' ) ); ?></code></td>
						<td><?php echo esc_html( (string) ( $entry['action'] ?? '' ) ); ?></td>
						<td><code><?php echo esc_html( (string) ( $entry['object'] ?? '' ) ); ?></code></td>
						<td><?php echo esc_html( (string) ( $entry['result'] ?? '' ) ); ?></td>
					</tr>
				<?php endforeach; ?>
			</tbody>
		</table>
		<?php
	}
}
