<?php
/**
 * Regelmäßiger Abruf über WP-Cron (jede Minute) oder Host-Cron (`wp lifelink-bridge poll`).
 * Eine Sperre verhindert parallele Läufe; jeder Auftrag wird einzeln bestätigt.
 *
 * @package LifeLinkBridge
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class LifeLink_Bridge_Sync {
	const HOOK = 'lifelink_bridge_poll';
	const LOCK = 'lifelink_bridge_lock';

	public static function boot(): void {
		add_filter( 'cron_schedules', array( __CLASS__, 'schedules' ) );
		add_action( self::HOOK, array( __CLASS__, 'cron' ) );
		// Falls das Ereignis verloren ging (z. B. nach Migration), neu einplanen.
		add_action(
			'init',
			static function () {
				if ( LifeLink_Bridge_Settings::is_paired() && ! wp_next_scheduled( self::HOOK ) ) {
					wp_schedule_event( time() + 30, 'lifelink_minute', self::HOOK );
				}
			}
		);
	}

	public static function schedules( array $s ): array {
		$s['lifelink_minute'] = array(
			'interval' => 60,
			'display'  => 'LifeLink: jede Minute',
		);
		return $s;
	}

	public static function activate(): void {
		if ( ! wp_next_scheduled( self::HOOK ) ) {
			wp_schedule_event( time() + 30, 'lifelink_minute', self::HOOK );
		}
	}

	public static function deactivate(): void {
		wp_clear_scheduled_hook( self::HOOK );
		delete_transient( self::LOCK );
	}

	public static function cron(): void {
		self::poll( false );
	}

	/**
	 * Aufträge abholen und verarbeiten.
	 *
	 * @return int|WP_Error Anzahl verarbeiteter Aufträge.
	 */
	public static function poll( bool $force ) {
		if ( ! LifeLink_Bridge_Settings::is_paired() ) {
			return new WP_Error( 'lifelink_not_paired', 'Die Website ist nicht mit LifeLink gekoppelt.' );
		}
		if ( get_transient( self::LOCK ) && ! $force ) {
			return 0;
		}
		set_transient( self::LOCK, 1, 5 * MINUTE_IN_SECONDS );
		LifeLink_Bridge_Settings::update( array( 'last_poll' => time() ) );
		try {
			$res = LifeLink_Bridge_Client::jobs();
			if ( is_wp_error( $res ) ) {
				LifeLink_Bridge_Settings::update( array( 'last_error' => $res->get_error_message() ) );
				return $res;
			}
			$count     = 0;
			$ack_error = '';
			foreach ( (array) ( $res['jobs'] ?? array() ) as $job ) {
				$id = (string) ( $job['id'] ?? '' );
				if ( '' === $id ) {
					continue;
				}
				$out = 'post.unpublish' === ( $job['type'] ?? '' ) ? LifeLink_Bridge_Publisher::unpublish( $job ) : LifeLink_Bridge_Publisher::upsert( $job );
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
				// Schlägt die Rückmeldung fehl, liefert LifeLink den Auftrag erneut aus – derselbe Beitrag wird dann aktualisiert.
				$ack = LifeLink_Bridge_Client::result( $id, $report );
				if ( is_wp_error( $ack ) ) {
					$ack_error = 'Rückmeldung fehlgeschlagen: ' . $ack->get_error_message();
				}
				++$count;
			}
			LifeLink_Bridge_Settings::update(
				array(
					'last_success' => time(),
					'last_error'   => $ack_error,
					'last_jobs'    => $count,
				)
			);
			return $count;
		} finally {
			delete_transient( self::LOCK );
		}
	}
}
