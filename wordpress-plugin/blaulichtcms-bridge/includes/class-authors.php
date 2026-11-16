<?php
/**
 * Autoren der Beiträge (#186).
 *
 * Drei Wege (Einstellungen → BlaulichtCMS Bridge → Beiträge):
 * - „bridge“: ein eigener Autor der Bridge (Anzeigename einstellbar, Vorgabe „Redaktion“). Die Bridge legt ihn beim
 *   ersten Beitrag selbst an.
 * - „person“: je verfassender Person in BlaulichtCMS ein eigener Autor mit deren Namen. Setzt voraus, dass in BlaulichtCMS
 *   für diese Website „Autorenname übertragen“ eingeschaltet ist; sonst gilt der eigene Autor der Bridge.
 * - „fixed“: ein vorhandener WordPress-Benutzer.
 *
 * Sicherheit: Von der Bridge angelegte Autoren erhalten die Rolle „BlaulichtCMS-Autor“ ohne jede Fähigkeit (nicht einmal
 * „read“), ein zufälliges, nirgends gespeichertes Passwort und keine E-Mail-Adresse. Anmeldung, Passwort-Zurücksetzen und
 * Anwendungspasswörter sind für sie gesperrt – auch, wenn jemand die Rolle später von Hand ändert. Die Bridge vergibt nie
 * Rechte; sie ordnet einem Beitrag nur einen Autor für die Anzeige zu.
 *
 * @package BlaulichtCMSBridge
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class BlaulichtCMS_Bridge_Authors {
	const ROLE = 'blaulichtcms_author';
	/** Markiert einen von der Bridge angelegten Autor: „bridge“ oder „p:<Schlüssel aus BlaulichtCMS>“. */
	const META = '_blaulichtcms_author_key';
	const MODES = array( 'bridge', 'person', 'fixed' );

	public static function boot(): void {
		add_filter( 'authenticate', array( __CLASS__, 'block_login' ), 100, 1 );
		add_filter( 'wp_is_application_passwords_available_for_user', array( __CLASS__, 'app_passwords' ), 10, 2 );
		add_filter( 'allow_password_reset', array( __CLASS__, 'password_reset' ), 10, 2 );
	}

	/** Gewählter Weg. Ohne Auswahl (Versionen bis 0.7.x): fester Benutzer, wenn einer gewählt ist, sonst eigener Autor. */
	public static function mode(): string {
		$s = BlaulichtCMS_Bridge_Settings::all();
		$m = (string) $s['author_mode'];
		if ( in_array( $m, self::MODES, true ) ) {
			return $m;
		}
		return (int) $s['author_id'] > 0 ? 'fixed' : 'bridge';
	}

	public static function is_bridge_author( int $user_id ): bool {
		return $user_id > 0 && '' !== (string) get_user_meta( $user_id, self::META, true );
	}

	/**
	 * Anmeldung für Autoren der Bridge sperren.
	 *
	 * @param WP_User|WP_Error|null $user Ergebnis der vorherigen Prüfungen.
	 * @return WP_User|WP_Error|null
	 */
	public static function block_login( $user ) {
		if ( $user instanceof WP_User && self::is_bridge_author( (int) $user->ID ) ) {
			return new WP_Error( 'blaulichtcms_author_login', 'Dieses Konto zeigt nur die Autorenangabe von Beiträgen aus BlaulichtCMS an und kann sich nicht anmelden.' );
		}
		return $user;
	}

	/**
	 * @param bool    $available Vorheriger Wert.
	 * @param WP_User $user      Benutzer.
	 */
	public static function app_passwords( $available, $user ) {
		return $user instanceof WP_User && self::is_bridge_author( (int) $user->ID ) ? false : $available;
	}

	/**
	 * @param bool $allow   Vorheriger Wert.
	 * @param int  $user_id Benutzer.
	 */
	public static function password_reset( $allow, $user_id ) {
		return self::is_bridge_author( (int) $user_id ) ? false : $allow;
	}

	private static function ensure_role(): void {
		if ( ! get_role( self::ROLE ) ) {
			add_role( self::ROLE, 'BlaulichtCMS-Autor', array() );
		}
	}

	private static function find( string $key ): int {
		$ids = get_users(
			array(
				'meta_key'    => self::META, // phpcs:ignore WordPress.DB.SlowDBQuery
				'meta_value'  => $key,       // phpcs:ignore WordPress.DB.SlowDBQuery
				'number'      => 1,
				'fields'      => 'ID',
				'count_total' => false,
				'blog_id'     => 0, // auf Multisite netzweit – derselbe Autor für alle Websites des Netzes
			)
		);
		return $ids ? (int) $ids[0] : 0;
	}

	/** Anzeigename an die Einstellung bzw. an BlaulichtCMS angleichen. */
	private static function sync_name( int $id, string $name ): void {
		$u = get_userdata( $id );
		if ( $u && $u->display_name !== $name ) {
			wp_update_user(
				array(
					'ID'           => $id,
					'display_name' => $name,
					'nickname'     => $name,
				)
			);
		}
		// Auf Multisite der aktuellen Website mit der rechtelosen Rolle hinzufügen
		if ( is_multisite() && ! is_user_member_of_blog( $id ) ) {
			self::ensure_role();
			add_user_to_blog( get_current_blog_id(), $id, self::ROLE );
		}
	}

	/** Autor ohne Anmeldung anlegen. */
	private static function create( string $key, string $name, string $login_base ): int {
		self::ensure_role();
		$base  = sanitize_user( remove_accents( $login_base ), true );
		$base  = '' !== $base ? substr( $base, 0, 50 ) : 'blaulichtcms-autor';
		$login = $base;
		for ( $i = 2; username_exists( $login ); $i++ ) {
			if ( $i > 100 ) {
				return 0;
			}
			$login = $base . '-' . $i;
		}
		$id = wp_insert_user(
			array(
				'user_login'           => $login,
				'user_pass'            => wp_generate_password( 64, true, true ),
				'user_email'           => '',
				'display_name'         => $name,
				'nickname'             => $name,
				'user_nicename'        => substr( sanitize_title( $name ), 0, 50 ),
				'role'                 => self::ROLE,
				'show_admin_bar_front' => 'false',
			)
		);
		if ( is_wp_error( $id ) ) {
			return 0;
		}
		update_user_meta( (int) $id, self::META, $key );
		return (int) $id;
	}

	/** Eigener Autor der Bridge (wird bei Bedarf angelegt). */
	public static function bridge_author(): int {
		$name = trim( (string) BlaulichtCMS_Bridge_Settings::get( 'author_name' ) );
		$name = '' !== $name ? $name : 'Redaktion';
		$id   = self::find( 'bridge' );
		if ( $id ) {
			self::sync_name( $id, $name );
			return $id;
		}
		return self::create( 'bridge', $name, 'blaulichtcms-redaktion' );
	}

	/**
	 * Autor eines Auftrags.
	 *
	 * @param array $job Auftrag aus BlaulichtCMS; optional `author` = { key, name } (nur, wenn in BlaulichtCMS eingeschaltet).
	 * @return int Benutzer-ID oder 0.
	 */
	public static function for_job( array $job ): int {
		$mode = self::mode();
		if ( 'fixed' === $mode ) {
			$id = (int) BlaulichtCMS_Bridge_Settings::get( 'author_id' );
			if ( $id && get_userdata( $id ) ) {
				return $id;
			}
		}
		if ( 'person' === $mode && is_array( $job['author'] ?? null ) ) {
			$key  = strtolower( (string) ( $job['author']['key'] ?? '' ) );
			$name = trim( sanitize_text_field( (string) ( $job['author']['name'] ?? '' ) ) );
			$name = function_exists( 'mb_substr' ) ? mb_substr( $name, 0, 100 ) : substr( $name, 0, 100 );
			if ( preg_match( '/^[a-f0-9]{16,64}$/', $key ) && '' !== $name ) {
				$id = self::find( 'p:' . $key );
				if ( $id ) {
					self::sync_name( $id, $name );
					return $id;
				}
				$id = self::create( 'p:' . $key, $name, 'blaulichtcms-' . $name );
				if ( $id ) {
					return $id;
				}
			}
		}
		return self::bridge_author();
	}
}
