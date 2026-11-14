<?php
/**
 * Audit-/Änderungsprotokoll (letzte 200 Einträge, ohne Geheimnisse).
 *
 * @package LifeLink
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Speichert Einträge in der nicht automatisch geladenen Option "lifelink_audit".
 */
final class LifeLink_Audit_Log {

	public const OPTION       = 'lifelink_audit';
	public const ERROR_OPTION = 'lifelink_last_error';
	public const MAX          = 200;

	/**
	 * Fügt einen Eintrag hinzu.
	 *
	 * @param string $actor  Schlüssel-ID, "admin:<login>" oder "system".
	 * @param string $action Aktion, z. B. "banner.upsert".
	 * @param string $object Betroffenes Objekt (external_id, Post-ID, Schlüssel-ID).
	 * @param string $result Ergebnis, z. B. "ok", "unchanged", "lifelink_bad_signature".
	 */
	public function add( string $actor, string $action, string $object, string $result ): void {
		$entries = $this->entries();
		array_unshift(
			$entries,
			array(
				'time'   => time(),
				'actor'  => self::clean( $actor, 64 ),
				'action' => self::clean( $action, 64 ),
				'object' => self::clean( $object, 128 ),
				'result' => self::clean( $result, 64 ),
			)
		);
		update_option( self::OPTION, array_slice( $entries, 0, self::MAX ), false );
	}

	/**
	 * Alle Einträge, neueste zuerst.
	 *
	 * @return array<int,array{time:int,actor:string,action:string,object:string,result:string}>
	 */
	public function entries(): array {
		$entries = get_option( self::OPTION, array() );
		return is_array( $entries ) ? array_values( array_filter( $entries, 'is_array' ) ) : array();
	}

	/**
	 * Merkt sich den letzten abgewiesenen Zugriff (für die Verbindungsanzeige).
	 *
	 * @param string $code   Fehlercode.
	 * @param string $key_id Übermittelte Schlüssel-ID (nur wenn formal gültig).
	 */
	public function record_error( string $code, string $key_id = '' ): void {
		update_option(
			self::ERROR_OPTION,
			array(
				'time'   => time(),
				'code'   => self::clean( $code, 64 ),
				'key_id' => LifeLink_Keys::is_key_id( $key_id ) ? $key_id : '',
			),
			false
		);
	}

	/**
	 * Letzter abgewiesener Zugriff oder null.
	 *
	 * @return array{time:int,code:string,key_id:string}|null
	 */
	public function last_error(): ?array {
		$error = get_option( self::ERROR_OPTION, null );
		if ( ! is_array( $error ) || empty( $error['time'] ) ) {
			return null;
		}
		return array(
			'time'   => (int) $error['time'],
			'code'   => (string) ( $error['code'] ?? '' ),
			'key_id' => (string) ( $error['key_id'] ?? '' ),
		);
	}

	/**
	 * Bereinigt einen Text für das Protokoll.
	 *
	 * @param string $value Wert.
	 * @param int    $max   Maximale Länge.
	 */
	private static function clean( string $value, int $max ): string {
		return mb_substr( sanitize_text_field( $value ), 0, $max );
	}
}
