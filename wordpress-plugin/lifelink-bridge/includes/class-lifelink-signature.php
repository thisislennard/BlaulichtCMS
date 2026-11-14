<?php
/**
 * HMAC-Signatur nach Schnittstellenvertrag v1.
 *
 * Bewusst ohne WordPress-Abhängigkeiten, damit die Funktion auch eigenständig
 * (wordpress-plugin/tests/signature-test.php) geprüft werden kann.
 *
 * kanonischer_string = METHOD + "\n" + ROUTE + "\n" + TIMESTAMP + "\n" + NONCE + "\n" + hex(SHA256(body))
 * Signatur           = "v1=" + hex(HMAC-SHA256(geheimnis, kanonischer_string))
 *
 * @package LifeLink
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Berechnet und prüft Anfragesignaturen.
 */
final class LifeLink_Signature {

	/**
	 * Präfix der Signaturversion.
	 */
	public const PREFIX = 'v1=';

	/**
	 * Baut den kanonischen String.
	 *
	 * @param string $method    HTTP-Methode (wird in Großbuchstaben gewandelt).
	 * @param string $route     REST-Route ohne /wp-json und ohne Query-String.
	 * @param string $timestamp Unix-Zeit in Sekunden, wie im Header übertragen.
	 * @param string $nonce     Nonce, wie im Header übertragen.
	 * @param string $body      Roher Request-Body (leerer String bei GET/DELETE).
	 */
	public static function canonical_string( string $method, string $route, string $timestamp, string $nonce, string $body ): string {
		return strtoupper( $method ) . "\n" . $route . "\n" . $timestamp . "\n" . $nonce . "\n" . hash( 'sha256', $body );
	}

	/**
	 * Erzeugt die Signatur inklusive Präfix "v1=".
	 *
	 * @param string $secret    Geheimnis (roher Base64url-Text, als UTF-8-Bytes verwendet).
	 * @param string $method    HTTP-Methode.
	 * @param string $route     REST-Route.
	 * @param string $timestamp Unix-Zeit.
	 * @param string $nonce     Nonce.
	 * @param string $body      Roher Body.
	 */
	public static function sign( string $secret, string $method, string $route, string $timestamp, string $nonce, string $body ): string {
		return self::PREFIX . hash_hmac( 'sha256', self::canonical_string( $method, $route, $timestamp, $nonce, $body ), $secret );
	}

	/**
	 * Prüft eine übertragene Signatur in konstanter Zeit.
	 *
	 * @param string $secret    Geheimnis.
	 * @param string $provided  Übertragene Signatur ("v1=<hex>").
	 * @param string $method    HTTP-Methode.
	 * @param string $route     REST-Route.
	 * @param string $timestamp Unix-Zeit.
	 * @param string $nonce     Nonce.
	 * @param string $body      Roher Body.
	 */
	public static function verify( string $secret, string $provided, string $method, string $route, string $timestamp, string $nonce, string $body ): bool {
		if ( '' === $secret ) {
			return false;
		}
		$expected = self::sign( $secret, $method, $route, $timestamp, $nonce, $body );
		return hash_equals( $expected, strtolower( $provided ) );
	}
}
