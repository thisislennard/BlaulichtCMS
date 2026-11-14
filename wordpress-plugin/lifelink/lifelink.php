<?php
/**
 * Plugin Name:       LifeLink
 * Description:       Zeigt zeitgesteuerte Hinweis-Banner aus LifeLink an und legt Beitragsentwürfe an – über eine signierte, versionierte REST-Schnittstelle.
 * Version:           1.0.0
 * Requires at least: 6.4
 * Requires PHP:      8.1
 * Author:            LifeLink
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       lifelink
 *
 * @package LifeLink
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'LIFELINK_VERSION', '1.0.0' );
define( 'LIFELINK_API_VERSION', 1 );
define( 'LIFELINK_DB_VERSION', 1 );
define( 'LIFELINK_FILE', __FILE__ );
define( 'LIFELINK_DIR', plugin_dir_path( __FILE__ ) );
define( 'LIFELINK_URL', plugin_dir_url( __FILE__ ) );

if ( version_compare( PHP_VERSION, '8.1', '<' ) ) {
	add_action(
		'admin_notices',
		static function () {
			echo '<div class="notice notice-error"><p>' . esc_html__( 'LifeLink benötigt PHP 8.1 oder neuer. Das Plugin ist inaktiv.', 'lifelink' ) . '</p></div>';
		}
	);
	return;
}

require_once LIFELINK_DIR . 'includes/class-lifelink-signature.php';
require_once LIFELINK_DIR . 'includes/class-lifelink-error.php';
require_once LIFELINK_DIR . 'includes/class-lifelink-settings.php';
require_once LIFELINK_DIR . 'includes/class-lifelink-keys.php';
require_once LIFELINK_DIR . 'includes/class-lifelink-audit-log.php';
require_once LIFELINK_DIR . 'includes/class-lifelink-targets.php';
require_once LIFELINK_DIR . 'includes/class-lifelink-validator.php';
require_once LIFELINK_DIR . 'includes/class-lifelink-banner-repository.php';
require_once LIFELINK_DIR . 'includes/class-lifelink-cache-purger.php';
require_once LIFELINK_DIR . 'includes/class-lifelink-cron.php';
require_once LIFELINK_DIR . 'includes/class-lifelink-auth.php';
require_once LIFELINK_DIR . 'includes/class-lifelink-post-handler.php';
require_once LIFELINK_DIR . 'includes/class-lifelink-rest-controller.php';
require_once LIFELINK_DIR . 'includes/class-lifelink-renderer.php';
require_once LIFELINK_DIR . 'includes/class-lifelink-widget.php';
require_once LIFELINK_DIR . 'includes/class-lifelink-admin.php';
require_once LIFELINK_DIR . 'includes/class-lifelink-installer.php';
require_once LIFELINK_DIR . 'includes/class-lifelink-plugin.php';

register_activation_hook( __FILE__, array( 'LifeLink_Installer', 'activate' ) );
register_deactivation_hook( __FILE__, array( 'LifeLink_Installer', 'deactivate' ) );

LifeLink_Plugin::instance()->boot();
