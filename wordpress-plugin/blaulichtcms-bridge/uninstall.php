<?php
/**
 * Deinstallation: widerruft den Schlüssel in BlaulichtCMS (best effort) und entfernt Einstellungen, Sperre, Hinweise,
 * Update-Zwischenspeicher und geplante Abrufe – auf Multisite für jede Website (#90).
 * Veröffentlichte Beiträge und Medien bleiben erhalten.
 *
 * Hinweis: Beim Deinstallieren ist das Plugin selbst nicht geladen, deshalb hier ohne die Plugin-Klassen.
 *
 * @package BlaulichtCMSBridge
 */

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

/** Aufräumen für die aktuelle Website. */
function blaulichtcms_bridge_uninstall_site(): void {
	global $wpdb;
	$s = get_option( 'blaulichtcms_bridge_settings' );
	if ( is_array( $s ) && ! empty( $s['url'] ) && ! empty( $s['key'] ) ) {
		// Schlüssel in BlaulichtCMS sofort ungültig machen; Fehler (BlaulichtCMS nicht erreichbar) blockieren die Deinstallation nicht.
		wp_remote_post(
			untrailingslashit( (string) $s['url'] ) . '/api/v1/bridge/unpair',
			array(
				'timeout'  => 5,
				'blocking' => true,
				'headers'  => array(
					'Authorization' => 'Bearer ' . (string) $s['key'],
					'Content-Type'  => 'application/json',
				),
				'body'     => '{}',
			)
		);
	}
	delete_option( 'blaulichtcms_bridge_settings' );
	delete_option( 'blaulichtcms_bridge_status' );
	delete_option( 'blaulichtcms_bridge_banners' );
	delete_option( 'blaulichtcms_bridge_social' ); // Social-Feed (ab 0.10.0) samt abgelegter Bilder
	$u = wp_upload_dir( null, false );
	foreach ( (array) glob( trailingslashit( $u['basedir'] ) . 'blaulichtcms-social/*.webp' ) as $f ) {
		wp_delete_file( (string) $f );
	}
	if ( is_dir( trailingslashit( $u['basedir'] ) . 'blaulichtcms-social' ) ) {
		@rmdir( trailingslashit( $u['basedir'] ) . 'blaulichtcms-social' ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged,WordPress.WP.AlternativeFunctions.file_system_operations_rmdir
	}
	delete_option( 'blaulichtcms_bridge_incidents' ); // Einsatzliste: Einstellungen (Einträge bleiben wie Beiträge erhalten)
	delete_option( 'blaulichtcms_bridge_incidents_rev' );
	delete_option( 'blaulichtcms_bridge_incidents_rewrite' );
	delete_option( 'blaulichtcms_bridge_lock' );
	delete_transient( 'blaulichtcms_bridge_lock' );
	delete_transient( 'blaulichtcms_bridge_update' ); // Update-Angebot je Website (ab 0.6.0)
	wp_clear_scheduled_hook( 'blaulichtcms_bridge_poll' );
	wp_clear_scheduled_hook( 'blaulichtcms_bridge_banner_edge' );
	// Hinweise je Benutzer (blaulichtcms_bridge_notice_<id>)
	$wpdb->query(
		$wpdb->prepare(
			"DELETE FROM {$wpdb->options} WHERE option_name LIKE %s OR option_name LIKE %s",
			$wpdb->esc_like( '_transient_blaulichtcms_bridge_notice_' ) . '%',
			$wpdb->esc_like( '_transient_timeout_blaulichtcms_bridge_notice_' ) . '%'
		)
	);
	$wpdb->query(
		$wpdb->prepare(
			"DELETE FROM {$wpdb->options} WHERE option_name LIKE %s OR option_name LIKE %s",
			$wpdb->esc_like( '_transient_blaulichtcms_bcl_stats_' ) . '%',
			$wpdb->esc_like( '_transient_timeout_blaulichtcms_bcl_stats_' ) . '%'
		)
	);
}

if ( is_multisite() ) {
	foreach ( get_sites( array( 'fields' => 'ids', 'number' => 0 ) ) as $blog_id ) {
		switch_to_blog( (int) $blog_id );
		blaulichtcms_bridge_uninstall_site();
		restore_current_blog();
	}
} else {
	blaulichtcms_bridge_uninstall_site();
}
delete_site_transient( 'blaulichtcms_bridge_update' ); // Altbestand bis 0.5.x
