<?php
/**
 * Einstellungen der Bridge (nicht autoload). Der Schlüssel gilt für genau diese Website.
 *
 * Zwei Optionen (#157): Einstellungen (Adresse, Schlüssel, Autor, Kategorie …) und Abrufstatus (letzter Abruf, Fehler …).
 * Der Abruf schreibt nur den Status. Ein langer Abruf kann so eine gleichzeitig gespeicherte Einstellung oder ein
 * Entkoppeln nicht mehr mit seinem Stand vom Anfang überschreiben. Geschrieben wird immer frisch aus der Datenbank
 * gelesen und nur mit den geänderten Schlüsseln gemischt.
 *
 * @package BlaulichtCMSBridge
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class BlaulichtCMS_Bridge_Settings {
	const OPTION        = 'blaulichtcms_bridge_settings';
	const STATUS_OPTION = 'blaulichtcms_bridge_status';

	/**
	 * Felder, die nur der Abruf schreibt. Ab 0.8.0 (#186) zusätzlich: Abrufweg, Selbstauslösung, Meldung an BlaulichtCMS
	 * und eigener Update-Lauf, wenn WP-Cron abgeschaltet ist.
	 */
	const STATUS_KEYS = array( 'last_poll', 'last_success', 'last_error', 'last_jobs', 'last_trigger', 'tick_at', 'last_report', 'report_hash', 'send_author', 'last_auto_update', 'auto_update_note' );

	/** Schweregrade der Hinweise (Art in BlaulichtCMS) und ihre Vorgaben für Farbe und Darstellung (#186). */
	const TONES = array(
		'info'    => array(
			'label'   => 'Hinweis',
			'color'   => '#134a86',
			'display' => 'banner',
		),
		'warning' => array(
			'label'   => 'Warnung',
			'color'   => '#b25e00',
			'display' => 'banner',
		),
		'danger'  => array(
			'label'   => 'Gefahr',
			'color'   => '#c8102e',
			'display' => 'both',
		),
	);

	/** Darstellungen eines Hinweises auf der Website. */
	const DISPLAYS = array(
		'banner' => 'Banner',
		'popup'  => 'Popup',
		'both'   => 'Banner und Popup',
	);

	/** Standardwerte. */
	public static function defaults(): array {
		return array(
			'url'           => '',
			'key'           => '',
			'site_id'       => '',
			'site_name'     => '',
			'poll_interval' => 60,
			'author_id'     => 0,
			'author_mode'   => '', // '' = bisheriges Verhalten: fester Benutzer, wenn gewählt, sonst eigener Autor der Bridge
			'author_name'   => 'Redaktion',
			'category_id'   => 0,
			'last_poll'     => 0,
			'last_success'  => 0,
			'last_error'    => '',
			'last_jobs'     => 0,
			'banner_auto'   => true,
			'display_info'    => self::TONES['info']['display'],
			'display_warning' => self::TONES['warning']['display'],
			'display_danger'  => self::TONES['danger']['display'],
			'color_info'      => self::TONES['info']['color'],
			'color_warning'   => self::TONES['warning']['color'],
			'color_danger'    => self::TONES['danger']['color'],
			'last_trigger'     => '',
			'tick_at'          => 0,
			'last_report'      => 0,
			'report_hash'      => '',
			'send_author'      => false,
			'last_auto_update' => 0,
			'auto_update_note' => '',
		);
	}

	/** Darstellung je Schweregrad (banner, popup, both). */
	public static function display_for_tone( string $tone ): string {
		$v = (string) self::get( 'display_' . $tone );
		return isset( self::DISPLAYS[ $v ] ) ? $v : ( self::TONES[ $tone ]['display'] ?? 'banner' );
	}

	/** Farbe je Schweregrad (#rrggbb). */
	public static function color_for_tone( string $tone ): string {
		$v = sanitize_hex_color( (string) self::get( 'color_' . $tone ) );
		return $v ? $v : ( self::TONES[ $tone ]['color'] ?? '#134a86' );
	}

	/**
	 * Option frisch aus der Datenbank lesen. get_option() hält nicht autoloadete Optionen für die Dauer des Requests im
	 * Objekt-Cache – ein Abruf über mehrere Minuten sähe sonst Änderungen aus anderen Requests nicht.
	 */
	private static function fresh( string $option ): array {
		wp_cache_delete( $option, 'options' );
		wp_cache_delete( 'notoptions', 'options' ); // sonst gilt eine inzwischen angelegte Option weiter als „fehlt“
		$v = get_option( $option, array() );
		return is_array( $v ) ? $v : array();
	}

	private static function write( string $option, array $value ): void {
		if ( false === get_option( $option, false ) ) {
			add_option( $option, $value, '', false );
		} else {
			update_option( $option, $value, false );
		}
	}

	/** Lesen (im Request zwischengespeichert – für die Ausgabe auf jeder Seite ohne zusätzliche Abfragen). */
	private static function cached( string $option ): array {
		$v = get_option( $option, array() );
		return is_array( $v ) ? $v : array();
	}

	public static function all(): array {
		return array_merge( self::defaults(), self::cached( self::OPTION ), self::cached( self::STATUS_OPTION ) );
	}

	public static function get( string $k ) {
		$all = self::all();
		return $all[ $k ] ?? null;
	}

	/**
	 * Geänderte Schlüssel übernehmen. Statusfelder landen in der Statusoption, alles andere in den Einstellungen.
	 * Gemischt wird mit dem aktuellen Stand der Datenbank, nicht mit einem früher gelesenen.
	 */
	public static function update( array $patch ): void {
		$status = array_intersect_key( $patch, array_flip( self::STATUS_KEYS ) );
		$main   = array_diff_key( $patch, $status );
		if ( $status ) {
			self::write( self::STATUS_OPTION, array_merge( self::fresh( self::STATUS_OPTION ), $status ) );
		}
		if ( $main ) {
			$cur = self::fresh( self::OPTION );
			// Statusfelder aus Versionen bis 0.5.x in die Statusoption verschieben
			$old = array_intersect_key( $cur, array_flip( self::STATUS_KEYS ) );
			if ( $old ) {
				self::write( self::STATUS_OPTION, array_merge( $old, self::fresh( self::STATUS_OPTION ) ) );
				$cur = array_diff_key( $cur, $old );
			}
			self::write( self::OPTION, array_merge( $cur, $main ) );
		}
	}

	/** Abrufstatus schreiben (nur Statusfelder). */
	public static function status( array $patch ): void {
		self::update( array_intersect_key( $patch, array_flip( self::STATUS_KEYS ) ) );
	}

	public static function is_paired(): bool {
		$s = self::all();
		return '' !== $s['url'] && '' !== $s['key'];
	}

	/** Kopplung lokal lösen (der Schlüssel sollte zusätzlich in BlaulichtCMS widerrufen werden). */
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
