<?php
/**
 * Datenzugriff auf die Banner-Tabelle {$wpdb->prefix}lifelink_banners.
 *
 * Alle Zeiten werden als UTC (DATETIME) gespeichert.
 *
 * @package LifeLink
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Banner-Repository.
 */
final class LifeLink_Banner_Repository {

	public const CACHE_GROUP     = 'lifelink';
	public const RETENTION_DAYS  = 30;
	private const PRIORITY_RANKS = array(
		'niedrig' => 0,
		'normal'  => 1,
		'hoch'    => 2,
	);

	/**
	 * Tabellenname der aktuellen Site.
	 */
	public static function table(): string {
		global $wpdb;
		return $wpdb->prefix . 'lifelink_banners';
	}

	/**
	 * Legt die Tabelle an bzw. aktualisiert sie (dbDelta).
	 */
	public static function create_table(): void {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';

		$table           = self::table();
		$charset_collate = $wpdb->get_charset_collate();

		$sql = "CREATE TABLE {$table} (
  id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  external_id char(36) NOT NULL,
  revision bigint(20) unsigned NOT NULL DEFAULT 1,
  title varchar(255) NOT NULL DEFAULT '',
  body text NOT NULL,
  color varchar(16) NOT NULL DEFAULT 'neutral',
  label varchar(64) NOT NULL DEFAULT '',
  priority varchar(16) NOT NULL DEFAULT 'normal',
  priority_rank tinyint(3) unsigned NOT NULL DEFAULT 1,
  starts_at datetime NOT NULL,
  ends_at datetime NULL DEFAULT NULL,
  pages text NOT NULL,
  link_url text NULL,
  link_text varchar(255) NULL DEFAULT NULL,
  deactivated_at datetime NULL DEFAULT NULL,
  created_at datetime NOT NULL,
  updated_at datetime NOT NULL,
  PRIMARY KEY  (id),
  UNIQUE KEY external_id (external_id),
  KEY schedule (deactivated_at,ends_at,starts_at)
) {$charset_collate};";

