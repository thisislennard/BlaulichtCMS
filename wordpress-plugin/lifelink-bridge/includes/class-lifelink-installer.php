<?php
/**
 * Aktivierung, Datenbank-Migration, Multisite und Deaktivierung.
 *
 * @package LifeLink
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Installer.
 */
final class LifeLink_Installer {

	public const DB_VERSION_OPTION = 'lifelink_db_version';

	/**
	 * Hooks registrieren.
	 */
	public static function register(): void {
		add_action( 'init', array( self::class, 'maybe_upgrade' ), 5 );
		add_action( 'wp_initialize_site', array( self::class, 'initialize_site' ), 200 );
		add_filter( 'wpmu_drop_tables', array( self::class, 'drop_tables_for_site' ), 10, 2 );
	}

	/**
	 * Aktivierung (ggf. netzwerkweit).
	 *
	 * @param bool $network_wide Netzwerkweite Aktivierung.
	 */
	public static function activate( $network_wide = false ): void {
		if ( is_multisite() && $network_wide ) {
			foreach ( self::site_ids() as $site_id ) {
				switch_to_blog( $site_id );
				self::install_site();
				restore_current_blog();
			}
			return;
		}
		self::install_site();
	}

	/**
	 * Deaktivierung: geplante Ereignisse entfernen (Daten bleiben erhalten).
	 *
	 * @param bool $network_wide Netzwerkweite Deaktivierung.
	 */
	public static function deactivate( $network_wide = false ): void {
		if ( is_multisite() && $network_wide ) {
			foreach ( self::site_ids() as $site_id ) {
				switch_to_blog( $site_id );
				LifeLink_Cron::unschedule_all();
				restore_current_blog();
			}
			return;
		}
		LifeLink_Cron::unschedule_all();
	}

	/**
	 * Alle Site-IDs des Netzwerks.
	 *
	 * @return int[]
	 */
	public static function site_ids(): array {
		$ids = get_sites(
			array(
				'fields'                 => 'ids',
				'number'                 => 0,
				'update_site_meta_cache' => false,
			)
		);
		return array_map( 'intval', is_array( $ids ) ? $ids : array() );
	}

	/**
	 * Richtet die aktuelle Site ein (Tabelle, Optionen, Cron).
	 */
	public static function install_site(): void {
		LifeLink_Banner_Repository::create_table();
		update_option( self::DB_VERSION_OPTION, LIFELINK_DB_VERSION, true );

		add_option( LifeLink_Settings::OPTION, LifeLink_Settings::defaults(), '', true );
		add_option( LifeLink_Keys::OPTION, array(), '', false );
		add_option( LifeLink_Keys::USAGE_OPTION, array(), '', false );
		add_option( LifeLink_Audit_Log::OPTION, array(), '', false );

		LifeLink_Cron::ensure_scheduled();
	}

	/**
	 * Führt Migrationen aus, wenn sich die Schemaversion geändert hat (z. B. nach einem Update).
	 */
	public static function maybe_upgrade(): void {
		if ( (int) get_option( self::DB_VERSION_OPTION, 0 ) !== LIFELINK_DB_VERSION ) {
			self::install_site();
		}
	}

	/**
	 * Neue Site im Netzwerk: einrichten, wenn das Plugin netzwerkweit aktiv ist.
	 *
	 * @param WP_Site $site Neue Site.
	 */
	public static function initialize_site( $site ): void {
		if ( ! $site instanceof WP_Site ) {
			return;
		}
		if ( ! function_exists( 'is_plugin_active_for_network' ) ) {
			require_once ABSPATH . 'wp-admin/includes/plugin.php';
		}
		if ( ! is_plugin_active_for_network( plugin_basename( LIFELINK_FILE ) ) ) {
			return;
		}
		switch_to_blog( (int) $site->blog_id );
		self::install_site();
		restore_current_blog();
	}

	/**
	 * Beim Löschen einer Site auch die Banner-Tabelle entfernen.
	 *
	 * @param string[] $tables  Zu löschende Tabellen.
	 * @param int      $site_id Site-ID.
	 * @return string[]
	 */
	public static function drop_tables_for_site( $tables, $site_id = 0 ) {
		global $wpdb;
		if ( ! is_array( $tables ) ) {
			$tables = array();
		}
		$tables[] = $wpdb->get_blog_prefix( (int) $site_id ) . 'lifelink_banners';
		return $tables;
	}
}
