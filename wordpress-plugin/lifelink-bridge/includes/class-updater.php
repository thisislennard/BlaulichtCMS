<?php
/**
 * Updates der Bridge über den normalen WordPress-Updateweg.
 *
 * - LifeLink bietet nur freigegebene Versionen an (Testwebsites erhalten neue Versionen zuerst).
 * - Das Paket wird vor der Installation gegen die von LifeLink gemeldete SHA-256-Prüfsumme geprüft.
 * - Die Kopplung (Optionen in der Datenbank) bleibt beim Update unverändert erhalten.
 *
 * @package LifeLinkBridge
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class LifeLink_Bridge_Updater {
	const SLUG      = 'lifelink-bridge';
	const TRANSIENT = 'lifelink_bridge_update';

	public static function boot(): void {
		add_filter( 'pre_set_site_transient_update_plugins', array( __CLASS__, 'inject' ) );
		add_filter( 'plugins_api', array( __CLASS__, 'info' ), 10, 3 );
		add_filter( 'upgrader_pre_download', array( __CLASS__, 'verified_download' ), 10, 4 );
		add_action( 'upgrader_process_complete', array( __CLASS__, 'clear' ), 10, 0 );
	}

	private static function plugin_file(): string {
		return plugin_basename( LIFELINK_BRIDGE_FILE );
	}

	/** Angebot von LifeLink (6 Stunden zwischengespeichert, bei Fehler kurz). */
	public static function offer( bool $force = false ): ?array {
		if ( ! LifeLink_Bridge_Settings::is_paired() ) {
			return null;
		}
		$cached = get_site_transient( self::TRANSIENT );
		if ( ! $force && is_array( $cached ) ) {
			return $cached['available'] ? $cached : null;
		}
		$r = LifeLink_Bridge_Client::update_info();
		if ( is_wp_error( $r ) ) {
			set_site_transient( self::TRANSIENT, array( 'available' => false ), 15 * MINUTE_IN_SECONDS );
			return null;
		}
		$offer = array(
			'available'    => ! empty( $r['available'] ),
			'version'      => (string) ( $r['version'] ?? '' ),
			'sha256'       => strtolower( (string) ( $r['sha256'] ?? '' ) ),
			'package'      => ! empty( $r['package_path'] ) && 0 === strpos( (string) $r['package_path'], '/api/v1/bridge/update/package?' )
				? LifeLink_Bridge_Client::base_url() . (string) $r['package_path']
				: (string) ( $r['package'] ?? '' ),
			'requires'     => (string) ( $r['requires'] ?? '' ),
			'requires_php' => (string) ( $r['requires_php'] ?? '' ),
			'tested'       => (string) ( $r['tested'] ?? '' ),
		);
		// Paket nur von der gekoppelten Instanz annehmen
		if ( $offer['available'] && 0 !== strpos( $offer['package'], LifeLink_Bridge_Client::base_url() . '/api/v1/bridge/update/package' ) ) {
			$offer['available'] = false;
		}
		set_site_transient( self::TRANSIENT, $offer, 6 * HOUR_IN_SECONDS );
		return $offer['available'] ? $offer : null;
	}

	public static function inject( $transient ) {
		if ( ! is_object( $transient ) ) {
			return $transient;
		}
		$offer = self::offer();
		if ( $offer && version_compare( $offer['version'], LIFELINK_BRIDGE_VERSION, '>' ) ) {
			$transient->response[ self::plugin_file() ] = (object) array(
				'slug'         => self::SLUG,
				'plugin'       => self::plugin_file(),
				'new_version'  => $offer['version'],
				'package'      => $offer['package'],
				'url'          => LifeLink_Bridge_Client::base_url(),
				'requires'     => $offer['requires'],
				'requires_php' => $offer['requires_php'],
				'tested'       => $offer['tested'],
			);
		} elseif ( isset( $transient->response[ self::plugin_file() ] ) ) {
			unset( $transient->response[ self::plugin_file() ] );
		}
		return $transient;
	}

	public static function info( $result, $action, $args ) {
		if ( 'plugin_information' !== $action || empty( $args->slug ) || self::SLUG !== $args->slug ) {
			return $result;
		}
		$offer = self::offer();
		return (object) array(
			'name'          => 'LifeLink Bridge',
			'slug'          => self::SLUG,
			'version'       => $offer['version'] ?? LIFELINK_BRIDGE_VERSION,
			'requires'      => $offer['requires'] ?? '',
			'requires_php'  => $offer['requires_php'] ?? '',
			'tested'        => $offer['tested'] ?? '',
			'download_link' => $offer['package'] ?? '',
			'sections'      => array( 'description' => 'Verbindet diese Website mit LifeLink. Updates werden von der gekoppelten LifeLink-Instanz freigegeben und vor der Installation per Prüfsumme geprüft.' ),
		);
	}

	/**
	 * Eigenes Herunterladen mit Prüfsummenkontrolle. Stimmt die Prüfsumme nicht, bricht WordPress das Update ab.
	 *
	 * @return false|string|WP_Error
	 */
	public static function verified_download( $reply, $package, $upgrader, $hook_extra = array() ) {
		$base = LifeLink_Bridge_Client::base_url();
		if ( ! is_string( $package ) || '' === $base || 0 !== strpos( $package, $base . '/api/v1/bridge/update/package' ) ) {
			return $reply;
		}
		$offer = get_site_transient( self::TRANSIENT );
		if ( ! is_array( $offer ) || empty( $offer['sha256'] ) ) {
			return new WP_Error( 'lifelink_update', 'Kein gültiges Update-Angebot von LifeLink.' );
		}
		// Gleicher Weg wie die übrigen Abrufe der Bridge (download_url() lässt nur Standardports und öffentliche Hosts zu)
		$tmp = wp_tempnam( 'lifelink-bridge.zip' );
		$res = wp_remote_get(
			$package,
			array(
				'timeout'  => 120,
				'stream'   => true,
				'filename' => $tmp,
			)
		);
		if ( is_wp_error( $res ) || 200 !== (int) wp_remote_retrieve_response_code( $res ) ) {
			wp_delete_file( $tmp );
			return new WP_Error( 'lifelink_update_download', 'Update-Paket konnte nicht von LifeLink geladen werden: ' . ( is_wp_error( $res ) ? $res->get_error_message() : 'HTTP ' . wp_remote_retrieve_response_code( $res ) ) );
		}
		if ( ! hash_equals( $offer['sha256'], (string) hash_file( 'sha256', $tmp ) ) ) {
			wp_delete_file( $tmp );
			return new WP_Error( 'lifelink_update_checksum', 'Das Update-Paket stimmt nicht mit der Prüfsumme von LifeLink überein und wurde verworfen.' );
		}
		return $tmp;
	}

	public static function clear(): void {
		delete_site_transient( self::TRANSIENT );
	}
}
