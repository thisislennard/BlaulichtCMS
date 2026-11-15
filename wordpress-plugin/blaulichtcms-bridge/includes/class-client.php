<?php
/**
 * HTTPS-Client zu BlaulichtCMS. Die Bridge ruft nur aus – WordPress braucht keinen offenen Eingang.
 *
 * Schnittstelle (API-Version 1):
 *   POST /api/v1/bridge/pair                Kopplung per Einmalcode → Schlüssel
 *   GET  /api/v1/bridge/jobs                offene Aufträge
 *   POST /api/v1/bridge/jobs/{id}/result    Ergebnis melden
 *   GET  /api/v1/bridge/media/{id}          öffentliche Medienfassung
 *
 * @package BlaulichtCMSBridge
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class BlaulichtCMS_Bridge_Client {
	/** Höchstdauer eines einzelnen Medien-Downloads (Sekunden). Die Abrufsperre gilt erst deutlich später als verwaist. */
	const MEDIA_TIMEOUT = 300;

	private static function headers( bool $json = true ): array {
		$h = array(
			'Authorization'              => 'Bearer ' . BlaulichtCMS_Bridge_Settings::get( 'key' ),
			'X-BlaulichtCMS-Bridge-Version'  => BLAULICHTCMS_BRIDGE_VERSION,
			'Accept'                     => 'application/json',
		);
		if ( $json ) {
			$h['Content-Type'] = 'application/json';
		}
		return $h;
	}

	private static function base(): string {
		return untrailingslashit( (string) BlaulichtCMS_Bridge_Settings::get( 'url' ) );
	}

	/**
	 * Nur https://, http:// ausschließlich im Testbetrieb. Gilt bei der Kopplung und bei jedem Abruf – eine im Testbetrieb
	 * per http:// gekoppelte Website sendet ihren Schlüssel nicht mehr unverschlüsselt, sobald der Testschalter fehlt.
	 *
	 * @return WP_Error|null
	 */
	private static function check_url( string $url ) {
		$scheme = wp_parse_url( $url, PHP_URL_SCHEME );
		if ( ! in_array( $scheme, array( 'https', 'http' ), true ) ) {
			return new WP_Error( 'blaulichtcms_url', 'Die BlaulichtCMS-Adresse muss mit https:// beginnen.' );
		}
		if ( 'http' === $scheme && ! apply_filters( 'blaulichtcms_bridge_allow_http', defined( 'BLAULICHTCMS_BRIDGE_ALLOW_HTTP' ) && BLAULICHTCMS_BRIDGE_ALLOW_HTTP, $url ) ) {
			return new WP_Error( 'blaulichtcms_url', 'Unverschlüsselte Adressen (http://) sind nur im Testbetrieb erlaubt (BLAULICHTCMS_BRIDGE_ALLOW_HTTP).' );
		}
		return null;
	}

	/** Prüfung der gespeicherten Adresse vor jedem Aufruf mit Schlüssel. */
	private static function guard() {
		return self::check_url( self::base() );
	}

	/**
	 * Antwort auswerten: JSON bei Erfolg, sonst WP_Error mit Meldung aus BlaulichtCMS.
	 *
	 * @param array|WP_Error $res Antwort.
	 * @return array|WP_Error
	 */
	private static function decode( $res ) {
		if ( is_wp_error( $res ) ) {
			return new WP_Error( 'blaulichtcms_network', 'BlaulichtCMS nicht erreichbar: ' . $res->get_error_message() );
		}
		$code = (int) wp_remote_retrieve_response_code( $res );
		$body = json_decode( (string) wp_remote_retrieve_body( $res ), true );
		if ( $code >= 200 && $code < 300 ) {
			return is_array( $body ) ? $body : array();
		}
		$msg = is_array( $body ) && ! empty( $body['message'] ) ? (string) $body['message'] : 'HTTP ' . $code;
		return new WP_Error(
			'blaulichtcms_http_' . $code,
			$msg,
			array(
				'status' => $code,
				'code'   => is_array( $body ) && isset( $body['error'] ) ? (string) $body['error'] : '',
			)
		);
	}

	/**
	 * Hat BlaulichtCMS den Schlüssel dieser Website abgelehnt (widerrufen oder unbekannt)? Nur die eindeutigen Antworten von
	 * BlaulichtCMS zählen – ein 401/403 eines vorgeschalteten Proxys oder einer Firewall nicht.
	 *
	 * @param mixed $err Ergebnis eines Aufrufs.
	 */
	public static function is_key_rejected( $err ): bool {
		if ( ! is_wp_error( $err ) ) {
			return false;
		}
		$data = $err->get_error_data();
		$code = is_array( $data ) ? (string) ( $data['code'] ?? '' ) : '';
		return in_array( $code, array( 'bridge_unauthorized', 'bridge_revoked' ), true );
	}

	/** Kopplung mit einmaligem Code. */
	public static function pair( string $url, string $code ) {
		$url = untrailingslashit( esc_url_raw( trim( $url ) ) );
		$bad = self::check_url( $url );
		if ( $bad ) {
			return $bad;
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
						'plugin_version' => BLAULICHTCMS_BRIDGE_VERSION,
					)
				),
			)
		);
		$data = self::decode( $res );
		if ( is_wp_error( $data ) ) {
			return $data;
		}
		if ( empty( $data['key'] ) ) {
			return new WP_Error( 'blaulichtcms_pair', 'BlaulichtCMS hat keinen Schlüssel geliefert.' );
		}
		BlaulichtCMS_Bridge_Settings::update(
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

	/** Update-Angebot (WordPress-Update-Hook). */
	public static function update_info() {
		$bad = self::guard();
		if ( $bad ) {
			return $bad;
		}
		return self::decode(
			wp_remote_get(
				self::base() . '/api/v1/bridge/update',
				array(
					'timeout' => 15,
					'headers' => self::headers( false ),
				)
			)
		);
	}

	/** Basisadresse der gekoppelten BlaulichtCMS-Instanz (für Paketprüfungen). */
	public static function base_url(): string {
		return self::base();
	}

	public static function jobs() {
		$bad = self::guard();
		if ( $bad ) {
			return $bad;
		}
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

	/** Schlüssel in BlaulichtCMS widerrufen (beim Entkoppeln, #90). Fehler sind nicht kritisch. */
	public static function unpair() {
		$bad = self::guard();
		if ( $bad ) {
			return $bad;
		}
		return self::decode(
			wp_remote_post(
				self::base() . '/api/v1/bridge/unpair',
				array(
					'timeout' => 10,
					'headers' => self::headers(),
					'body'    => '{}',
				)
			)
		);
	}

	public static function result( string $job_id, array $result ) {
		$bad = self::guard();
		if ( $bad ) {
			return $bad;
		}
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
		// Nur Dateien der gekoppelten BlaulichtCMS-Instanz laden – immer über die eigene BlaulichtCMS-Adresse.
		if ( ! preg_match( '#^/api/v1/bridge/media/[0-9a-f-]{36}$#', $path ) ) {
			return new WP_Error( 'blaulichtcms_media_url', 'Unerwartete Medienadresse.' );
		}
		$bad = self::guard();
		if ( $bad ) {
			return $bad;
		}
		$url = self::base() . $path;
		$tmp = wp_tempnam( 'blaulichtcms-media' );
		$res = wp_remote_get(
			$url,
			array(
				'timeout'  => self::MEDIA_TIMEOUT,
				'stream'   => true,
				'filename' => $tmp,
				'headers'  => self::headers( false ),
			)
		);
		if ( is_wp_error( $res ) || 200 !== (int) wp_remote_retrieve_response_code( $res ) ) {
			wp_delete_file( $tmp );
			return new WP_Error( 'blaulichtcms_media', 'Mediendatei konnte nicht geladen werden.' );
		}
		return $tmp;
	}
}
