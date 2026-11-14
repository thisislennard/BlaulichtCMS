<?php
/**
 * Hinweis-Banner und Einsatzübersicht.
 *
 * Banner liegen lokal in WordPress (Option). Start und Ablauf werden bei jeder Ausgabe geprüft –
 * auch ohne Verbindung zu LifeLink. Für zwischengespeicherte Seiten (Seitencache) blendet ein kleines
 * Skript abgelaufene Banner im Browser aus; bei Änderungen und zu Start-/Endzeitpunkten wird der Cache geleert.
 *
 * Platzierung: automatisch am Seitenanfang (abschaltbar), Shortcode [lifelink_banner], Block „LifeLink: Hinweise“.
 * Einsatzübersicht: Shortcode [lifelink_einsaetze anzahl="10"], Block „LifeLink: Einsatzübersicht“.
 *
 * @package LifeLinkBridge
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class LifeLink_Bridge_Banners {
	const OPTION    = 'lifelink_bridge_banners';
	const CRON_HOOK = 'lifelink_bridge_banner_edge';

	public static function boot(): void {
		add_shortcode( 'lifelink_banner', array( __CLASS__, 'shortcode_banner' ) );
		add_shortcode( 'lifelink_einsaetze', array( __CLASS__, 'shortcode_incidents' ) );
		add_action( 'wp_body_open', array( __CLASS__, 'auto_output' ) );
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
		);
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

	/** Abgleich mit der Liste aktiver Banner aus LifeLink; Abgelaufenes wird zusätzlich lokal entfernt. */
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

	/** Aktive Banner (sortiert: Priorität, dann neuester Start). Mit $upcoming auch solche, die in 24 h beginnen. */
	public static function active( bool $upcoming = false ): array {
		$now = time();
		$out = array_filter(
			self::all(),
			static fn( $b ) => $b['ends_at'] > $now && ( $b['starts_at'] <= $now || ( $upcoming && $b['starts_at'] <= $now + DAY_IN_SECONDS ) )
		);
		usort( $out, static fn( $a, $b ) => array( $b['priority'], $b['starts_at'] ) <=> array( $a['priority'], $a['starts_at'] ) );
		return $out;
	}

	public static function render(): string {
		$list = self::active( true );
		if ( ! $list ) {
			return '';
		}
		$html = '<div class="llb-banners" data-llb-banners>';
		$now  = time();
		foreach ( $list as $b ) {
			$role   = 'danger' === $b['tone'] ? 'alert' : 'status';
			$label  = array(
				'info'    => 'Hinweis',
				'warning' => 'Warnung',
				'danger'  => 'Gefahr',
			)[ $b['tone'] ];
			$hidden = $b['starts_at'] > $now ? ' hidden' : '';
			$html  .= sprintf(
				'<div class="llb-banner llb-%1$s" role="%2$s" data-llb-start="%3$d" data-llb-end="%4$d"%5$s><span class="llb-label">%6$s</span><div class="llb-body"><strong class="llb-title">%7$s</strong>%8$s%9$s</div></div>',
				esc_attr( $b['tone'] ),
				esc_attr( $role ),
				(int) $b['starts_at'],
				(int) $b['ends_at'],
				$hidden,
				esc_html( $label ),
				esc_html( $b['title'] ),
				'' !== $b['text'] ? '<span class="llb-text">' . esc_html( $b['text'] ) . '</span>' : '',
				'' !== $b['link_url'] ? ' <a class="llb-link" href="' . esc_url( $b['link_url'] ) . '">' . esc_html( '' !== $b['link_text'] ? $b['link_text'] : 'Mehr erfahren' ) . '</a>' : ''
			);
		}
		$html .= '</div>';
		return $html;
	}

	public static function auto_output(): void {
		$auto = LifeLink_Bridge_Settings::get( 'banner_auto' );
		if ( false === $auto || '0' === $auto ) {
			return;
		}
		echo self::render(); // phpcs:ignore WordPress.Security.EscapeOutput -- in render() escaped
	}

	public static function shortcode_banner(): string {
		return self::render();
	}

	public static function shortcode_incidents( $atts = array() ): string {
		$atts  = shortcode_atts( array( 'anzahl' => 10 ), $atts, 'lifelink_einsaetze' );
		$posts = get_posts(
			array(
				'post_type'      => 'post',
				'post_status'    => 'publish',
				'posts_per_page' => max( 1, min( 50, (int) $atts['anzahl'] ) ),
				'meta_key'       => '_lifelink_kind', // phpcs:ignore WordPress.DB.SlowDBQuery
				'meta_value'     => 'incident',      // phpcs:ignore WordPress.DB.SlowDBQuery
			)
		);
		if ( ! $posts ) {
			return '<p class="llb-incidents-empty">Aktuell keine Einsatzberichte.</p>';
		}
		$html = '<ul class="llb-incidents">';
		foreach ( $posts as $p ) {
			$html .= sprintf( '<li><time datetime="%s">%s</time> <a href="%s">%s</a></li>', esc_attr( get_the_date( 'c', $p ) ), esc_html( get_the_date( 'd.m.Y', $p ) ), esc_url( get_permalink( $p ) ), esc_html( get_the_title( $p ) ) );
		}
		return $html . '</ul>';
	}

	public static function assets(): void {
		wp_enqueue_style( 'lifelink-bridge-banner', plugins_url( 'assets/banner.css', LIFELINK_BRIDGE_FILE ), array(), LIFELINK_BRIDGE_VERSION );
		wp_enqueue_script( 'lifelink-bridge-banner', plugins_url( 'assets/banner.js', LIFELINK_BRIDGE_FILE ), array(), LIFELINK_BRIDGE_VERSION, array( 'strategy' => 'defer', 'in_footer' => true ) );
	}

	public static function blocks(): void {
		wp_register_script( 'lifelink-bridge-blocks', plugins_url( 'assets/blocks.js', LIFELINK_BRIDGE_FILE ), array( 'wp-blocks', 'wp-element', 'wp-server-side-render', 'wp-block-editor' ), LIFELINK_BRIDGE_VERSION, true );
		register_block_type(
			'lifelink/banner',
			array(
				'api_version'     => 3,
				'title'           => 'LifeLink: Hinweise',
				'category'        => 'widgets',
				'editor_script'   => 'lifelink-bridge-blocks',
				'render_callback' => array( __CLASS__, 'render' ),
			)
		);
		register_block_type(
			'lifelink/incidents',
			array(
				'api_version'     => 3,
				'title'           => 'LifeLink: Einsatzübersicht',
				'category'        => 'widgets',
				'editor_script'   => 'lifelink-bridge-blocks',
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
		do_action( 'lifelink_bridge_purge_cache' );
		wp_cache_flush();
	}
}
