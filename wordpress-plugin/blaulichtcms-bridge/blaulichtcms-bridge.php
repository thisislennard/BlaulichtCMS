<?php
/**
 * Plugin Name:       BlaulichtCMS Bridge
 * Description:       Verbindet diese Website mit BlaulichtCMS: holt freigegebene Beiträge und Hinweis-Banner per HTTPS ab, veröffentlicht sie und meldet WordPress-ID und Adresse zurück. Shortcodes [blaulichtcms_banner], [blaulichtcms_einsaetze], [blaulichtcms_einsatzliste], [blaulichtcms_einsatzstatistik] und [blaulichtcms_social].
 * Version:           0.10.0
 * Requires at least: 6.4
 * Requires PHP:      8.1
 * Plugin URI:        https://github.com/thisislennard/BlaulichtCMS
 * Author:            BlaulichtCMS
 * Author URI:        https://github.com/thisislennard/BlaulichtCMS
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       blaulichtcms-bridge
 * Update URI:        https://blaulichtcms.invalid/bridge
 *
 * @package BlaulichtCMSBridge
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'BLAULICHTCMS_BRIDGE_VERSION', '0.10.0' );
define( 'BLAULICHTCMS_BRIDGE_FILE', __FILE__ );
define( 'BLAULICHTCMS_BRIDGE_DIR', plugin_dir_path( __FILE__ ) );

if ( version_compare( PHP_VERSION, '8.1', '<' ) ) {
	add_action(
		'admin_notices',
		static function () {
			echo '<div class="notice notice-error"><p>' . esc_html__( 'BlaulichtCMS Bridge benötigt PHP 8.1 oder neuer. Das Plugin ist inaktiv.', 'blaulichtcms-bridge' ) . '</p></div>';
		}
	);
	return;
}

require_once BLAULICHTCMS_BRIDGE_DIR . 'includes/class-settings.php';
require_once BLAULICHTCMS_BRIDGE_DIR . 'includes/class-client.php';
require_once BLAULICHTCMS_BRIDGE_DIR . 'includes/class-authors.php';
require_once BLAULICHTCMS_BRIDGE_DIR . 'includes/class-publisher.php';
require_once BLAULICHTCMS_BRIDGE_DIR . 'includes/class-banners.php';
require_once BLAULICHTCMS_BRIDGE_DIR . 'includes/class-incidents.php';
require_once BLAULICHTCMS_BRIDGE_DIR . 'includes/class-incidents-admin.php';
require_once BLAULICHTCMS_BRIDGE_DIR . 'includes/class-social.php';
require_once BLAULICHTCMS_BRIDGE_DIR . 'includes/class-shortcodes-help.php';
require_once BLAULICHTCMS_BRIDGE_DIR . 'includes/class-sync.php';
require_once BLAULICHTCMS_BRIDGE_DIR . 'includes/class-admin.php';
require_once BLAULICHTCMS_BRIDGE_DIR . 'includes/class-readme.php';
require_once BLAULICHTCMS_BRIDGE_DIR . 'includes/class-updater.php';
require_once BLAULICHTCMS_BRIDGE_DIR . 'includes/class-signature.php';

register_activation_hook( __FILE__, array( 'BlaulichtCMS_Bridge_Sync', 'activate' ) );
register_deactivation_hook( __FILE__, array( 'BlaulichtCMS_Bridge_Sync', 'deactivate' ) );

BlaulichtCMS_Bridge_Sync::boot();
BlaulichtCMS_Bridge_Admin::boot();
BlaulichtCMS_Bridge_Banners::boot();
BlaulichtCMS_Bridge_Incidents::boot();
BlaulichtCMS_Bridge_Incidents_Admin::boot();
BlaulichtCMS_Bridge_Social::boot();
BlaulichtCMS_Bridge_Authors::boot();
BlaulichtCMS_Bridge_Updater::boot();
BlaulichtCMS_Bridge_Signature::boot();

if ( defined( 'WP_CLI' ) && WP_CLI ) {
	/**
	 * Host-Cron (optional): `wp blaulichtcms-bridge poll` holt Aufträge sofort ab (unabhängig von WP-Cron).
	 * `wp blaulichtcms-bridge pair <blaulichtcms-url> <code>` koppelt ohne Oberfläche.
	 * `wp blaulichtcms-bridge status` zeigt den Kopplungsstand.
	 */
	WP_CLI::add_command(
		'blaulichtcms-bridge',
		new class() {
			/** Aufträge abholen und verarbeiten. */
			public function poll() {
				$r = BlaulichtCMS_Bridge_Sync::poll( true, 'cli' );
				if ( is_wp_error( $r ) ) {
					WP_CLI::error( $r->get_error_message() );
				}
				WP_CLI::success( sprintf( '%d Auftrag/Aufträge verarbeitet.', (int) $r ) );
			}

			/**
			 * Mit BlaulichtCMS koppeln.
			 *
			 * ## OPTIONS
			 * <url>
			 * : Adresse von BlaulichtCMS
			 * <code>
			 * : Einmaliger Kopplungscode
			 */
			public function pair( $args ) {
				$r = BlaulichtCMS_Bridge_Client::pair( $args[0], $args[1] );
				if ( is_wp_error( $r ) ) {
					WP_CLI::error( $r->get_error_message() );
				}
				WP_CLI::success( 'Gekoppelt mit ' . BlaulichtCMS_Bridge_Settings::get( 'site_name' ) );
			}

			/** Kopplungsstand anzeigen. */
			public function status() {
				$s = BlaulichtCMS_Bridge_Settings::all();
				WP_CLI::line( 'BlaulichtCMS:      ' . ( $s['url'] ? $s['url'] : '–' ) );
				WP_CLI::line( 'Gekoppelt:     ' . ( $s['key'] ? 'ja (' . $s['site_name'] . ')' : 'nein' ) );
				WP_CLI::line( 'Letzter Abruf: ' . ( $s['last_poll'] ? gmdate( 'c', (int) $s['last_poll'] ) : '–' ) );
				WP_CLI::line( 'Letzter Fehler: ' . ( $s['last_error'] ? $s['last_error'] : '–' ) );
				WP_CLI::line( 'Abrufweg:      ' . BlaulichtCMS_Bridge_Sync::mode() . ( BlaulichtCMS_Bridge_Sync::wp_cron_disabled() ? ' (WP-Cron abgeschaltet)' : '' ) );
				WP_CLI::line( 'Auto-Updates:  ' . ( BlaulichtCMS_Bridge_Updater::auto_update_enabled() ? 'an' : 'aus' ) );
			}
		}
	);
}
