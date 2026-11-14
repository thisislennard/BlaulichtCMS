<?php
/**
 * Plugin-Einstellungen.
 *
 * @package LifeLink
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Liest und schreibt die Option "lifelink_settings".
 */
final class LifeLink_Settings {

	public const OPTION = 'lifelink_settings';

	/**
	 * Standardwerte.
	 *
	 * @return array<string,mixed>
	 */
	public static function defaults(): array {
		return array(
			'author_id'        => 0,
			'allow_future'     => false,
			'allow_categories' => false,
			'auto_output'      => true,
			'refresh'          => true,
		);
	}

	/**
	 * Alle Einstellungen (mit Standardwerten ergänzt).
	 *
	 * @return array<string,mixed>
	 */
	public function all(): array {
		$stored = get_option( self::OPTION, array() );
		if ( ! is_array( $stored ) ) {
			$stored = array();
		}
		$merged = array_merge( self::defaults(), array_intersect_key( $stored, self::defaults() ) );

		return array(
			'author_id'        => absint( $merged['author_id'] ),
			'allow_future'     => (bool) $merged['allow_future'],
			'allow_categories' => (bool) $merged['allow_categories'],
			'auto_output'      => (bool) $merged['auto_output'],
			'refresh'          => (bool) $merged['refresh'],
		);
	}

	/**
	 * Einzelner Wert.
	 *
	 * @param string $key Schlüssel.
	 * @return mixed
	 */
	public function get( string $key ) {
		$all = $this->all();
		return $all[ $key ] ?? null;
	}

	/**
	 * Speichert Einstellungen (nur bekannte Schlüssel).
	 *
	 * @param array<string,mixed> $values Neue Werte.
	 */
	public function update( array $values ): void {
		$current = $this->all();
		foreach ( self::defaults() as $key => $default ) {
			if ( ! array_key_exists( $key, $values ) ) {
				continue;
			}
			$current[ $key ] = is_bool( $default ) ? (bool) $values[ $key ] : absint( $values[ $key ] );
		}
		update_option( self::OPTION, $current, true );
	}

	/**
	 * Gültiger Autor (existiert und hat edit_posts) oder null.
	 */
	public function author(): ?WP_User {
		$id = (int) $this->get( 'author_id' );
		if ( $id <= 0 ) {
			return null;
		}
		$user = get_userdata( $id );
		if ( ! $user instanceof WP_User || ! user_can( $user, 'edit_posts' ) ) {
			return null;
		}
		return $user;
	}
}
