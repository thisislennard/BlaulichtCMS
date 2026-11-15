<?php
/**
 * Regelmäßiger Abruf über WP-Cron (jede Minute) oder Host-Cron (`wp blaulichtcms-bridge poll`).
 * Eine Sperre verhindert parallele Läufe; jeder Auftrag wird einzeln bestätigt.
 *
 * @package BlaulichtCMSBridge
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class BlaulichtCMS_Bridge_Sync {
	const HOOK = 'blaulichtcms_bridge_poll';
	const LOCK = 'blaulichtcms_bridge_lock';

	public static function boot(): void {
		add_filter( 'cron_schedules', array( __CLASS__, 'schedules' ) );
		add_action( self::HOOK, array( __CLASS__, 'cron' ) );
		// Falls das Ereignis verloren ging (z. B. nach Migration), neu einplanen.
		add_action(
			'init',
			static function () {
				if ( BlaulichtCMS_Bridge_Settings::is_paired() && ! wp_next_scheduled( self::HOOK ) ) {
					wp_schedule_event( time() + 30, 'blaulichtcms_minute', self::HOOK );
				}
			}
		);
	}

	public static function schedules( array $s ): array {
		$s['blaulichtcms_minute'] = array(
			'interval' => 60,
			'display'  => 'BlaulichtCMS: jede Minute',
		);
		return $s;
	}

	public static function activate(): void {
		if ( ! wp_next_scheduled( self::HOOK ) ) {
			wp_schedule_event( time() + 30, 'blaulichtcms_minute', self::HOOK );
		}
	}

	public static function deactivate(): void {
		wp_clear_scheduled_hook( self::HOOK );
		delete_option( self::LOCK );
		delete_transient( self::LOCK ); // Altbestand bis 0.4.0
	}

	public static function cron(): void {
		self::poll( false );
	}

	/** Neue Aufträge beginnt ein Abruf nur in den ersten 90 Sekunden; übrige liefert BlaulichtCMS beim nächsten Abruf erneut aus. */
	const MAX_RUN_SECONDS = 90;
	/**
	 * Eine Sperre gilt als verwaist, wenn sie so lange nicht erneuert wurde (Prozess abgebrochen). Erneuert wird vor jedem
	 * Auftrag und vor und nach jeder Mediendatei (#123). Der Wert liegt deshalb deutlich über dem längsten Einzel-Download
	 * (BlaulichtCMS_Bridge_Client::MEDIA_TIMEOUT, 300 s) – ein langsamer Videoimport gilt nicht als verwaist.
	 */
	const LOCK_STALE_SECONDS = 600;

	/** Besitzer-Token des laufenden Abrufs in diesem Prozess (für heartbeat()). */
	private static ?string $token = null;

	/**
	 * Atomare Sperre mit Besitzer-Token (#66): add_option() legt die Zeile nur an, wenn es sie noch nicht gibt.
	 *
	 * @return string|null Token bei Erfolg.
	 */
	private static function acquire(): ?string {
		$token = wp_generate_password( 20, false );
		for ( $i = 0; $i < 2; $i++ ) {
			if ( add_option( self::LOCK, $token . '|' . time(), '', 'no' ) ) {
				return $token;
			}
			$cur   = (string) get_option( self::LOCK, '' );
			$since = (int) substr( $cur, strpos( $cur, '|' ) + 1 );
			if ( $since && time() - $since < self::LOCK_STALE_SECONDS ) {
				return null;
			}
			// Verwaist: nur genau diesen Stand entfernen (ein anderer Lauf könnte ihn gerade erneuert haben).
			global $wpdb;
			$wpdb->delete( $wpdb->options, array( 'option_name' => self::LOCK, 'option_value' => $cur ) );
			wp_cache_delete( self::LOCK, 'options' );
			wp_cache_delete( 'notoptions', 'options' );
		}
		return null;
	}

	/**
	 * Sperre erneuern – nur, solange sie noch diesem Lauf gehört.
	 *
	 * @return bool false, wenn ein anderer Lauf die Sperre inzwischen übernommen hat.
	 */
	private static function refresh( string $token ): bool {
		global $wpdb;
		$like = $wpdb->esc_like( $token . '|' ) . '%';
		$wpdb->query( $wpdb->prepare( "UPDATE {$wpdb->options} SET option_value = %s WHERE option_name = %s AND option_value LIKE %s", $token . '|' . time(), self::LOCK, $like ) );
		wp_cache_delete( self::LOCK, 'options' );
		// Nicht die Zahl geänderter Zeilen auswerten: bei gleichem Zeitstempel meldet MySQL 0, obwohl die Sperre gehört.
		$cur = (string) $wpdb->get_var( $wpdb->prepare( "SELECT option_value FROM {$wpdb->options} WHERE option_name = %s", self::LOCK ) );
		return 0 === strpos( $cur, $token . '|' );
	}

	/**
	 * Sperre während eines langen Auftrags erneuern (vor und nach jedem Medien-Download).
	 *
	 * @return bool false, wenn die Sperre verloren ist – der Auftrag soll dann ohne Rückmeldung abbrechen.
	 */
	public static function heartbeat(): bool {
		return null === self::$token || self::refresh( self::$token );
	}

	private static function release( string $token ): void {
		global $wpdb;
		$wpdb->query( $wpdb->prepare( "DELETE FROM {$wpdb->options} WHERE option_name = %s AND option_value LIKE %s", self::LOCK, $wpdb->esc_like( $token . '|' ) . '%' ) );
		wp_cache_delete( self::LOCK, 'options' );
	}

	/**
	 * Aufträge abholen und verarbeiten.
	 *
	 * @param bool $force Manueller Abruf („Jetzt abrufen“, WP-CLI). Läuft gerade ein Abruf, wird nicht parallel
	 *                    gestartet, sondern ein Hinweis zurückgegeben.
	 * @return int|WP_Error Anzahl verarbeiteter Aufträge.
	 */
	public static function poll( bool $force ) {
		if ( ! BlaulichtCMS_Bridge_Settings::is_paired() ) {
			return new WP_Error( 'blaulichtcms_not_paired', 'Die Website ist nicht mit BlaulichtCMS gekoppelt.' );
		}
		$token = self::acquire();
		if ( null === $token ) {
			return $force ? new WP_Error( 'blaulichtcms_busy', 'Es läuft gerade ein Abruf. Bitte in einer Minute erneut versuchen.' ) : 0;
		}
		self::$token = $token;
		$started     = time();
		BlaulichtCMS_Bridge_Settings::status( array( 'last_poll' => $started ) );
		try {
			$res = BlaulichtCMS_Bridge_Client::jobs();
			if ( is_wp_error( $res ) ) {
				$msg = $res->get_error_message();
				if ( BlaulichtCMS_Bridge_Client::is_key_rejected( $res ) ) {
					// Schlüssel in BlaulichtCMS widerrufen: Beenden/Entwarnung kommen nicht mehr an, Banner nicht weiter zeigen (#156)
					if ( BlaulichtCMS_Bridge_Banners::all() ) {
						$msg .= ' Hinweis-Banner wurden entfernt.';
					}
					BlaulichtCMS_Bridge_Banners::clear();
				}
				BlaulichtCMS_Bridge_Settings::status( array( 'last_error' => $msg ) );
				return $res;
			}
			$count     = 0;
			$ack_error = '';
			foreach ( (array) ( $res['jobs'] ?? array() ) as $job ) {
				// Übrige Aufträge liefert BlaulichtCMS beim nächsten Abruf erneut aus.
				if ( time() - $started > self::MAX_RUN_SECONDS ) {
					break;
				}
				if ( ! self::refresh( $token ) ) {
					break; // Sperre verloren: nicht parallel zu einem anderen Lauf weiterarbeiten
				}
				$id = (string) ( $job['id'] ?? '' );
				if ( '' === $id ) {
					continue;
				}
				$type = (string) ( $job['type'] ?? '' );
				// Ein einzelner fehlerhafter Auftrag darf den Stapel nicht abbrechen (#67).
				try {
					if ( 'banner.upsert' === $type || 'banner.delete' === $type ) {
						if ( 'banner.upsert' === $type ) {
							BlaulichtCMS_Bridge_Banners::upsert( (array) ( $job['banner'] ?? array() ) );
						} else {
							BlaulichtCMS_Bridge_Banners::delete( (string) ( $job['banner']['id'] ?? '' ) );
						}
						$out = array(
							'remote_id'     => 0,
							'url'           => '',
							'remote_status' => 'ok',
						);
					} else {
						$out = 'post.unpublish' === $type ? BlaulichtCMS_Bridge_Publisher::unpublish( $job ) : BlaulichtCMS_Bridge_Publisher::upsert( $job );
					}
				} catch ( \Throwable $e ) {
					$out = new WP_Error( 'blaulichtcms_job_crashed', 'Fehler in der Bridge: ' . substr( $e->getMessage(), 0, 300 ) );
				}
				// Zurückgestellt (Laufzeit) oder Sperre verloren: keine Rückmeldung, BlaulichtCMS liefert den Auftrag erneut aus.
				// Bereits übernommene Medien werden dann wiederverwendet.
				if ( is_wp_error( $out ) && in_array( $out->get_error_code(), array( 'blaulichtcms_deferred', 'blaulichtcms_lock_lost' ), true ) ) {
					break;
				}
				if ( is_wp_error( $out ) ) {
					$report = array(
						'status' => 'failed',
						'error'  => $out->get_error_message(),
					);
				} else {
					$report = array_filter(
						array(
							'status'        => 'published',
							'remote_id'     => $out['remote_id'],
							'url'           => $out['url'],
							'remote_status' => $out['remote_status'],
						),
						static fn( $v ) => '' !== $v && 0 !== $v
					);
				}
				// Schlägt die Rückmeldung fehl, liefert BlaulichtCMS den Auftrag erneut aus – derselbe Beitrag wird dann aktualisiert.
				$ack = BlaulichtCMS_Bridge_Client::result( $id, $report );
				if ( is_wp_error( $ack ) ) {
					$ack_error = 'Rückmeldung fehlgeschlagen: ' . $ack->get_error_message();
				}
				++$count;
			}
			if ( isset( $res['banner_ids'] ) && is_array( $res['banner_ids'] ) ) {
				BlaulichtCMS_Bridge_Banners::reconcile( array_map( 'strval', $res['banner_ids'] ) );
			}
			BlaulichtCMS_Bridge_Settings::status(
				array(
					'last_success' => time(),
					'last_error'   => $ack_error,
					'last_jobs'    => $count,
				)
			);
			return $count;
		} finally {
			self::$token = null;
			self::release( $token );
		}
	}
}
