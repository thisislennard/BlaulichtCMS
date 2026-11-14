<?php
/**
 * Einstellungen der Bridge (eine Option, nicht autoload). Der Schlüssel gilt für genau diese Website.
 *
 * @package LifeLinkBridge
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class LifeLink_Bridge_Settings {
	const OPTION = 'lifelink_bridge_settings';

	/** Standardwerte. */
	public static function defaults(): array {
		return array(
			'url'           => '',
			'key'           => '',
			'site_id'       => '',
			'site_name'     => '',
			'poll_interval' => 60,
			'author_id'     => 0,
			'category_id'   => 0,
			'last_poll'     => 0,
			'last_success'  => 0,
			'last_error'    => '',
			'last_jobs'     => 0,
		);
	}

	public static function all(): array {
		$v = get_option( self::OPTION, array() );
		return array_merge( self::defaults(), is_array( $v ) ? $v : array() );
	}

	public static function get( string $k ) {
		$all = self::all();
		return $all[ $k ] ?? null;
	}

	public static function update( array $patch ): void {
		$next = array_merge( self::all(), $patch );
		if ( false === get_option( self::OPTION, false ) ) {
			add_option( self::OPTION, $next, '', false );
		} else {
			update_option( self::OPTION, $next, false );
		}
	}

	public static function is_paired(): bool {
		$s = self::all();
		return '' !== $s['url'] && '' !== $s['key'];
	}

	/** Kopplung lokal lösen (der Schlüssel sollte zusätzlich in LifeLink widerrufen werden). */
	public static function unpair(): void {
		self::update(
			array(
				'key'        => '',
				'site_id'    => '',
				'site_name'  => '',
				'last_error' => '',
			)
		);
	}
}
