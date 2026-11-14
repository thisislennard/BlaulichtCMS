<?php
/**
 * Prüfung signierter Anfragen (HMAC, Zeitstempel, Nonce, Rate-Limit).
 *
 * @package LifeLink
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * permission_callback für alle signierten Routen.
 */
final class LifeLink_Auth {

	public const TOLERANCE    = 300;
	public const NONCE_TTL    = 600;
	public const RATE_LIMIT   = 120;
	public const NONCE_PREFIX = 'lifelink_n_';
	private const RATE_PREFIX = 'lifelink_rl_';

	/**
	 * Schlüssel-ID der aktuell geprüften Anfrage.
	 *
	 * @var string|null
	 */
	private ?string $current_key_id = null;

	/**
	 * Konstruktor.
	 *
	 * @param LifeLink_Keys      $keys  Schlüsselspeicher.
	 * @param LifeLink_Audit_Log $audit Audit-Log.
	 */
	public function __construct(
		private LifeLink_Keys $keys,
		private LifeLink_Audit_Log $audit
	) {}

	/**
	 * Schlüssel-ID der zuletzt erfolgreich geprüften Anfrage.
	 */
	public function current_key_id(): ?string {
		return $this->current_key_id;
	}

	/**
	 * Prüft eine Anfrage.
	 *
	 * @param WP_REST_Request $request Anfrage.
	 * @return true|WP_Error
	 */
	public function authorize( WP_REST_Request $request ) {
		$this->current_key_id = null;

		$key_id    = trim( (string) $request->get_header( 'X-LifeLink-Key' ) );
		$timestamp = trim( (string) $request->get_header( 'X-LifeLink-Timestamp' ) );
		$nonce     = trim( (string) $request->get_header( 'X-LifeLink-Nonce' ) );
		$signature = trim( (string) $request->get_header( 'X-LifeLink-Signature' ) );

		if ( '' === $key_id || '' === $timestamp || '' === $nonce || '' === $signature ) {
			return $this->fail( 'lifelink_missing_auth', __( 'Authentisierungs-Header fehlen.', 'lifelink' ), 401 );
		}
		if ( 1 !== preg_match( '/^[0-9]{1,12}$/', $timestamp ) || 1 !== preg_match( '/^[A-Za-z0-9_-]{16,64}$/', $nonce ) ) {
			return $this->fail( 'lifelink_missing_auth', __( 'Authentisierungs-Header sind ungültig.', 'lifelink' ), 401 );
		}

		if ( ! $this->keys->has_valid() ) {
			return $this->fail( 'lifelink_unknown_key', __( 'Im Plugin ist kein gültiger Schlüssel eingerichtet.', 'lifelink' ), 401 );
		}

		$key = LifeLink_Keys::is_key_id( $key_id ) ? $this->keys->get( $key_id ) : null;
		if ( null === $key ) {
			return $this->fail( 'lifelink_unknown_key', __( 'Unbekannter Schlüssel.', 'lifelink' ), 401 );
		}
		if ( null !== $key['revoked_at'] || '' === $key['secret'] ) {
			return $this->fail( 'lifelink_revoked', __( 'Der Schlüssel wurde widerrufen.', 'lifelink' ), 403, $key_id, $request );
		}

		if ( abs( time() - (int) $timestamp ) > self::TOLERANCE ) {
			return $this->fail( 'lifelink_expired', __( 'Zeitstempel außerhalb der erlaubten Abweichung (±300 s).', 'lifelink' ), 401, $key_id, $request );
		}

		$valid_format = 1 === preg_match( '/^v1=[0-9a-fA-F]{64}$/', $signature );
		$verified     = $valid_format && LifeLink_Signature::verify(
			$key['secret'],
			$signature,
			$request->get_method(),
			$request->get_route(),
			$timestamp,
			$nonce,
			(string) $request->get_body()
		);
		if ( ! $verified ) {
			return $this->fail( 'lifelink_bad_signature', __( 'Signatur ungültig.', 'lifelink' ), 401, $key_id, $request );
		}

		$retry_after = $this->rate_limit( $key_id );
		if ( $retry_after > 0 ) {
			return $this->fail(
				'lifelink_rate_limited',
				__( 'Zu viele Anfragen. Bitte später erneut versuchen.', 'lifelink' ),
				429,
				$key_id,
				$request,
				true,
				array( 'retry_after' => $retry_after )
			);
		}

		$nonce_result = $this->consume_nonce( $key_id, $nonce );
		if ( 'replay' === $nonce_result ) {
			return $this->fail( 'lifelink_replay', __( 'Nonce wurde bereits verwendet.', 'lifelink' ), 409, $key_id, $request );
		}
		if ( 'error' === $nonce_result ) {
			return LifeLink_Error::internal();
		}

		$this->keys->record_use( $key_id );
		$this->current_key_id = $key_id;
		return true;
	}

