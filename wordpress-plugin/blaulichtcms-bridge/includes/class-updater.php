<?php
/**
 * Updates der Bridge über den normalen WordPress-Updateweg.
 *
 * - BlaulichtCMS bietet nur freigegebene Versionen an (Testwebsites erhalten neue Versionen zuerst).
 * - Das Paket wird vor der Installation gegen die von BlaulichtCMS gemeldete SHA-256-Prüfsumme geprüft und – sobald in der
 *   Bridge ein Signaturschlüssel hinterlegt ist – zusätzlich gegen die Ed25519-Signatur (BlaulichtCMS_Bridge_Signature, #107).
 * - Die Kopplung (Optionen in der Datenbank) bleibt beim Update unverändert erhalten.
 * - Multisite (#161): Das Angebot liegt je Website (Transient statt Site-Transient). Läuft das Update im Netzwerk-Admin
 *   und ist die Hauptsite nicht gekoppelt, übernimmt eine gekoppelte Website des Netzes Angebot und Prüfung. Ein Paket
 *   von BlaulichtCMS wird nie ungeprüft an WordPress zurückgegeben.
 * - Automatische Updates (#186): Die Bridge steht immer im Update-Verzeichnis von WordPress (mit oder ohne neue
 *   Version). Damit erscheint in der Plugin-Liste „Automatische Updates aktivieren“, und WordPress installiert freigegebene
 *   Versionen selbst – über denselben geprüften Download (Prüfsumme und Signatur). Ist WP-Cron abgeschaltet und ruft
 *   kein Host-Cron wp-cron.php auf, laufen die automatischen Updates von WordPress gar nicht; dann holt die
 *   Selbstauslösung der Bridge das automatische Update für die Bridge allein nach (höchstens alle 12 Stunden).
 * - Kopfzeile „Update URI“: WordPress fragt wordpress.org nie nach einem gleichnamigen Plugin.
 *
 * @package BlaulichtCMSBridge
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class BlaulichtCMS_Bridge_Updater {
	const SLUG      = 'blaulichtcms-bridge';
	const TRANSIENT = 'blaulichtcms_bridge_update';
	/** Pfad der Paketadresse von BlaulichtCMS (unabhängig vom Host). */
	const PACKAGE_PATH = '/api/v1/bridge/update/package';

	public static function boot(): void {
		add_filter( 'pre_set_site_transient_update_plugins', array( __CLASS__, 'inject' ) );
		add_filter( 'plugins_api', array( __CLASS__, 'info' ), 10, 3 );
		add_filter( 'upgrader_pre_download', array( __CLASS__, 'verified_download' ), 10, 4 );
		add_action( 'upgrader_process_complete', array( __CLASS__, 'clear' ), 10, 0 );
	}

	private static function plugin_file(): string {
		return plugin_basename( BLAULICHTCMS_BRIDGE_FILE );
	}

	/**
	 * $fn im Kontext einer gekoppelten Website ausführen: zuerst die aktuelle, auf Multisite sonst die erste gekoppelte
	 * Website des Netzes. Mit $package nur eine Website, deren BlaulichtCMS-Adresse zur Paketadresse passt.
	 *
	 * @return mixed Ergebnis von $fn oder null, wenn keine passende Website gekoppelt ist.
	 */
	private static function with_paired_site( callable $fn, string $package = '' ) {
		$matches = static function () use ( $package ): bool {
			if ( ! BlaulichtCMS_Bridge_Settings::is_paired() ) {
				return false;
			}
			return '' === $package || 0 === strpos( $package, BlaulichtCMS_Bridge_Client::base_url() . self::PACKAGE_PATH );
		};
		if ( $matches() ) {
			return $fn();
		}
		if ( ! is_multisite() ) {
			return null;
		}
		$current = get_current_blog_id();
		foreach ( get_sites( array( 'fields' => 'ids', 'number' => 0, 'deleted' => 0, 'archived' => 0, 'spam' => 0 ) ) as $blog_id ) {
			if ( (int) $blog_id === $current ) {
				continue;
			}
			switch_to_blog( (int) $blog_id );
			try {
				if ( $matches() ) {
					return $fn();
				}
			} finally {
				restore_current_blog();
			}
		}
		return null;
	}

	/** Angebot von BlaulichtCMS für die aktuelle Website (6 Stunden zwischengespeichert, bei Fehler kurz). */
	public static function offer( bool $force = false ): ?array {
		if ( ! BlaulichtCMS_Bridge_Settings::is_paired() ) {
			return null;
		}
		$cached = get_transient( self::TRANSIENT );
		if ( ! $force && is_array( $cached ) ) {
			return $cached['available'] ? $cached : null;
		}
		$r = BlaulichtCMS_Bridge_Client::update_info();
		if ( is_wp_error( $r ) ) {
			set_transient( self::TRANSIENT, array( 'available' => false ), 15 * MINUTE_IN_SECONDS );
			return null;
		}
		$offer = array(
			'available'    => ! empty( $r['available'] ),
			'version'      => (string) ( $r['version'] ?? '' ),
			'sha256'       => strtolower( (string) ( $r['sha256'] ?? '' ) ),
			'package'      => ! empty( $r['package_path'] ) && 0 === strpos( (string) $r['package_path'], self::PACKAGE_PATH . '?' )
				? BlaulichtCMS_Bridge_Client::base_url() . (string) $r['package_path']
				: (string) ( $r['package'] ?? '' ),
			'requires'     => (string) ( $r['requires'] ?? '' ),
			'requires_php' => (string) ( $r['requires_php'] ?? '' ),
			'tested'       => (string) ( $r['tested'] ?? '' ),
		);
		// Paket nur von der gekoppelten Instanz annehmen
		if ( $offer['available'] && 0 !== strpos( $offer['package'], BlaulichtCMS_Bridge_Client::base_url() . self::PACKAGE_PATH ) ) {
			$offer['available'] = false;
		}
		set_transient( self::TRANSIENT, $offer, 6 * HOUR_IN_SECONDS );
		return $offer['available'] ? $offer : null;
	}

	/** Angebot der aktuellen oder (Multisite) einer anderen gekoppelten Website. */
	private static function any_offer(): ?array {
		$offer = self::with_paired_site( static fn() => self::offer() );
		return is_array( $offer ) ? $offer : null;
	}

	public static function inject( $transient ) {
		if ( ! is_object( $transient ) ) {
			return $transient;
		}
		$offer = self::any_offer();
		if ( $offer && version_compare( $offer['version'], BLAULICHTCMS_BRIDGE_VERSION, '>' ) ) {
			$transient->response[ self::plugin_file() ] = (object) array(
				'id'           => self::plugin_file(),
				'slug'         => self::SLUG,
				'plugin'       => self::plugin_file(),
				'new_version'  => $offer['version'],
				'package'      => $offer['package'],
				'url'          => (string) strstr( $offer['package'], self::PACKAGE_PATH, true ),
				'requires'     => $offer['requires'],
				'requires_php' => $offer['requires_php'],
				'tested'       => $offer['tested'],
			);
			if ( isset( $transient->no_update ) && is_array( $transient->no_update ) ) {
				unset( $transient->no_update[ self::plugin_file() ] );
			}
		} else {
			if ( isset( $transient->response[ self::plugin_file() ] ) ) {
				unset( $transient->response[ self::plugin_file() ] );
			}
			// Ohne Eintrag zeigt WordPress für das Plugin keinen Schalter „Automatische Updates“ (#186)
			if ( ! isset( $transient->no_update ) || ! is_array( $transient->no_update ) ) {
				$transient->no_update = array();
			}
			$transient->no_update[ self::plugin_file() ] = (object) array(
				'id'          => self::plugin_file(),
				'slug'        => self::SLUG,
				'plugin'      => self::plugin_file(),
				'new_version' => BLAULICHTCMS_BRIDGE_VERSION,
				'url'         => '',
				'package'     => '',
			);
		}
		return $transient;
	}

	public static function info( $result, $action, $args ) {
		if ( 'plugin_information' !== $action || empty( $args->slug ) || self::SLUG !== $args->slug ) {
			return $result;
		}
		$offer = self::any_offer();
		return (object) array(
			'name'          => 'BlaulichtCMS Bridge',
			'slug'          => self::SLUG,
			'version'       => $offer['version'] ?? BLAULICHTCMS_BRIDGE_VERSION,
			'requires'      => $offer['requires'] ?? '',
			'requires_php'  => $offer['requires_php'] ?? '',
			'tested'        => $offer['tested'] ?? '',
			'download_link' => $offer['package'] ?? '',
			'sections'      => array( 'description' => 'Verbindet diese Website mit BlaulichtCMS. Updates werden von der gekoppelten BlaulichtCMS-Instanz freigegeben und vor der Installation per Prüfsumme und – sofern eingerichtet – per Signatur geprüft.' ),
		);
	}

	/**
	 * Eigenes Herunterladen mit Prüfsummenkontrolle. Stimmt die Prüfsumme nicht, bricht WordPress das Update ab.
	 *
	 * Geladen wird nicht die zwischengespeicherte Paketadresse (ihre Signatur gilt nur eine Stunde, das Angebot liegt
	 * bis zu 6 Stunden im Zwischenspeicher, die Adresse in WordPress bis zu 12 Stunden), sondern die eines frisch
	 * abgerufenen Angebots – mit dessen Prüfsumme (#122). Jede Paketadresse von BlaulichtCMS wird hier geprüft oder
	 * abgewiesen, nie ungeprüft an WordPress zurückgegeben (#161).
	 *
	 * @return false|string|WP_Error
	 */
	public static function verified_download( $reply, $package, $upgrader, $hook_extra = array() ) {
		if ( ! is_string( $package ) || false === strpos( $package, self::PACKAGE_PATH ) ) {
			return $reply;
		}
		$result = self::with_paired_site( static fn() => self::download_fresh(), $package );
		if ( null === $result ) {
			return new WP_Error( 'blaulichtcms_update', 'Das Update-Paket stammt von BlaulichtCMS, aber keine Website dieser Installation ist mit dieser BlaulichtCMS-Adresse gekoppelt. Das Update wurde nicht installiert.' );
		}
		return $result;
	}

	/**
	 * Frisches Angebot der aktuellen (gekoppelten) Website holen, Paket laden und prüfen.
	 *
	 * @return string|WP_Error Pfad zur geprüften ZIP-Datei.
	 */
	private static function download_fresh() {
		$offer = self::offer( true );
		if ( ! is_array( $offer ) || empty( $offer['sha256'] ) || empty( $offer['package'] ) ) {
			return new WP_Error( 'blaulichtcms_update', 'Kein gültiges Update-Angebot von BlaulichtCMS (BlaulichtCMS nicht erreichbar oder Version nicht mehr freigegeben).' );
		}
		if ( ! version_compare( $offer['version'], BLAULICHTCMS_BRIDGE_VERSION, '>' ) ) {
			return new WP_Error( 'blaulichtcms_update', 'BlaulichtCMS bietet keine neuere Version der Bridge an.' );
		}
		// Gleicher Weg wie die übrigen Abrufe der Bridge (download_url() lässt nur Standardports und öffentliche Hosts zu)
		$tmp = wp_tempnam( 'blaulichtcms-bridge.zip' );
		$res = wp_remote_get(
			$offer['package'],
			array(
				'timeout'  => 120,
				'stream'   => true,
				'filename' => $tmp,
			)
		);
		if ( is_wp_error( $res ) || 200 !== (int) wp_remote_retrieve_response_code( $res ) ) {
			wp_delete_file( $tmp );
			return new WP_Error( 'blaulichtcms_update_download', 'Update-Paket konnte nicht von BlaulichtCMS geladen werden: ' . ( is_wp_error( $res ) ? $res->get_error_message() : 'HTTP ' . wp_remote_retrieve_response_code( $res ) ) );
		}
		if ( ! hash_equals( $offer['sha256'], (string) hash_file( 'sha256', $tmp ) ) ) {
			wp_delete_file( $tmp );
			return new WP_Error( 'blaulichtcms_update_checksum', 'Das Update-Paket stimmt nicht mit der Prüfsumme von BlaulichtCMS überein und wurde verworfen.' );
		}
		return $tmp;
	}

	/** Sind automatische Updates für die Bridge eingeschaltet (Schalter in der Plugin-Liste oder Filter)? */
	public static function auto_update_enabled(): bool {
		if ( ! function_exists( 'wp_is_auto_update_enabled_for_type' ) ) {
			require_once ABSPATH . 'wp-admin/includes/update.php';
		}
		if ( ! wp_is_auto_update_enabled_for_type( 'plugin' ) ) {
			return false;
		}
		$on   = in_array( self::plugin_file(), (array) get_site_option( 'auto_update_plugins', array() ), true );
		$item = (object) array(
			'slug'   => self::SLUG,
			'plugin' => self::plugin_file(),
		);
		// Derselbe Filter wie bei WordPress selbst (Erzwingen oder Abschalten durch andere Plugins/Konfiguration)
		return (bool) apply_filters( 'auto_update_plugin', $on, $item ); // phpcs:ignore WordPress.NamingConventions.PrefixAllGlobals
	}

	/**
	 * Automatisches Update der Bridge nachholen, wenn WP-Cron abgeschaltet ist (aus der Selbstauslösung).
	 * Prüft wie WordPress selbst (WP_Automatic_Updater: Schalter, Filter, Dateirechte, Versionsverwaltung) und lädt über
	 * verified_download() – Prüfsumme und Signatur gelten unverändert.
	 */
	public static function maybe_auto_update(): void {
		$s = BlaulichtCMS_Bridge_Settings::all();
		if ( time() - (int) $s['last_auto_update'] < 12 * HOUR_IN_SECONDS || ! self::auto_update_enabled() ) {
			return;
		}
		BlaulichtCMS_Bridge_Settings::status( array( 'last_auto_update' => time() ) );
		$offer = self::offer();
		if ( ! $offer || ! version_compare( $offer['version'], BLAULICHTCMS_BRIDGE_VERSION, '>' ) ) {
			BlaulichtCMS_Bridge_Settings::status( array( 'auto_update_note' => '' ) );
			return;
		}
		require_once ABSPATH . 'wp-admin/includes/admin.php';
		require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';
		wp_update_plugins();
		$plugins = get_site_transient( 'update_plugins' );
		$item    = is_object( $plugins ) && isset( $plugins->response[ self::plugin_file() ] ) ? $plugins->response[ self::plugin_file() ] : null;
		if ( ! $item ) {
			return;
		}
		if ( ! WP_Upgrader::create_lock( 'auto_updater' ) ) {
			return; // WordPress aktualisiert gerade selbst
		}
		try {
			$updater = new WP_Automatic_Updater();
			if ( $updater->is_disabled() ) {
				BlaulichtCMS_Bridge_Settings::status( array( 'auto_update_note' => 'Automatische Updates sind in dieser WordPress-Installation abgeschaltet (AUTOMATIC_UPDATER_DISABLED).' ) );
				return;
			}
			$result = $updater->update( 'plugin', $item );
			$note   = null === $result
				? 'Automatisches Update nicht möglich (Dateirechte, Versionsverwaltung oder durch einen Filter abgeschaltet).'
				: ( is_wp_error( $result ) || false === $result ? 'Automatisches Update auf ' . $offer['version'] . ' fehlgeschlagen' . ( is_wp_error( $result ) ? ': ' . $result->get_error_message() : '.' ) : '' );
			BlaulichtCMS_Bridge_Settings::status( array( 'auto_update_note' => $note ) );
		} finally {
			WP_Upgrader::release_lock( 'auto_updater' );
		}
	}

	public static function clear(): void {
		delete_transient( self::TRANSIENT );
		delete_site_transient( self::TRANSIENT ); // Altbestand bis 0.5.x (netzwerkweit)
	}
}
