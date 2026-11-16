<?php
/**
 * Hinweis-Banner und Einsatzübersicht.
 *
 * Banner liegen lokal in WordPress (Option). Start und Ablauf werden bei jeder Ausgabe geprüft –
 * auch ohne Verbindung zu BlaulichtCMS. Für zwischengespeicherte Seiten (Seitencache) blendet ein kleines
 * Skript abgelaufene Banner im Browser aus; bei Änderungen und zu Start-/Endzeitpunkten wird der Cache geleert.
 *
 * Platzierung: automatisch am Seitenanfang (abschaltbar), Shortcode [blaulichtcms_banner], Block „BlaulichtCMS: Hinweise“.
 * Einsatzübersicht: Shortcode [blaulichtcms_einsaetze anzahl="10"], Block „BlaulichtCMS: Einsatzübersicht“.
 *
 * Schweregrade (#186): Die Art aus BlaulichtCMS (Hinweis, Warnung, Gefahr) ist der Schweregrad. Je Schweregrad legen die
 * Bridge-Einstellungen Farbe und Darstellung fest: Banner (Seitenanfang/Shortcode/Block), Popup beim Aufruf der Seite
 * oder beides. Ein einzelner Hinweis kann in BlaulichtCMS eine feste Darstellung haben; „auto“ folgt der Einstellung hier.
 * Das Popup ist ein modaler <dialog> (Fokus bleibt im Dialog, Esc und „Schließen“ beenden ihn); geschlossene Popups
 * merkt sich der Browser je Hinweis und Fassung (localStorage) und zeigt sie nicht erneut.
 *
 * @package BlaulichtCMSBridge
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class BlaulichtCMS_Bridge_Banners {
	const OPTION    = 'blaulichtcms_bridge_banners';
	const CRON_HOOK = 'blaulichtcms_bridge_banner_edge';

	public static function boot(): void {
		add_shortcode( 'blaulichtcms_banner', array( __CLASS__, 'shortcode_banner' ) );
		add_shortcode( 'blaulichtcms_einsaetze', array( __CLASS__, 'shortcode_incidents' ) );
		add_action( 'wp_body_open', array( __CLASS__, 'auto_output' ) );
		add_action( 'wp_footer', array( __CLASS__, 'popup_output' ) );
		add_action( 'wp_enqueue_scripts', array( __CLASS__, 'assets' ) );
		add_action( 'init', array( __CLASS__, 'blocks' ) );
		add_action( self::CRON_HOOK, array( __CLASS__, 'purge_cache' ) );
	}

	/** Alle lokal gespeicherten Banner. */
	public static function all(): array {
		$v = get_option( self::OPTION, array() );
		return is_array( $v ) ? $v : array();
	}

	private static function save( array $banners ): void {
		update_option( self::OPTION, $banners, true );
		self::schedule_edges( $banners );
		self::purge_cache();
	}

	private static function sanitize( array $b ): array {
		return array(
			'id'        => sanitize_text_field( (string) ( $b['id'] ?? '' ) ),
			'revision'  => (int) ( $b['revision'] ?? 0 ),
			'title'     => sanitize_text_field( (string) ( $b['title'] ?? '' ) ),
			'text'      => sanitize_textarea_field( (string) ( $b['text'] ?? '' ) ),
			'tone'      => in_array( $b['tone'] ?? '', array( 'info', 'warning', 'danger' ), true ) ? $b['tone'] : 'info',
			'priority'  => max( 1, min( 3, (int) ( $b['priority'] ?? 2 ) ) ),
			'starts_at' => (int) strtotime( (string) ( $b['starts_at'] ?? 'now' ) ),
			'ends_at'   => (int) strtotime( (string) ( $b['ends_at'] ?? 'now' ) ),
			'link_url'  => esc_url_raw( (string) ( $b['link_url'] ?? '' ) ),
			'link_text' => sanitize_text_field( (string) ( $b['link_text'] ?? '' ) ),
			'display'   => in_array( $b['display'] ?? '', array( 'banner', 'popup', 'both' ), true ) ? $b['display'] : 'auto',
		);
	}

	/** Darstellung eines Hinweises: feste Vorgabe aus BlaulichtCMS oder die Einstellung zum Schweregrad. */
	public static function display_of( array $b ): string {
		$d = (string) ( $b['display'] ?? 'auto' );
		return in_array( $d, array( 'banner', 'popup', 'both' ), true ) ? $d : BlaulichtCMS_Bridge_Settings::display_for_tone( (string) $b['tone'] );
	}

	/** Bezeichnung des Schweregrads. */
	private static function label( string $tone ): string {
		return BlaulichtCMS_Bridge_Settings::TONES[ $tone ]['label'] ?? 'Hinweis';
	}

	/** Kleines Symbol je Schweregrad (dekorativ, der Text nennt den Schweregrad). */
	public static function icon( string $tone ): string {
		$path = 'info' === $tone
			? '<circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 11v6M12 7.5v.5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>'
			: '<path d="M12 3 2 21h20L12 3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 10v5M12 18v.5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>';
		return '<svg class="bcb-icon" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">' . $path . '</svg>';
	}

	public static function upsert( array $payload ): void {
		$b = self::sanitize( $payload );
		if ( '' === $b['id'] ) {
			return;
		}
		$all             = self::all();
		$all[ $b['id'] ] = $b;
		self::save( $all );
	}

	public static function delete( string $id ): void {
		$all = self::all();
		if ( isset( $all[ $id ] ) ) {
			unset( $all[ $id ] );
			self::save( $all );
		}
	}

	/**
	 * Alle lokal gespeicherten Banner entfernen (#156): beim Entkoppeln und wenn BlaulichtCMS den Schlüssel ablehnt. Ohne
	 * Kopplung erreichen die Website weder Beenden noch Entwarnung – ein Gefahrenhinweis bliebe sonst bis zu seinem
	 * Ende sichtbar.
	 */
	public static function clear(): void {
		$had = (bool) self::all();
		delete_option( self::OPTION );
		wp_clear_scheduled_hook( self::CRON_HOOK );
		if ( $had ) {
			self::purge_cache();
		}
	}

	/** Abgleich mit der Liste aktiver Banner aus BlaulichtCMS; Abgelaufenes wird zusätzlich lokal entfernt. */
	public static function reconcile( array $active_ids ): void {
		$all     = self::all();
		$changed = false;
		foreach ( array_keys( $all ) as $id ) {
			if ( ! in_array( $id, $active_ids, true ) || $all[ $id ]['ends_at'] < time() - DAY_IN_SECONDS ) {
				unset( $all[ $id ] );
				$changed = true;
			}
		}
		if ( $changed ) {
			self::save( $all );
		}
	}

	/** Aktive Banner (sortiert: Priorität, dann Schwere – Gefahr vor Warnung vor Hinweis –, dann neuester Start). Mit $upcoming auch solche, die in 24 h beginnen. */
	public static function active( bool $upcoming = false ): array {
		$now = time();
		$out = array_filter(
			self::all(),
			static fn( $b ) => $b['ends_at'] > $now && ( $b['starts_at'] <= $now || ( $upcoming && $b['starts_at'] <= $now + DAY_IN_SECONDS ) )
		);
		$rank = array(
			'danger'  => 3,
			'warning' => 2,
			'info'    => 1,
		);
		usort( $out, static fn( $a, $b ) => array( $b['priority'], $rank[ $b['tone'] ] ?? 0, $b['starts_at'] ) <=> array( $a['priority'], $rank[ $a['tone'] ] ?? 0, $a['starts_at'] ) );
		return $out;
	}

	/** Banner-Ausgabe (Seitenanfang, Shortcode, Block). Hinweise mit der Darstellung „nur Popup“ erscheinen hier nicht. */
	public static function render(): string {
		$list = array_filter( self::active( true ), static fn( $b ) => 'popup' !== self::display_of( $b ) );
		if ( ! $list ) {
			return '';
		}
		$html = '<div class="bcb-banners" data-bcb-banners>';
		$now  = time();
		foreach ( $list as $b ) {
			$html .= self::banner_html( $b, $b['starts_at'] > $now );
		}
		$html .= '</div>';
		return $html;
	}

	/** Ein Banner. Mit $preview (Einstellungsseite) ohne Live-Region und ohne Zeitsteuerung. */
	public static function banner_html( array $b, bool $hidden = false, bool $preview = false ): string {
		return sprintf(
			'<div class="bcb-banner bcb-%1$s"%2$s%3$s%4$s%5$s>%6$s<span class="bcb-label">%7$s</span><div class="bcb-body"><strong class="bcb-title">%8$s</strong>%9$s%10$s</div></div>',
			esc_attr( $b['tone'] ),
			$preview ? '' : ' role="' . ( 'danger' === $b['tone'] ? 'alert' : 'status' ) . '"',
			$preview ? '' : ' data-bcb-start="' . (int) $b['starts_at'] . '"',
			$preview ? '' : ' data-bcb-end="' . (int) $b['ends_at'] . '"',
			$hidden ? ' hidden' : '',
			self::icon( $b['tone'] ),
			esc_html( self::label( $b['tone'] ) ),
			esc_html( $b['title'] ),
			'' !== $b['text'] ? '<span class="bcb-text">' . esc_html( $b['text'] ) . '</span>' : '',
			'' !== $b['link_url'] ? ' <a class="bcb-link" href="' . esc_url( $b['link_url'] ) . '">' . esc_html( '' !== $b['link_text'] ? $b['link_text'] : 'Mehr erfahren' ) . '</a>' : ''
		);
	}

	/**
	 * Popups (Darstellung „Popup“ oder „Banner und Popup“) als modale Dialoge am Seitenende. Sichtbar macht sie erst das
	 * Skript – nur, solange der Hinweis gilt und die Person ihn in diesem Browser noch nicht geschlossen hat.
	 */
	public static function popup_html(): string {
		$html = '';
		foreach ( self::active( true ) as $b ) {
			if ( 'banner' === self::display_of( $b ) ) {
				continue;
			}
			$uid   = 'bcb-pop-' . substr( md5( $b['id'] ), 0, 10 );
			$html .= sprintf(
				'<dialog class="bcb-popup bcb-%1$s" aria-labelledby="%2$s-t"%3$s data-bcb-popup data-bcb-key="%4$s" data-bcb-pstart="%5$d" data-bcb-pend="%6$d"><div class="bcb-popup-head">%7$s<span class="bcb-label">%8$s</span><button type="button" class="bcb-popup-x" data-bcb-close aria-label="Hinweis schließen">&times;</button></div><h2 class="bcb-popup-title" id="%2$s-t">%9$s</h2>%10$s<div class="bcb-popup-actions">%11$s<button type="button" class="bcb-popup-ok" data-bcb-close autofocus>Verstanden</button></div></dialog>',
				esc_attr( $b['tone'] ),
				esc_attr( $uid ),
				'' !== $b['text'] ? ' aria-describedby="' . esc_attr( $uid ) . '-d"' : '',
				esc_attr( $b['id'] . ':' . (int) $b['revision'] ),
				(int) $b['starts_at'],
				(int) $b['ends_at'],
				self::icon( $b['tone'] ),
				esc_html( self::label( $b['tone'] ) ),
				esc_html( $b['title'] ),
				'' !== $b['text'] ? '<p class="bcb-popup-text" id="' . esc_attr( $uid ) . '-d">' . nl2br( esc_html( $b['text'] ) ) . '</p>' : '',
				'' !== $b['link_url'] ? '<a class="bcb-link" href="' . esc_url( $b['link_url'] ) . '">' . esc_html( '' !== $b['link_text'] ? $b['link_text'] : 'Mehr erfahren' ) . '</a>' : ''
			);
		}
		return $html;
	}

	public static function popup_output(): void {
		echo self::popup_html(); // phpcs:ignore WordPress.Security.EscapeOutput -- in popup_html() escaped
	}

	/** Farben je Schweregrad als CSS-Variablen (Einstellungen → BlaulichtCMS Bridge → Darstellung der Hinweise). */
	public static function inline_css(): string {
		$css = '';
		foreach ( array_keys( BlaulichtCMS_Bridge_Settings::TONES ) as $tone ) {
			$c    = BlaulichtCMS_Bridge_Settings::color_for_tone( $tone );
			$css .= sprintf( '.bcb-%1$s{--bcb-accent:%2$s;--bcb-on-accent:%3$s}', $tone, $c, self::on_color( $c ) );
		}
		return $css;
	}

	/** Schriftfarbe auf der Akzentfarbe: Weiß, wenn der Kontrast mindestens 4,5:1 erreicht, sonst fast Schwarz. */
	public static function on_color( string $hex ): string {
		return self::contrast( $hex, '#ffffff' ) >= 4.5 ? '#ffffff' : '#111111';
	}

	/** Kontrastverhältnis nach WCAG 2.x. */
	public static function contrast( string $a, string $b ): float {
		$l1 = self::luminance( $a );
		$l2 = self::luminance( $b );
		return ( max( $l1, $l2 ) + 0.05 ) / ( min( $l1, $l2 ) + 0.05 );
	}

	private static function luminance( string $hex ): float {
		$hex = ltrim( $hex, '#' );
		if ( 3 === strlen( $hex ) ) {
			$hex = $hex[0] . $hex[0] . $hex[1] . $hex[1] . $hex[2] . $hex[2];
		}
		$rgb = array_map( static fn( $p ) => hexdec( $p ) / 255, str_split( str_pad( substr( $hex, 0, 6 ), 6, '0' ), 2 ) );
		$lin = array_map( static fn( $v ) => $v <= 0.03928 ? $v / 12.92 : ( ( $v + 0.055 ) / 1.055 ) ** 2.4, $rgb );
		return 0.2126 * $lin[0] + 0.7152 * $lin[1] + 0.0722 * $lin[2];
	}

	public static function auto_output(): void {
		$auto = BlaulichtCMS_Bridge_Settings::get( 'banner_auto' );
		if ( false === $auto || '0' === $auto ) {
			return;
		}
		echo self::render(); // phpcs:ignore WordPress.Security.EscapeOutput -- in render() escaped
	}

	public static function shortcode_banner(): string {
		return self::render();
	}

	public static function shortcode_incidents( $atts = array() ): string {
		$atts  = shortcode_atts( array( 'anzahl' => 10 ), $atts, 'blaulichtcms_einsaetze' );
		$posts = get_posts(
			array(
				'post_type'      => 'post',
				'post_status'    => 'publish',
				'posts_per_page' => max( 1, min( 50, (int) $atts['anzahl'] ) ),
				'meta_key'       => '_blaulichtcms_kind', // phpcs:ignore WordPress.DB.SlowDBQuery
				'meta_value'     => 'incident',      // phpcs:ignore WordPress.DB.SlowDBQuery
			)
		);
		if ( ! $posts ) {
			return '<p class="bcb-incidents-empty">Aktuell keine Einsatzberichte.</p>';
		}
		$html = '<ul class="bcb-incidents">';
		foreach ( $posts as $p ) {
			$html .= sprintf( '<li><time datetime="%s">%s</time> <a href="%s">%s</a></li>', esc_attr( get_the_date( 'c', $p ) ), esc_html( get_the_date( 'd.m.Y', $p ) ), esc_url( get_permalink( $p ) ), esc_html( get_the_title( $p ) ) );
		}
		return $html . '</ul>';
	}

	public static function assets(): void {
		wp_enqueue_style( 'blaulichtcms-bridge-banner', plugins_url( 'assets/banner.css', BLAULICHTCMS_BRIDGE_FILE ), array(), BLAULICHTCMS_BRIDGE_VERSION );
		wp_add_inline_style( 'blaulichtcms-bridge-banner', self::inline_css() );
		wp_enqueue_script( 'blaulichtcms-bridge-banner', plugins_url( 'assets/banner.js', BLAULICHTCMS_BRIDGE_FILE ), array(), BLAULICHTCMS_BRIDGE_VERSION, array( 'strategy' => 'defer', 'in_footer' => true ) );
	}

	public static function blocks(): void {
		wp_register_script( 'blaulichtcms-bridge-blocks', plugins_url( 'assets/blocks.js', BLAULICHTCMS_BRIDGE_FILE ), array( 'wp-blocks', 'wp-element', 'wp-server-side-render', 'wp-block-editor' ), BLAULICHTCMS_BRIDGE_VERSION, true );
		register_block_type(
			'blaulichtcms/banner',
			array(
				'api_version'     => 3,
				'title'           => 'BlaulichtCMS: Hinweise',
				'category'        => 'widgets',
				'editor_script'   => 'blaulichtcms-bridge-blocks',
				'render_callback' => array( __CLASS__, 'render' ),
			)
		);
		register_block_type(
			'blaulichtcms/incidents',
			array(
				'api_version'     => 3,
				'title'           => 'BlaulichtCMS: Einsatzübersicht',
				'category'        => 'widgets',
				'editor_script'   => 'blaulichtcms-bridge-blocks',
				'attributes'      => array( 'anzahl' => array( 'type' => 'number', 'default' => 10 ) ),
				'render_callback' => static fn( $a ) => self::shortcode_incidents( array( 'anzahl' => $a['anzahl'] ?? 10 ) ),
			)
		);
	}

	/** Zu jedem Start- und Endzeitpunkt den Seitencache leeren. */
	private static function schedule_edges( array $banners ): void {
		wp_clear_scheduled_hook( self::CRON_HOOK );
		$now = time();
		foreach ( $banners as $b ) {
			foreach ( array( $b['starts_at'], $b['ends_at'] ) as $t ) {
				if ( $t > $now ) {
					wp_schedule_single_event( $t + 1, self::CRON_HOOK, array( 'at' => $t ) );
				}
			}
		}
	}

	/** Gängige Seitencaches leeren (sofern installiert). */
	public static function purge_cache(): void {
		if ( function_exists( 'wp_cache_clear_cache' ) ) {
			wp_cache_clear_cache(); // WP Super Cache.
		}
		if ( function_exists( 'w3tc_flush_all' ) ) {
			w3tc_flush_all();
		}
		if ( function_exists( 'rocket_clean_domain' ) ) {
			rocket_clean_domain();
		}
		do_action( 'litespeed_purge_all' );
		do_action( 'blaulichtcms_bridge_purge_cache' );
		// Den gesamten Objekt-Cache (Redis/Memcached) nur auf ausdrücklichen Wunsch leeren – bei jeder Banneränderung
		// erzeugte das während einer Lage unnötige Last (#89).
		if ( apply_filters( 'blaulichtcms_bridge_flush_object_cache', false ) ) {
			wp_cache_flush();
		}
	}
}
