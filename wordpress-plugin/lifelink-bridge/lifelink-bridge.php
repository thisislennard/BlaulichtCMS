<?php
/**
 * Plugin Name:       LifeLink Bridge
 * Description:       Verbindet diese Website mit LifeLink. Die Bridge holt freigegebene Beiträge per HTTPS ab, veröffentlicht sie und meldet WordPress-ID und Adresse zurück.
 * Version:           0.2.0
 * Requires at least: 6.4
 * Requires PHP:      8.1
 * Author:            LifeLink
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       lifelink-bridge
 *
 * @package LifeLinkBridge
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'LIFELINK_BRIDGE_VERSION', '0.2.0' );
define( 'LIFELINK_BRIDGE_FILE', __FILE__ );
define( 'LIFELINK_BRIDGE_DIR', plugin_dir_path( __FILE__ ) );

if ( version_compare( PHP_VERSION, '8.1', '<' ) ) {
	add_action(
		'admin_notices',
		static function () {
			echo '<div class="notice notice-error"><p>' . esc_html__( 'LifeLink Bridge benötigt PHP 8.1 oder neuer. Das Plugin ist inaktiv.', 'lifelink-bridge' ) . '</p></div>';
		}
	);
	return;
}

require_once LIFELINK_BRIDGE_DIR . 'includes/class-settings.php';
require_once LIFELINK_BRIDGE_DIR . 'includes/class-client.php';
require_once LIFELINK_BRIDGE_DIR . 'includes/class-publisher.php';
require_once LIFELINK_BRIDGE_DIR . 'includes/class-sync.php';
require_once LIFELINK_BRIDGE_DIR . 'includes/class-admin.php';

register_activation_hook( __FILE__, array( 'LifeLink_Bridge_Sync', 'activate' ) );
register_deactivation_hook( __FILE__, array( 'LifeLink_Bridge_Sync', 'deactivate' ) );

LifeLink_Bridge_Sync::boot();
LifeLink_Bridge_Admin::boot();

if ( defined( 'WP_CLI' ) && WP_CLI ) {
	/**
	 * Host-Cron: `wp lifelink-bridge poll` holt Aufträge sofort ab (unabhängig von WP-Cron).
	 * `wp lifelink-bridge pair <lifelink-url> <code>` koppelt ohne Oberfläche.
	 * `wp lifelink-bridge status` zeigt den Kopplungsstand.
	 */
	WP_CLI::add_command(
		'lifelink-bridge',
		new class() {
			/** Aufträge abholen und verarbeiten. */
			public function poll() {
				$r = LifeLink_Bridge_Sync::poll( true );
				if ( is_wp_error( $r ) ) {
					WP_CLI::error( $r->get_error_message() );
				}
				WP_CLI::success( sprintf( '%d Auftrag/Aufträge verarbeitet.', (int) $r ) );
			}

			/**
			 * Mit LifeLink koppeln.
			 *
			 * ## OPTIONS
			 * <url>
			 * : Adresse von LifeLink
			 * <code>
			 * : Einmaliger Kopplungscode
			 */
			public function pair( $args ) {
				$r = LifeLink_Bridge_Client::pair( $args[0], $args[1] );
				if ( is_wp_error( $r ) ) {
					WP_CLI::error( $r->get_error_message() );
				}
				WP_CLI::success( 'Gekoppelt mit ' . LifeLink_Bridge_Settings::get( 'site_name' ) );
			}

			/** Kopplungsstand anzeigen. */
			public function status() {
				$s = LifeLink_Bridge_Settings::all();
				WP_CLI::line( 'LifeLink:      ' . ( $s['url'] ? $s['url'] : '–' ) );
				WP_CLI::line( 'Gekoppelt:     ' . ( $s['key'] ? 'ja (' . $s['site_name'] . ')' : 'nein' ) );
				WP_CLI::line( 'Letzter Abruf: ' . ( $s['last_poll'] ? gmdate( 'c', (int) $s['last_poll'] ) : '–' ) );
				WP_CLI::line( 'Letzter Fehler: ' . ( $s['last_error'] ? $s['last_error'] : '–' ) );
			}
		}
	);
}