	/**
	 * Erzeugt den Fehler, merkt ihn für die Admin-Anzeige und protokolliert Fehlversuche
	 * mit bekanntem Schlüssel (ohne Signatur oder Geheimnis).
	 *
	 * @param string               $code      Fehlercode.
	 * @param string               $message   Meldung.
	 * @param int                  $status    HTTP-Status.
	 * @param string               $key_id    Bekannte Schlüssel-ID (sonst leer).
	 * @param WP_REST_Request|null $request   Anfrage (für das Protokoll).
	 * @param bool                 $retryable Wiederholbar.
	 * @param array                $extra     Zusätzliche Daten.
	 */
	private function fail( string $code, string $message, int $status, string $key_id = '', ?WP_REST_Request $request = null, bool $retryable = false, array $extra = array() ): WP_Error {
		$this->audit->record_error( $code, $key_id );
		if ( '' !== $key_id && null !== $request && 'lifelink_rate_limited' !== $code ) {
			$this->audit->add( $key_id, 'auth', $request->get_method() . ' ' . $request->get_route(), $code );
		}
		return LifeLink_Error::make( $code, $message, $status, $retryable, $extra );
	}

	/**
	 * Zählt Anfragen je Schlüssel und Minute.
	 *
	 * @param string $key_id Schlüssel-ID.
	 * @return int Sekunden bis zum nächsten Fenster, wenn das Limit überschritten ist, sonst 0.
	 */
	private function rate_limit( string $key_id ): int {
		$now    = time();
		$window = intdiv( $now, 60 );
		$name   = self::RATE_PREFIX . $key_id . '_' . $window;

		if ( wp_using_ext_object_cache() ) {
			wp_cache_add( $name, 0, 'lifelink_rate', 2 * MINUTE_IN_SECONDS );
			$count = wp_cache_incr( $name, 1, 'lifelink_rate' );
			if ( false === $count ) {
				$count = 1;
				wp_cache_set( $name, 1, 'lifelink_rate', 2 * MINUTE_IN_SECONDS );
			}
		} else {
			$count = (int) get_transient( $name ) + 1;
			set_transient( $name, $count, 2 * MINUTE_IN_SECONDS );
		}

		if ( (int) $count > self::RATE_LIMIT ) {
			return max( 1, 60 - ( $now % 60 ) );
		}
		return 0;
	}

	/**
	 * Speichert die Nonce für 600 s und erkennt Wiederholungen atomar.
	 *
	 * Mit persistentem Objekt-Cache über wp_cache_add(), sonst als Transient-Zeile,
	 * die per INSERT IGNORE (UNIQUE option_name) atomar angelegt wird.
	 *
	 * @param string $key_id Schlüssel-ID.
	 * @param string $nonce  Nonce.
	 * @return string "ok", "replay" oder "error".
	 */
	private function consume_nonce( string $key_id, string $nonce ): string {
		$hash = hash( 'sha256', $key_id . '|' . $nonce );

		if ( wp_using_ext_object_cache() ) {
			return wp_cache_add( $hash, 1, 'lifelink_nonces', self::NONCE_TTL ) ? 'ok' : 'replay';
		}

		global $wpdb;
		$name = self::NONCE_PREFIX . $hash;
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
		$inserted = $wpdb->query(
			$wpdb->prepare(
				"INSERT IGNORE INTO {$wpdb->options} (option_name, option_value, autoload) VALUES (%s, %s, 'no')",
				'_transient_' . $name,
				'1'
			)
		);
		if ( false === $inserted ) {
			return 'error';
		}
		if ( 1 !== (int) $inserted ) {
			return 'replay';
		}
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
		$wpdb->query(
			$wpdb->prepare(
				"INSERT INTO {$wpdb->options} (option_name, option_value, autoload) VALUES (%s, %s, 'no') ON DUPLICATE KEY UPDATE option_value = VALUES(option_value)",
				'_transient_timeout_' . $name,
				(string) ( time() + self::NONCE_TTL )
			)
		);
		return 'ok';
	}
}
