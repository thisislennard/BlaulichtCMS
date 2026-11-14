<?php
/**
 * HTTPS-Client zu LifeLink. Die Bridge ruft nur aus – WordPress braucht keinen offenen Eingang.
 *
 * Schnittstelle (API-Version 1):
 *   POST /api/v1/bridge/pair                Kopplung per Einmalcode → Schlüssel
 *   GET  /api/v1/bridge/jobs                offene Aufträge
 *   POST /api/v1/bridge/jobs/{id}/result    Ergebnis melden
 *   GET  /api/v1/bridge/media/{id}          öffentliche Medienfassung
 *
 * @package LifeLinkBridge
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class LifeLink_Bridge_Client {

	private static function headers( bool $json = true ): array {
		$h = array(
			'Authorization'              => 'Bearer ' . LifeLink_Bridge_Settings::get( 'key' ),
			'X-LifeLink-Bridge-Version'  => LIFELINK_BRIDGE_VERSION,
			'Accept'                     => 'application/json',
		);
		if ( $json ) {
			$h['Content-Type'] = 'application/json';
		}
		return $h;
	}

	private static function base(): string {
		return untrailingslashit( (string) LifeLink_Bridge_Settings::get( 'url' ) );
	}

	/**
	 * Antwort auswerten: JSON bei Erfolg, sonst WP_Error mit Meldung aus LifeLink.
	 *
	 * @param array|WP_Error $res Antwort.
	 * @return array|WP_Error
	 */
	private static function decode( $res ) {
		if ( is_wp_error( $res ) ) {
			return new WP_Error( 'lifelink_network', 'LifeLink nicht erreichbar: ' . $res->get_error_message() );
		}
		$code = (int) wp_remote_retrieve_response_code( $res );
		$body = json_decode( (string) wp_remote_retrieve_body( $res ), true );
		if ( $code >= 200 && $code < 300 ) {
			return is_array( $body ) ? $body : array();
		}
		$msg = is_array( $body ) && ! empty( $body['message'] ) ? (string) $body['message'] : 'HTTP ' . $code;
		return new WP_Error( 'lifelink_http_' . $code, $msg, array( 'status' => $code ) );
	}

	/** Kopplung mit einmaligem Code. */
	public static function pair( string $url, string $code ) {
		$url = untrailingslashit( esc_url_raw( trim( $url ) ) );
		$scheme = wp_parse_url( $url, PHP_URL_SCHEME );
		if ( ! in_array( $scheme, array( 'https', 'http' ), true ) ) {
			return new WP_Error( 'lifelink_url', 'Die LifeLink-Adresse muss mit https:// beginnen.' );
		}
		if ( 'http' === $scheme && ! apply_filters( 'lifelink_bridge_allow_http', defined( 'LIFELINK_BRIDGE_ALLOW_HTTP' ) && LIFELINK_BRIDGE_ALLOW_HTTP, $url ) ) {
			return new WP_Error( 'lifelink_url', 'Unverschlüsselte Adressen (http://) sind nur im Testbetrieb erlaubt (LIFELINK_BRIDGE_ALLOW_HTTP).' );
		}
		$res = wp_remote_post(
			$url . '/api/v1/bridge/pair',
			array(
				'timeout' => 20,
				'headers' => array(
					'Content-Type' => 'application/json',
					'Accept'       => 'application/json',
				),
				'body'    => wp_json_encode(
					array(
						'code'           => $code,
						'site_url'       => home_url( '/' ),
						'site_name'      => get_bloginfo( 'name' ),
						'wp_version'     => get_bloginfo( 'version' ),
						'plugin_version' => LIFELINK_BRIDGE_VERSION,
					)
				),
			)
		);
		$data = self::decode( $res );
		if ( is_wp_error( $data ) ) {
			return $data;
		}
		if ( empty( $data['key'] ) ) {
			return new WP_Error( 'lifelink_pair', 'LifeLink hat keinen Schlüssel geliefert.' );
		}
		LifeLink_Bridge_Settings::update(
			array(
				'url'           => $url,
				'key'           => (string) $data['key'],
				'site_id'       => (string) ( $data['site_id'] ?? '' ),
				'site_name'     => (string) ( $data['site_name'] ?? '' ),
				'poll_interval' => max( 30, (int) ( $data['poll_interval'] ?? 60 ) ),
				'last_error'    => '',
			)
		);
		return true;
	}

	public static function jobs() {
		return self::decode(
			wp_remote_get(
				self::base() . '/api/v1/bridge/jobs',
				array(
					'timeout' => 20,
					'headers' => self::headers( false ),
				)
			)
		);
	}

	public static function result( string $job_id, array $result ) {
		return self::decode(
			wp_remote_post(
				self::base() . '/api/v1/bridge/jobs/' . rawurlencode( $job_id ) . '/result',
				array(
					'timeout' => 20,
					'headers' => self::headers(),
					'body'    => wp_json_encode( $result ),
				)
			)
		);
	}

	/**
	 * Medienfassung in eine temporäre Datei laden.
	 *
	 * @return string|WP_Error Pfad zur Datei.
	 */
	public static function download_media( string $path ) {
		// Nur Dateien der gekoppelten LifeLink-Instanz laden – immer über die eigene LifeLink-Adresse.
		if ( ! preg_match( '#^/api/v1/bridge/media/[0-9a-f-]{36}$#', $path ) ) {
			return new WP_Error( 'lifelink_media_url', 'Unerwartete Medienadresse.' );
		}
		$url = self::base() . $path;
		$tmp = wp_tempnam( 'lifelink-media' );
		$res = wp_remote_get(
			$url,
			array(
				'timeout'  => 300,
				'stream'   => true,
				'filename' => $tmp,
				'headers'  => self::headers( false ),
			)
		);
		if ( is_wp_error( $res ) || 200 !== (int) wp_remote_retrieve_response_code( $res ) ) {
			wp_delete_file( $tmp );
			return new WP_Error( 'lifelink_media', 'Mediendatei konnte nicht geladen werden.' );
		}
		return $tmp;
	}
}
