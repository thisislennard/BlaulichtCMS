<?php
/**
 * Zeitsteuerung: Einzelereignisse zu Start/Ende, 5-Minuten-Abgleich, tägliche Bereinigung.
 *
 * @package LifeLink
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * WP-Cron-Integration.
 */
final class LifeLink_Cron {

	public const RECONCILE_HOOK     = 'lifelink_reconcile';
	public const PURGE_HOOK         = 'lifelink_daily_purge';
	public const TRANSITION_HOOK    = 'lifelink_banner_transition';
	public const SCHEDULE           = 'lifelink_five_minutes';
	public const FINGERPRINT_OPTION = 'lifelink_active_fingerprint';

	/**
	 * Konstruktor.
	 *
	 * @param LifeLink_Banner_Repository $repository Banner-Repository.
	 * @param LifeLink_Cache_Purger      $purger     Cache-Purger.
	 * @param LifeLink_Audit_Log         $audit      Audit-Log.
	 */
	public function __construct(
		private LifeLink_Banner_Repository $repository,
		private LifeLink_Cache_Purger $purger,
		private LifeLink_Audit_Log $audit
	) {}

	/**
	 * Registriert Hooks.
	 */
	public function register(): void {
		add_filter( 'cron_schedules', array( self::class, 'add_schedule' ) ); // phpcs:ignore WordPress.WP.CronInterval.CronSchedulesInterval
		add_action( self::RECONCILE_HOOK, array( $this, 'reconcile' ) );
		add_action( self::PURGE_HOOK, array( $this, 'daily_purge' ) );
		add_action( self::TRANSITION_HOOK, array( $this, 'handle_transition' ), 10, 2 );
		add_action( 'init', array( self::class, 'ensure_scheduled' ) );
	}

	/**
	 * Fügt das 5-Minuten-Intervall hinzu.
	 *
	 * @param array $schedules Intervalle.
	 * @return array
	 */
	public static function add_schedule( $schedules ) {
		if ( ! is_array( $schedules ) ) {
			$schedules = array();
		}
		$schedules[ self::SCHEDULE ] = array(
			'interval' => 5 * MINUTE_IN_SECONDS,
			'display'  => __( 'Alle 5 Minuten (LifeLink)', 'lifelink' ),
		);
		return $schedules;
	}

	/**
	 * Stellt sicher, dass die wiederkehrenden Ereignisse geplant sind.
	 */
	public static function ensure_scheduled(): void {
		if ( ! wp_next_scheduled( self::RECONCILE_HOOK ) ) {
			wp_schedule_event( time() + MINUTE_IN_SECONDS, self::SCHEDULE, self::RECONCILE_HOOK );
		}
		if ( ! wp_next_scheduled( self::PURGE_HOOK ) ) {
			wp_schedule_event( time() + HOUR_IN_SECONDS, 'daily', self::PURGE_HOOK );
		}
	}

	/**
	 * Entfernt alle Ereignisse des Plugins (aktuelle Site).
	 */
	public static function unschedule_all(): void {
		wp_clear_scheduled_hook( self::RECONCILE_HOOK );
		wp_clear_scheduled_hook( self::PURGE_HOOK );
		wp_unschedule_hook( self::TRANSITION_HOOK );
	}

	/**
	 * Plant die Einzelereignisse zu Start und Ende eines Banners neu.
	 *
	 * @param array $row Datenbankzeile.
	 */
	public function schedule_transitions( array $row ): void {
		$id = (string) $row['external_id'];
		$this->clear_transitions( $id );

		if ( 'deaktiviert' === LifeLink_Banner_Repository::state( $row ) ) {
			return;
		}

		$now    = time();
		$starts = LifeLink_Banner_Repository::ts( $row['starts_at'] ?? null );
		$ends   = LifeLink_Banner_Repository::ts( $row['ends_at'] ?? null );

		if ( null !== $starts && $starts > $now ) {
			wp_schedule_single_event( $starts, self::TRANSITION_HOOK, array( $id, 'start' ) );
		}
		if ( null !== $ends && $ends > $now ) {
			wp_schedule_single_event( $ends + 1, self::TRANSITION_HOOK, array( $id, 'end' ) );
		}
	}

	/**
	 * Entfernt geplante Start-/Endereignisse eines Banners.
	 *
	 * @param string $external_id UUID.
	 */
	public function clear_transitions( string $external_id ): void {
		wp_clear_scheduled_hook( self::TRANSITION_HOOK, array( $external_id, 'start' ) );
		wp_clear_scheduled_hook( self::TRANSITION_HOOK, array( $external_id, 'end' ) );
	}

	/**
	 * Start- oder Endzeitpunkt erreicht: Caches leeren.
	 *
	 * @param mixed $external_id UUID.
	 * @param mixed $which       "start" oder "end".
	 */
	public function handle_transition( $external_id = '', $which = '' ): void {
		$external_id = is_string( $external_id ) ? $external_id : '';
		$row         = '' !== $external_id ? $this->repository->find( $external_id ) : null;
		$pages       = null !== $row ? LifeLink_Banner_Repository::pages( $row ) : array();

		$this->purger->purge( $pages );
		update_option( self::FINGERPRINT_OPTION, $this->repository->active_fingerprint(), false );

		if ( null !== $row ) {
			$action = 'end' === $which ? 'banner.end' : 'banner.start';
			$this->audit->add( 'system', $action, $external_id, LifeLink_Banner_Repository::state( $row ) );
		}
	}

	/**
	 * 5-Minuten-Abgleich: leert Caches, wenn sich die Menge aktiver Banner geändert hat
	 * (z. B. weil ein Einzelereignis verpasst wurde).
	 */
	public function reconcile(): void {
		$fingerprint = $this->repository->active_fingerprint();
		if ( get_option( self::FINGERPRINT_OPTION ) !== $fingerprint ) {
			$this->purger->purge( array( 'all' ) );
			update_option( self::FINGERPRINT_OPTION, $fingerprint, false );
		}
	}

	/**
	 * Merkt sich den aktuellen Fingerabdruck (nach eigenen Änderungen).
	 */
	public function remember_fingerprint(): void {
		update_option( self::FINGERPRINT_OPTION, $this->repository->active_fingerprint(), false );
	}

	/**
	 * Tägliche Bereinigung: alte Banner und abgelaufene Nonces.
	 */
	public function daily_purge(): void {
		$deleted = $this->repository->purge_old();
		if ( $deleted > 0 ) {
			$this->audit->add( 'system', 'banner.purge', (string) $deleted, 'ok' );
		}
		self::delete_expired_nonces();
	}

	/**
	 * Löscht abgelaufene Nonce-Einträge aus der Optionstabelle.
	 */
	public static function delete_expired_nonces(): void {
		global $wpdb;
		$prefix = '_transient_' . LifeLink_Auth::NONCE_PREFIX;
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
		$wpdb->query(
			$wpdb->prepare(
				"DELETE a, b FROM {$wpdb->options} a, {$wpdb->options} b
				WHERE a.option_name LIKE %s
				AND b.option_name = CONCAT( '_transient_timeout_', SUBSTRING( a.option_name, 12 ) )
				AND b.option_value < %d",
				$wpdb->esc_like( $prefix ) . '%',
				time()
			)
		);
	}
}
