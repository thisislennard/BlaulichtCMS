<?php
/**
 * Signaturprüfung von Bridge-Updates (#107).
 *
 * Die Prüfsumme im Update-Angebot stammt vom selben BlaulichtCMS-Server wie das Paket – wer den Server übernimmt, könnte
 * damit beliebigen PHP-Code auf alle gekoppelten Websites verteilen. Deshalb prüft die Bridge zusätzlich eine
 * Ed25519-Signatur (libsodium, sodium_crypto_sign_verify_detached; WordPress bringt sonst sodium_compat mit). Der
 * öffentliche Schlüssel ist in der installierten Bridge fest hinterlegt (includes/signing-keys.php), der private liegt
 * offline beim Betreiber – nicht auf dem BlaulichtCMS-Server.
 *
 * Signiert ist eine Dateiliste (signature.json) mit SHA-256 je Datei und der Version. Geprüft wird das entpackte Paket
 * vor der Installation (Filter upgrader_source_selection): Signatur gültig, jede Datei passt, keine zusätzliche Datei,
 * Version neuer als die installierte.
 *
 * Ohne hinterlegten Schlüssel (Rückfallbetrieb) bleibt es bei der Prüfsummenkontrolle.
 *
 * @package BlaulichtCMSBridge
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class BlaulichtCMS_Bridge_Signature {
	const FILE   = 'signature.json';
	const HEADER = 'BLAULICHTCMS-BRIDGE-SIGNATURE-V1';

	public static function boot(): void {
		add_filter( 'upgrader_source_selection', array( __CLASS__, 'check_source' ), 10, 4 );
	}

	/**
	 * Im installierten Plugin hinterlegte öffentliche Schlüssel (Base64, 32 Byte).
	 *
	 * @return string[]
	 */
	public static function keys(): array {
		static $keys = null;
		if ( null === $keys ) {
			$list = include BLAULICHTCMS_BRIDGE_DIR . 'includes/signing-keys.php';
			$keys = array_values(
				array_filter(
					is_array( $list ) ? $list : array(),
					static fn( $k ) => is_string( $k ) && 32 === strlen( (string) base64_decode( $k, true ) )
				)
			);
		}
		return $keys;
	}

	public static function enforced(): bool {
		return (bool) self::keys();
	}

	/** Signierte Nachricht (identisch zu server/src/lib/bridge-signature.ts). */
	public static function message( string $version, array $files ): string {
		ksort( $files, SORT_STRING );
		$msg = self::HEADER . "\nversion: " . $version . "\n";
		foreach ( $files as $name => $hash ) {
			$msg .= $hash . ' ' . $name . "\n";
		}
		return $msg;
	}

	/**
	 * Entpacktes Update vor der Installation prüfen. Nur für Updates dieser Bridge; eine bewusst von Hand hochgeladene
	 * ZIP-Datei (Plugin installieren) bleibt unberührt.
	 *
	 * @param string|WP_Error $source Entpackter Ordner.
	 * @return string|WP_Error
	 */
	public static function check_source( $source, $remote_source = '', $upgrader = null, $hook_extra = array() ) {
		if ( is_wp_error( $source ) || ! is_array( $hook_extra ) || ( $hook_extra['plugin'] ?? '' ) !== plugin_basename( BLAULICHTCMS_BRIDGE_FILE ) ) {
			return $source;
		}
		if ( ! self::enforced() ) {
			return $source; // Rückfallbetrieb: Prüfsumme aus BlaulichtCMS (BlaulichtCMS_Bridge_Updater::verified_download)
		}
		$err = self::verify_dir( untrailingslashit( (string) $source ), self::keys(), BLAULICHTCMS_BRIDGE_VERSION );
		return null === $err ? $source : $err;
	}

	/**
	 * Ordner gegen signature.json prüfen.
	 *
	 * @param string[] $keys    Erlaubte öffentliche Schlüssel (Base64).
	 * @param string   $current Installierte Version (das Update muss neuer sein).
	 * @return WP_Error|null null bei Erfolg.
	 */
	public static function verify_dir( string $dir, array $keys, string $current ) {
		$fail = static fn( string $why ) => new WP_Error( 'blaulichtcms_update_signature', 'Das Update der BlaulichtCMS Bridge wurde verworfen: ' . $why );
		if ( ! function_exists( 'sodium_crypto_sign_verify_detached' ) && is_readable( ABSPATH . WPINC . '/sodium_compat/autoload.php' ) ) {
			require_once ABSPATH . WPINC . '/sodium_compat/autoload.php';
		}
		if ( ! function_exists( 'sodium_crypto_sign_verify_detached' ) ) {
			return $fail( 'Signaturprüfung nicht möglich (libsodium fehlt).' );
		}
		$raw = is_readable( $dir . '/' . self::FILE ) ? (string) file_get_contents( $dir . '/' . self::FILE ) : ''; // phpcs:ignore WordPress.WP.AlternativeFunctions
		$sig = json_decode( $raw, true );
		if ( ! is_array( $sig ) ) {
			return $fail( 'Es ist nicht signiert.' );
		}
		if ( 1 !== ( $sig['format'] ?? null ) || ! is_string( $sig['version'] ?? null ) || ! is_string( $sig['key'] ?? null ) || ! is_string( $sig['signature'] ?? null ) || ! is_array( $sig['files'] ?? null ) ) {
			return $fail( 'Die Signaturdatei hat ein unbekanntes Format.' );
		}
		if ( ! in_array( $sig['key'], $keys, true ) ) {
			return $fail( 'Es ist mit einem Schlüssel signiert, der in dieser Bridge nicht hinterlegt ist.' );
		}
		$files = array();
		foreach ( $sig['files'] as $name => $hash ) {
			if ( ! is_string( $name ) || ! is_string( $hash ) || ! preg_match( '/^[0-9a-f]{64}$/', $hash ) ) {
				return $fail( 'Die Dateiliste ist ungültig.' );
			}
			$files[ $name ] = $hash;
		}
		$signature = base64_decode( $sig['signature'], true );
		$public    = base64_decode( $sig['key'], true );
		$valid     = false;
		try {
			$valid = false !== $signature && false !== $public && sodium_crypto_sign_verify_detached( $signature, self::message( $sig['version'], $files ), $public );
		} catch ( \Throwable $e ) {
			$valid = false;
		}
		if ( ! $valid ) {
			return $fail( 'Die Signatur ist ungültig.' );
		}
		// Jede Datei im Paket muss signiert sein und passen – auch keine zusätzlichen Dateien
		$seen = 0;
		$it   = new RecursiveIteratorIterator( new RecursiveDirectoryIterator( $dir, FilesystemIterator::SKIP_DOTS ) );
		foreach ( $it as $file ) {
			if ( ! $file->isFile() ) {
				continue;
			}
			$rel = str_replace( '\\', '/', substr( $file->getPathname(), strlen( $dir ) + 1 ) );
			if ( self::FILE === $rel ) {
				continue;
			}
			if ( ! isset( $files[ $rel ] ) || ! hash_equals( $files[ $rel ], (string) hash_file( 'sha256', $file->getPathname() ) ) ) {
				return $fail( 'Die Datei ' . $rel . ' passt nicht zur Signatur.' );
			}
			++$seen;
		}
		if ( count( $files ) !== $seen ) {
			return $fail( 'Im Paket fehlen signierte Dateien.' );
		}
		// Version: signiert, im Plugin-Kopf identisch, neuer als die installierte (kein Zurückspielen alter Versionen)
		$head = get_file_data( $dir . '/blaulichtcms-bridge.php', array( 'Version' => 'Version' ) );
		if ( ( $head['Version'] ?? '' ) !== $sig['version'] ) {
			return $fail( 'Die signierte Version passt nicht zum Plugin.' );
		}
		if ( ! version_compare( $sig['version'], $current, '>' ) ) {
			return $fail( 'Die signierte Version ist nicht neuer als die installierte.' );
		}
		return null;
	}
}
