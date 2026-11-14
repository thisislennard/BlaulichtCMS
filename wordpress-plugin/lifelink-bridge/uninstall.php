<?php
/**
 * Deinstallation: entfernt Einstellungen, Sperre und geplante Abrufe.
 * Veröffentlichte Beiträge und Medien bleiben erhalten.
 *
 * @package LifeLinkBridge
 */

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

delete_option( 'lifelink_bridge_settings' );
delete_transient( 'lifelink_bridge_lock' );
wp_clear_scheduled_hook( 'lifelink_bridge_poll' );
delete_option( 'lifelink_bridge_banners' );
wp_clear_scheduled_hook( 'lifelink_bridge_banner_edge' );
