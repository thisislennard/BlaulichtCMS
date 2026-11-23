<?php
/**
 * Regelmäßiger Abruf über WP-Cron (jede Minute) oder Host-Cron (`wp blaulichtcms-bridge poll`).
 * Eine Sperre verhindert parallele Läufe; jeder Auftrag wird einzeln bestätigt.
 *
 * Selbstauslösung (#186): Ist WP-Cron abgeschaltet (DISABLE_WP_CRON) und ruft kein Host-Cron die Bridge auf, stößt die
 * Bridge den Abruf selbst an – am Ende eines beliebigen Seitenaufrufs mit einer kurzen, nicht blockierenden Anfrage an
 * die eigene Website (wie WordPress es für WP-Cron tut, aber nur für den Abruf der Bridge). Ein Host-Cron ist damit
 * nicht mehr nötig; er bleibt sinnvoll bei sehr wenig Besuchern oder einem Seitencache, der PHP ganz umgeht.
 *
 * @package BlaulichtCMSBridge
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class BlaulichtCMS_Bridge_Sync {
	const HOOK = 'blaulichtcms_bridge_poll';
	const LOCK = 'blaulichtcms_bridge_lock';
	/** Aktion der Selbstauslösung (admin-ajax.php, ohne Anmeldung, mit Prüfwert). */
	const TICK_ACTION = 'blaulichtcms_bridge_tick';
	/** Gilt der Abruf als ausgefallen, wenn er so lange nicht lief (Sekunden). */
	const STALE_SECONDS = 600;

	public static function boot(): void {
		add_filter( 'cron_schedules', array( __CLASS__, 'schedules' ) );
		add_action( self::HOOK, array( __CLASS__, 'cron' ) );
		add_action( 'wp_ajax_nopriv_' . self::TICK_ACTION, array( __CLASS__, 'tick' ) );
		add_action( 'wp_ajax_' . self::TICK_ACTION, array( __CLASS__, 'tick' ) );
		add_action( 'shutdown', array( __CLASS__, 'maybe_spawn' ) );
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

	/**
	 * Meldung an BlaulichtCMS (#186): Kategorien, Abrufweg, automatische Updates, Darstellung und Autorenweg. Nur bei
	 * Änderungen und sonst alle 6 Stunden. Ältere BlaulichtCMS-Versionen ohne diese Schnittstelle werden nicht bedrängt.
	 */
	public static function report_data(): array {
		$terms = get_terms(
			array(
				'taxonomy'   => 'category',
				'hide_empty' => false,
				'number'     => 1000,
				'orderby'    => 'name',
			)
		);
		$cats  = array();
		foreach ( is_array( $terms ) ? $terms : array() as $t ) {
			$cats[] = array(
				'id'     => (int) $t->term_id,
				'name'   => html_entity_decode( (string) $t->name, ENT_QUOTES, 'UTF-8' ),
				'parent' => (int) $t->parent,
			);
		}
		$s = BlaulichtCMS_Bridge_Settings::all();
		return array(
			'categories'  => $cats,
			'cron'        => array(
				'mode'             => self::mode(),
				'wp_cron_disabled' => self::wp_cron_disabled(),
				'healthy'          => self::healthy(),
				'hint'             => self::hint(),
			),
			'auto_update' => BlaulichtCMS_Bridge_Updater::auto_update_enabled(),
			'author_mode' => BlaulichtCMS_Bridge_Authors::mode(),
			'display'     => array(
				'info'    => BlaulichtCMS_Bridge_Settings::display_for_tone( 'info' ),
				'warning' => BlaulichtCMS_Bridge_Settings::display_for_tone( 'warning' ),
				'danger'  => BlaulichtCMS_Bridge_Settings::display_for_tone( 'danger' ),
			),
			'banner_auto' => false !== $s['banner_auto'] && '0' !== $s['banner_auto'],
		);
	}

	public static function maybe_report( bool $force = false ): void {
		$data = self::report_data();
		$hash = md5( (string) wp_json_encode( $data ) );
		$s    = BlaulichtCMS_Bridge_Settings::all();
		if ( ! $force && $hash === $s['report_hash'] && time() - (int) $s['last_report'] < 6 * HOUR_IN_SECONDS ) {
			return;
		}
		$r      = BlaulichtCMS_Bridge_Client::report( $data );
		$status = array(
			'report_hash' => $hash,
			'last_report' => time(),
		);
		if ( is_wp_error( $r ) ) {
			$code = (int) ( $r->get_error_data()['status'] ?? 0 );
			// Nicht erreichbar: beim nächsten Abruf erneut. Abgelehnt (z. B. 404 bei älteren BlaulichtCMS-Versionen ohne
			// diese Schnittstelle): erst nach einer Änderung oder nach 6 Stunden wieder
			if ( 0 === $code ) {
				$status['report_hash'] = '';
			}
		} else {
			$status['send_author'] = ! empty( $r['send_author'] );
		}
		BlaulichtCMS_Bridge_Settings::status( $status );
	}

	public static function deactivate(): void {
		wp_clear_scheduled_hook( self::HOOK );
		delete_option( self::LOCK );
		delete_transient( self::LOCK ); // Altbestand bis 0.4.0
	}

	public static function cron(): void {
		self::poll( false, 'wp-cron' );
	}

	public static function wp_cron_disabled(): bool {
		return defined( 'DISABLE_WP_CRON' ) && DISABLE_WP_CRON;
	}

	/** Prüfwert der Selbstauslösung – aus den Schlüsseln der wp-config.php abgeleitet, nicht gespeichert. */
	private static function tick_token(): string {
		return hash_hmac( 'sha256', 'blaulichtcms-bridge-tick|' . home_url( '/' ), wp_salt( 'nonce' ) );
	}

	/**
	 * Abrufweg für Anzeige und Meldung: wp-cron, host (WP-CLI oder wp-cron.php per Host-Cron), self (Selbstauslösung),
	 * manual (nur „Jetzt abrufen“) oder unknown (noch kein Abruf).
	 */
	public static function mode(): string {
		$t = (string) BlaulichtCMS_Bridge_Settings::get( 'last_trigger' );
		if ( 'cli' === $t || ( 'wp-cron' === $t && self::wp_cron_disabled() ) ) {
			return 'host';
		}
		return in_array( $t, array( 'wp-cron', 'self', 'manual' ), true ) ? $t : 'unknown';
	}

	/** Läuft der Abruf regelmäßig? */
	public static function healthy(): bool {
		$last = (int) BlaulichtCMS_Bridge_Settings::get( 'last_poll' );
		return $last > 0 && time() - $last < self::STALE_SECONDS;
	}

	/**
	 * Erreicht die Selbstauslösung WordPress nicht (Anfragen an die eigene Website blockiert)? Erkennbar daran, dass
	 * seit mehreren Auslösungen kein Abruf mehr lief.
	 */
	public static function self_trigger_failing(): bool {
		$s = BlaulichtCMS_Bridge_Settings::all();
		return (int) $s['tick_at'] > 0 && (int) $s['tick_at'] - (int) $s['last_poll'] > 180;
	}

	/** Hinweis zum Abrufweg (leer, wenn alles läuft). */
	public static function hint(): string {
		if ( ! BlaulichtCMS_Bridge_Settings::is_paired() ) {
			return '';
		}
		if ( self::wp_cron_disabled() && self::self_trigger_failing() ) {
			return 'WP-Cron ist abgeschaltet und die Selbstauslösung erreicht die eigene Website nicht (Anfragen an die eigene Adresse blockiert). Bitte den Hoster fragen oder einen Host-Cron einrichten.';
		}
		if ( ! self::healthy() && (int) BlaulichtCMS_Bridge_Settings::get( 'last_poll' ) > 0 ) {
			return 'Seit über 10 Minuten kein Abruf. Bei sehr wenig Besuchern oder einem Seitencache, der PHP umgeht, hilft ein Host-Cron.';
		}
		return '';
	}

	/**
	 * Am Ende eines Seitenaufrufs: Abruf selbst anstoßen, wenn er fällig ist und WP-Cron ihn nicht erledigt.
	 * Mit WP-Cron nur als Rückfall, wenn der Abruf seit 10 Minuten nicht lief.
	 */
	public static function maybe_spawn(): void {
		if ( wp_doing_cron() || ( defined( 'WP_CLI' ) && WP_CLI ) || ( defined( 'WP_INSTALLING' ) && WP_INSTALLING ) ) {
			return;
		}
		// phpcs:ignore WordPress.Security.NonceVerification.Missing -- nur Erkennung der eigenen Anfrage
		if ( wp_doing_ajax() && isset( $_REQUEST['action'] ) && self::TICK_ACTION === $_REQUEST['action'] ) {
			return;
		}
		if ( ! BlaulichtCMS_Bridge_Settings::is_paired() ) {
			return;
		}
		$s    = BlaulichtCMS_Bridge_Settings::all();
		$now  = time();
		$wait = max( 60, (int) $s['poll_interval'] );
		$age  = $now - (int) $s['last_poll'];
		$due  = self::wp_cron_disabled() ? $age >= $wait : $age >= self::STALE_SECONDS;
		// Höchstens eine Auslösung je Intervall (parallele Läufe verhindert zusätzlich die Abrufsperre)
		if ( ! $due || $now - (int) $s['tick_at'] < $wait ) {
			return;
		}
		BlaulichtCMS_Bridge_Settings::status( array( 'tick_at' => $now ) );
		wp_remote_post(
			admin_url( 'admin-ajax.php' ),
			array(
				'timeout'   => 0.01,
				'blocking'  => false,
				/** Wie spawn_cron(): eigenes Zertifikat lokal nicht prüfen (Filter des WordPress-Kerns). */
				'sslverify' => apply_filters( 'https_local_ssl_verify', false ), // phpcs:ignore WordPress.NamingConventions.PrefixAllGlobals
				'body'      => array(
					'action' => self::TICK_ACTION,
					'token'  => self::tick_token(),
				),
			)
		);
	}

	/** Selbstauslösung: Abruf ausführen (nur mit gültigem Prüfwert). */
	public static function tick(): void {
		// phpcs:ignore WordPress.Security.NonceVerification.Missing -- eigener Prüfwert statt Nonce (Anfrage ohne Anmeldung)
		$token = isset( $_POST['token'] ) ? sanitize_text_field( wp_unslash( $_POST['token'] ) ) : '';
		if ( '' === $token || ! hash_equals( self::tick_token(), $token ) ) {
			wp_die( '', '', array( 'response' => 403 ) );
		}
		ignore_user_abort( true );
		if ( function_exists( 'set_time_limit' ) ) {
			@set_time_limit( 300 ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
		}
		self::poll( false, 'self' );
		// Ohne WP-Cron laufen auch die automatischen Updates von WordPress nicht – für die Bridge selbst nachholen
		if ( self::wp_cron_disabled() ) {
			BlaulichtCMS_Bridge_Updater::maybe_auto_update();
		}
		wp_die( '', '', array( 'response' => 200 ) );
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
	 * @param bool   $force   Manueller Abruf („Jetzt abrufen“, WP-CLI). Läuft gerade ein Abruf, wird nicht parallel
	 *                        gestartet, sondern ein Hinweis zurückgegeben.
	 * @param string $trigger Abrufweg: wp-cron, self, cli oder manual (Anzeige und Meldung an BlaulichtCMS).
	 * @return int|WP_Error Anzahl verarbeiteter Aufträge.
	 */
	public static function poll( bool $force, string $trigger = 'manual' ) {
		if ( ! BlaulichtCMS_Bridge_Settings::is_paired() ) {
			return new WP_Error( 'blaulichtcms_not_paired', 'Die Website ist nicht mit BlaulichtCMS gekoppelt.' );
		}
		$token = self::acquire();
		if ( null === $token ) {
			return $force ? new WP_Error( 'blaulichtcms_busy', 'Es läuft gerade ein Abruf. Bitte in einer Minute erneut versuchen.' ) : 0;
		}
		self::$token = $token;
		$started     = time();
		$status      = array( 'last_poll' => $started );
		// Der manuelle Abruf überschreibt den regelmäßigen Abrufweg nicht (sonst stünde dort nach einem Klick „manuell“)
		if ( 'manual' !== $trigger || '' === (string) BlaulichtCMS_Bridge_Settings::get( 'last_trigger' ) ) {
			$status['last_trigger'] = $trigger;
		}
		BlaulichtCMS_Bridge_Settings::status( $status );
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
					BlaulichtCMS_Bridge_Social::clear();
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
					} elseif ( 'incident.upsert' === $type ) {
						$out = BlaulichtCMS_Bridge_Incidents::upsert( $job );
					} elseif ( 'incident.delete' === $type ) {
						$out = BlaulichtCMS_Bridge_Incidents::delete( $job );
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
			// Social-Feed (ab 0.10.0): nur abholen, wenn sich der Stand geändert hat; ein Fehler hält den Abruf nicht auf
			if ( isset( $res['social_feed'] ) && is_string( $res['social_feed'] ) && time() - $started < self::MAX_RUN_SECONDS ) {
				try {
					$social = BlaulichtCMS_Bridge_Social::sync( $res['social_feed'] );
					if ( is_wp_error( $social ) && '' === $ack_error ) {
						$ack_error = 'Social-Feed: ' . $social->get_error_message();
					}
				} catch ( \Throwable $e ) {
					$ack_error = 'Social-Feed: ' . substr( $e->getMessage(), 0, 300 );
				}
			}
			BlaulichtCMS_Bridge_Settings::status(
				array(
					'last_success' => time(),
					'last_error'   => $ack_error,
					'last_jobs'    => $count,
				)
			);
			self::maybe_report();
			return $count;
		} finally {
			self::$token = null;
			self::release( $token );
		}
	}
}
