<?php
/**
 * Einheitliche Fehlerobjekte für die REST-Schnittstelle.
 *
 * @package LifeLink
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Baut WP_Error-Objekte im Vertragsformat
 * { "code": "...", "message": "...", "data": { "status": 401, "retryable": false } }.
 */
final class LifeLink_Error {

	/**
	 * Erzeugt einen Fehler.
	 *
	 * @param string $code      Fehlercode (lifelink_*).
	 * @param string $message   Klartextmeldung (deutsch).
	 * @param int    $status    HTTP-Status.
	 * @param bool   $retryable Ob ein erneuter Versuch sinnvoll ist.
	 * @param array  $extra     Zusätzliche Daten (z. B. fields).
	 */
	public static function make( string $code, string $message, int $status, bool $retryable = false, array $extra = array() ): WP_Error {
		return new WP_Error(
			$code,
			$message,
			array_merge(
				$extra,
				array(
					'status'    => $status,
					'retryable' => $retryable,
				)
			)
		);
	}

	/**
	 * Fehler 422 mit Feldliste.
	 *
	 * @param array<string,string> $errors Feldname => Meldung.
	 */
	public static function invalid( array $errors ): WP_Error {
		return self::make(
			'lifelink_invalid',
			__( 'Ungültige Nutzlast.', 'lifelink' ),
			422,
			false,
			array(
				'fields'  => array_keys( $errors ),
				'details' => $errors,
			)
		);
	}

	/**
	 * Interner Fehler (500, wiederholbar).
	 */
	public static function internal(): WP_Error {
		return self::make( 'lifelink_error', __( 'Interner Fehler im Plugin.', 'lifelink' ), 500, true );
	}
}
