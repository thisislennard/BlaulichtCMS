<?php
/**
 * Deinstallation: entfernt Tabellen, Optionen, Transients, Sperren und Cron-Ereignisse
 * (bei Multisite für alle Sites).
 *
 * @package LifeLink
 */

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

/**
 * Räumt die aktuelle Site auf.
 */
function lifelink_uninstall_site() {
	global $wpdb;

	// Tabelle.
	$table = $wpdb->prefix . 'lifelink_banners';
	$wpdb->query( "DROP TABLE IF EXISTS `{$table}`" ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery,WordPress.DB.PreparedSQL.InterpolatedNotPrepared

	// Optionen.
	$options = array(
		'lifelink_settings',
		'lifelink_keys',
		'lifelink_key_usage',
		'lifelink_audit',
		'lifelink_last_error',
		'lifelink_db_version',
		'lifelink_active_fingerprint',
	);
	foreach ( $options as $option ) {
		delete_option( $option );
	}

	// Transients (Nonces, Rate-Limits, Einmal-Anzeige) und Sperren.
	$prefixes = array(
		'_transient_lifelink_',
		'_transient_timeout_lifelink_',
		'lifelink_lock_',
	);
	foreach ( $prefixes as $prefix ) {
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
		$wpdb->query( $wpdb->prepare( "DELETE FROM {$wpdb->options} WHERE option_name LIKE %s", $wpdb->esc_like( $prefix ) . '%' ) );
	}

	// Verknüpfungs-Metadaten an Beiträgen (die Beiträge selbst bleiben erhalten).
	delete_post_meta_by_key( '_lifelink_external_id' );
	delete_post_meta_by_key( '_lifelink_revision' );

	// Cron-Ereignisse.
	wp_clear_scheduled_hook( 'lifelink_reconcile' );
	wp_clear_scheduled_hook( 'lifelink_daily_purge' );
	wp_unschedule_hook( 'lifelink_banner_transition' );

	// Objekt-Cache.
	if ( function_exists( 'wp_cache_flush_group' ) && function_exists( 'wp_cache_supports' ) && wp_cache_supports( 'flush_group' ) ) {
		wp_cache_flush_group( 'lifelink' );
	} else {
		wp_cache_delete( 'last_changed', 'lifelink' );
	}
}

if ( is_multisite() ) {
	$lifelink_site_ids = get_sites(
		array(
			'fields' => 'ids',
			'number' => 0,
		)
	);
	foreach ( $lifelink_site_ids as $lifelink_site_id ) {
		switch_to_blog( (int) $lifelink_site_id );
		lifelink_uninstall_site();
		restore_current_blog();
	}
} else {
	lifelink_uninstall_site();
}
