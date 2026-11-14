<?php
/**
 * Verwaltung der API-Schlüssel.
 *
 * Geheimnisse liegen ausschließlich in der nicht automatisch geladenen Option
 * "lifelink_keys". Sie werden nirgends ausgegeben außer einmalig direkt nach der
 * Erzeugung im Admin-Bereich.
 *
 * @package LifeLink
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Schlüsselspeicher.
 */
final class LifeLink_Keys {

	public const OPTION       = 'lifelink_keys';
	public const USAGE_OPTION = 'lifelink_key_usage';
	public const MAX_VALID    = 2;

	/**
	 * Wie viele widerrufene Schlüssel (ohne Geheimnis) zur Anzeige aufbewahrt werden.
	 */
	private const MAX_REVOKED = 10;

	/**
	 * Alle Schlüssel (gültige und widerrufene), nach Erstellzeit sortiert.
	 *
	 * @return array<string,array{id:string,secret:string,created_at:int,revoked_at:?int}>
	 */
	public function all(): array {
		$raw = get_option( self::OPTION, array() );
		if ( ! is_array( $raw ) ) {
			return array();
		}
		$keys = array();
		foreach ( $raw as $id => $key ) {
			if ( ! is_array( $key ) || ! self::is_key_id( (string) $id ) ) {
				continue;
			}
			$keys[ (string) $id ] = array(
				'id'         => (string) $id,
				'secret'     => isset( $key['secret'] ) ? (string) $key['secret'] : '',
				'created_at' => isset( $key['created_at'] ) ? (int) $key['created_at'] : 0,
				'revoked_at' => empty( $key['revoked_at'] ) ? null : (int) $key['revoked_at'],
			);
		}
		uasort(
			$keys,
			static function ( $a, $b ) {
				return $a['created_at'] <=> $b['created_at'];
			}
		);
		return $keys;
	}

	/**
	 * Nur gültige Schlüssel.
	 *
	 * @return array<string,array>
	 */
	public function valid(): array {
		return array_filter(
			$this->all(),
			static function ( $key ) {
				return null === $key['revoked_at'] && '' !== $key['secret'];
			}
		);
	}

	/**
	 * Gibt es mindestens einen gültigen Schlüssel?
	 */
	public function has_valid(): bool {
		return count( $this->valid() ) > 0;
	}

	/**
	 * Einzelner Schlüssel oder null.
	 *
	 * @param string $id Schlüssel-ID.
	 */
	public function get( string $id ): ?array {
		$all = $this->all();
		return $all[ $id ] ?? null;
	}

	/**
	 * Formatprüfung der Schlüssel-ID ("ll_" + 16 Hex-Zeichen).
	 *
	 * @param string $id Schlüssel-ID.
	 */
	public static function is_key_id( string $id ): bool {
		return 1 === preg_match( '/^ll_[0-9a-f]{16}$/', $id );
	}

	/**
	 * Erzeugt einen neuen Schlüssel.
	 *
	 * @return array{id:string,secret:string}|WP_Error
	 */
	public function generate() {
		if ( count( $this->valid() ) >= self::MAX_VALID ) {
			return new WP_Error( 'lifelink_too_many_keys', __( 'Es sind bereits zwei gültige Schlüssel vorhanden. Widerrufen Sie zuerst einen.', 'lifelink' ) );
		}

		$all = $this->all();
		do {
			$id = 'll_' . bin2hex( random_bytes( 8 ) );
		} while ( isset( $all[ $id ] ) );

		$secret = rtrim( strtr( base64_encode( random_bytes( 32 ) ), '+/', '-_' ), '=' ); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode

		$all[ $id ] = array(
			'id'         => $id,
			'secret'     => $secret,
			'created_at' => time(),
			'revoked_at' => null,
		);
		$this->save( $all );

		return array(
			'id'     => $id,
			'secret' => $secret,
		);
	}

	/**
	 * Widerruft einen Schlüssel sofort und löscht sein Geheimnis.
	 *
	 * @param string $id Schlüssel-ID.
	 */
	public function revoke( string $id ): bool {
		$all = $this->all();
		if ( ! isset( $all[ $id ] ) || null !== $all[ $id ]['revoked_at'] ) {
			return false;
		}
		$all[ $id ]['revoked_at'] = time();
		$all[ $id ]['secret']     = '';
		$this->save( $all );
		return true;
	}

	/**
	 * Merkt sich die Zeit der letzten erfolgreichen Anfrage.
	 *
	 * @param string $id Schlüssel-ID.
	 */
	public function record_use( string $id ): void {
		$usage = get_option( self::USAGE_OPTION, array() );
		if ( ! is_array( $usage ) ) {
			$usage = array();
		}
		$usage[ $id ] = time();
		$usage        = array_intersect_key( $usage, $this->all() );
		update_option( self::USAGE_OPTION, $usage, false );
	}

	/**
	 * Zeit der letzten erfolgreichen Anfrage oder null.
	 *
	 * @param string $id Schlüssel-ID.
	 */
	public function last_used( string $id ): ?int {
		$usage = get_option( self::USAGE_OPTION, array() );
		return ( is_array( $usage ) && ! empty( $usage[ $id ] ) ) ? (int) $usage[ $id ] : null;
	}

	/**
	 * Speichert die Schlüssel (nicht autoload) und kürzt alte widerrufene Einträge.
	 *
	 * @param array<string,array> $keys Schlüssel.
	 */
	private function save( array $keys ): void {
		$revoked = array_filter(
			$keys,
			static function ( $key ) {
				return null !== $key['revoked_at'];
			}
		);
		if ( count( $revoked ) > self::MAX_REVOKED ) {
			uasort(
				$revoked,
				static function ( $a, $b ) {
					return $b['revoked_at'] <=> $a['revoked_at'];
				}
			);
			foreach ( array_slice( array_keys( $revoked ), self::MAX_REVOKED ) as $old_id ) {
				unset( $keys[ $old_id ] );
			}
		}
		update_option( self::OPTION, $keys, false );
	}
}