		dbDelta( $sql );
	}

	/**
	 * DATETIME-String (UTC) aus Unix-Zeit.
	 *
	 * @param int $timestamp Unix-Zeit.
	 */
	private static function dt( int $timestamp ): string {
		return gmdate( 'Y-m-d H:i:s', $timestamp );
	}

	/**
	 * Unix-Zeit aus DATETIME-String (UTC) oder null.
	 *
	 * @param mixed $value DATETIME.
	 */
	public static function ts( $value ): ?int {
		if ( ! is_string( $value ) || '' === $value || str_starts_with( $value, '0000-00-00' ) ) {
			return null;
		}
		$ts = strtotime( $value . ' UTC' );
		return false === $ts ? null : $ts;
	}

	/**
	 * Einzelnes Banner.
	 *
	 * @param string $external_id UUID.
	 */
	public function find( string $external_id ): ?array {
		global $wpdb;
		$table = self::table();
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching,WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		$row = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$table} WHERE external_id = %s", $external_id ), ARRAY_A );
		return is_array( $row ) ? $row : null;
	}

	/**
	 * Alle bekannten Banner inkl. abgelaufener/deaktivierter der letzten 30 Tage.
	 *
	 * @return array<int,array>
	 */
	public function all_recent(): array {
		global $wpdb;
		$table  = self::table();
		$cutoff = self::dt( time() - self::RETENTION_DAYS * DAY_IN_SECONDS );
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching,WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		$rows = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT * FROM {$table} WHERE (ends_at IS NULL OR ends_at > %s) AND (deactivated_at IS NULL OR deactivated_at > %s) ORDER BY priority_rank DESC, starts_at DESC LIMIT 1000", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$cutoff,
				$cutoff
			),
			ARRAY_A
		);
		return is_array( $rows ) ? $rows : array();
	}

	/**
	 * Nicht deaktivierte, noch nicht abgelaufene Banner (inkl. geplanter), sortiert.
	 * Ergebnis wird im Objekt-Cache gehalten und bei jeder Änderung invalidiert.
	 *
	 * @return array<int,array>
	 */
	private function candidates(): array {
		global $wpdb;
		$key    = 'candidates:' . wp_cache_get_last_changed( self::CACHE_GROUP );
		$cached = wp_cache_get( $key, self::CACHE_GROUP );
		if ( is_array( $cached ) ) {
			return $cached;
		}
		$table = self::table();
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
		$rows = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT * FROM {$table} WHERE deactivated_at IS NULL AND (ends_at IS NULL OR ends_at > %s) ORDER BY priority_rank DESC, starts_at DESC LIMIT 500", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				self::dt( time() )
			),
			ARRAY_A
		);
		$rows = is_array( $rows ) ? $rows : array();
		wp_cache_set( $key, $rows, self::CACHE_GROUP, 5 * MINUTE_IN_SECONDS );
		return $rows;
	}

	/**
	 * Jetzt aktive Banner, optional auf Ziele gefiltert. Sortierung: Priorität, dann Start absteigend.
	 *
	 * @param string[]|null $targets Ziele (null = alle aktiven).
	 * @return array<int,array>
	 */
	public function active( ?array $targets = null ): array {
		$now    = time();
		$result = array();
		foreach ( $this->candidates() as $row ) {
			if ( 'aktiv' !== self::state( $row, $now ) ) {
				continue;
			}
			if ( null !== $targets && ! array_intersect( self::pages( $row ), $targets ) ) {
				continue;
			}
			$result[] = $row;
		}
		return $result;
	}

	/**
	 * Fingerabdruck der aktiven Banner (für den 5-Minuten-Abgleich).
	 */
	public function active_fingerprint(): string {
		$parts = array();
		foreach ( $this->active() as $row ) {
			$parts[] = $row['external_id'] . ':' . $row['revision'];
		}
		return md5( implode( '|', $parts ) );
	}

	/**
	 * Idempotentes Upsert nach Revisionsregel.
	 *
	 * @param string $external_id UUID (klein geschrieben).
	 * @param array  $data        Validierte Daten aus LifeLink_Validator::banner().
	 * @return array{banner:array,unchanged:bool,previous:?array}|WP_Error
	 */
	public function upsert( string $external_id, array $data ) {
		global $wpdb;
		$table    = self::table();
		$existing = $this->find( $external_id );

		if ( null !== $existing && (int) $existing['revision'] >= (int) $data['revision'] ) {
			return array(
				'banner'    => $existing,
				'unchanged' => true,
				'previous'  => $existing,
			);
		}

		$now    = self::dt( time() );
		$fields = array(
			'revision'       => (int) $data['revision'],
			'title'          => $data['title'],
			'body'           => $data['text'],
			'color'          => $data['color'],
			'label'          => $data['label'],
			'priority'       => $data['priority'],
			'priority_rank'  => self::PRIORITY_RANKS[ $data['priority'] ],
			'starts_at'      => self::dt( (int) $data['starts_at'] ),
			'ends_at'        => null === $data['ends_at'] ? null : self::dt( (int) $data['ends_at'] ),
			'pages'          => (string) wp_json_encode( array_values( $data['pages'] ) ),
			'link_url'       => $data['link_url'],
			'link_text'      => $data['link_text'],
			// Eine neue Revision aus LifeLink beschreibt den vollständigen Soll-Zustand
			// und hebt eine frühere Deaktivierung auf.
			'deactivated_at' => null,
			'updated_at'     => $now,
		);

		if ( null === $existing ) {
			$suppress = $wpdb->suppress_errors( true );
			// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery
			$inserted = $wpdb->insert(
				$table,
				array_merge(
					$fields,
					array(
						'external_id' => $external_id,
						'created_at'  => $now,
					)
				)
			);
			$wpdb->suppress_errors( $suppress );
			if ( 1 === $inserted ) {
				$this->invalidate();
				return array(
					'banner'    => (array) $this->find( $external_id ),
					'unchanged' => false,
					'previous'  => null,
				);
			}
			// Parallel angelegt (UNIQUE-Konflikt) → bedingtes Update unten.
			if ( null === $this->find( $external_id ) ) {
				return LifeLink_Error::internal();
			}
		}

		// Atomar: nur überschreiben, wenn die gespeicherte Revision kleiner ist.
		$set    = array();
		$values = array();
		foreach ( $fields as $column => $value ) {
			if ( null === $value ) {
				$set[] = "`{$column}` = NULL";
			} elseif ( is_int( $value ) ) {
				$set[]    = "`{$column}` = %d";
				$values[] = $value;
			} else {
				$set[]    = "`{$column}` = %s";
				$values[] = $value;
			}
		}
		$values[] = $external_id;
		$values[] = (int) $data['revision'];

		$sql = "UPDATE {$table} SET " . implode( ', ', $set ) . ' WHERE external_id = %s AND revision < %d';
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching,WordPress.DB.PreparedSQL.NotPrepared
		$updated = $wpdb->query( $wpdb->prepare( $sql, $values ) );
		if ( false === $updated ) {
			return LifeLink_Error::internal();
		}

		$current = $this->find( $external_id );
		if ( null === $current ) {
			return LifeLink_Error::internal();
		}
		if ( 0 === (int) $updated ) {
			return array(
				'banner'    => $current,
				'unchanged' => true,
				'previous'  => $current,
			);
		}

		$this->invalidate();
		return array(
			'banner'    => $current,
			'unchanged' => false,
			'previous'  => $existing,
		);
	}

	/**
	 * Deaktiviert ein Banner.
	 *
	 * @param string $external_id UUID.
	 * @return array|null Das Banner nach der Deaktivierung oder null, wenn unbekannt.
	 */
	public function deactivate( string $external_id ): ?array {
		global $wpdb;
		$row = $this->find( $external_id );
		if ( null === $row ) {
			return null;
		}
		if ( empty( $row['deactivated_at'] ) ) {
			$now = self::dt( time() );
			// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
			$wpdb->update(
				self::table(),
				array(
					'deactivated_at' => $now,
					'updated_at'     => $now,
				),
				array( 'external_id' => $external_id ),
				array( '%s', '%s' ),
				array( '%s' )
			);
			$this->invalidate();
			$row = $this->find( $external_id );
		}
		return $row;
	}

	/**
	 * Löscht Banner, die seit mehr als 30 Tagen abgelaufen oder deaktiviert sind.
	 *
	 * @return int Anzahl gelöschter Zeilen.
	 */
	public function purge_old(): int {
		global $wpdb;
		$table  = self::table();
		$cutoff = self::dt( time() - self::RETENTION_DAYS * DAY_IN_SECONDS );
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
		$deleted = $wpdb->query(
			$wpdb->prepare(
				"DELETE FROM {$table} WHERE (ends_at IS NOT NULL AND ends_at < %s) OR (deactivated_at IS NOT NULL AND deactivated_at < %s)", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$cutoff,
				$cutoff
			)
		);
		if ( $deleted ) {
			$this->invalidate();
		}
		return (int) $deleted;
	}

	/**
	 * Invalidiert den Objekt-Cache des Repositories.
	 */
	public function invalidate(): void {
		wp_cache_delete( 'last_changed', self::CACHE_GROUP );
	}

	/**
	 * Zielseiten eines Banners.
	 *
	 * @param array $row Datenbankzeile.
	 * @return string[]
	 */
	public static function pages( array $row ): array {
		$pages = json_decode( (string) ( $row['pages'] ?? '[]' ), true );
		return is_array( $pages ) ? array_values( array_filter( $pages, 'is_string' ) ) : array();
	}

	/**
	 * Zustand eines Banners: geplant, aktiv, abgelaufen, deaktiviert.
	 *
	 * @param array    $row Datenbankzeile.
	 * @param int|null $now Bezugszeit.
	 */
	public static function state( array $row, ?int $now = null ): string {
		$now = $now ?? time();
		if ( null !== self::ts( $row['deactivated_at'] ?? null ) ) {
			return 'deaktiviert';
		}
		$starts = self::ts( $row['starts_at'] ?? null );
		$ends   = self::ts( $row['ends_at'] ?? null );
		if ( null !== $ends && $ends <= $now ) {
			return 'abgelaufen';
		}
		if ( null !== $starts && $starts > $now ) {
			return 'geplant';
		}
		return 'aktiv';
	}

	/**
	 * Banner-Objekt für API-Antworten.
	 *
	 * @param array $row    Datenbankzeile.
	 * @param bool  $public Für den öffentlichen Endpunkt (ohne revision/updated_at).
	 */
	public static function to_api( array $row, bool $public = false ): array {
		$starts  = self::ts( $row['starts_at'] ?? null );
		$ends    = self::ts( $row['ends_at'] ?? null );
		$updated = self::ts( $row['updated_at'] ?? null );

		$banner = array(
			'external_id' => (string) $row['external_id'],
			'revision'    => (int) $row['revision'],
			'title'       => (string) $row['title'],
			'text'        => (string) $row['body'],
			'color'       => (string) $row['color'],
			'label'       => (string) $row['label'],
			'priority'    => (string) $row['priority'],
			'starts_at'   => null === $starts ? null : LifeLink_Validator::to_iso( $starts ),
			'ends_at'     => null === $ends ? null : LifeLink_Validator::to_iso( $ends ),
			'pages'       => self::pages( $row ),
			'link_url'    => ( isset( $row['link_url'] ) && '' !== $row['link_url'] ) ? (string) $row['link_url'] : null,
			'link_text'   => ( isset( $row['link_text'] ) && '' !== $row['link_text'] ) ? (string) $row['link_text'] : null,
			'state'       => self::state( $row ),
			'updated_at'  => null === $updated ? null : LifeLink_Validator::to_iso( $updated ),
		);

		if ( $public ) {
			unset( $banner['revision'], $banner['updated_at'] );
		}
		return $banner;
	}
}
