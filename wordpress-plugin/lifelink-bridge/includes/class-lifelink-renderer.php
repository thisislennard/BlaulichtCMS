<?php
/**
 * HTML-Ausgabe der Banner (Shortcode, Block, Widget, automatische Ausgabe, Admin-Vorschau).
 *
 * @package LifeLink
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Renderer.
 */
final class LifeLink_Renderer {

	/**
	 * Wurden die Frontend-Skripte bereits vorbereitet?
	 *
	 * @var bool
	 */
	private bool $script_enqueued = false;

	/**
	 * Konstruktor.
	 *
	 * @param LifeLink_Banner_Repository $repository Banner.
	 * @param LifeLink_Targets           $targets    Zielseiten.
	 * @param LifeLink_Settings          $settings   Einstellungen.
	 */
	public function __construct(
		private LifeLink_Banner_Repository $repository,
		private LifeLink_Targets $targets,
		private LifeLink_Settings $settings
	) {}

	/**
	 * Hooks registrieren.
	 */
	public function register(): void {
		add_action( 'wp_enqueue_scripts', array( $this, 'register_assets' ) );
		add_shortcode( 'lifelink_banners', array( $this, 'shortcode' ) );
		add_action( 'wp_body_open', array( $this, 'auto_output' ), 5 );
	}

	/**
	 * Standardlabels je Farbe.
	 *
	 * @return array<string,string>
	 */
	public static function default_labels(): array {
		return array(
			'rot'     => __( 'Wichtig', 'lifelink' ),
			'orange'  => __( 'Achtung', 'lifelink' ),
			'gelb'    => __( 'Hinweis', 'lifelink' ),
			'blau'    => __( 'Information', 'lifelink' ),
			'gruen'   => __( 'Info', 'lifelink' ),
			'neutral' => __( 'Hinweis', 'lifelink' ),
		);
	}

	/**
	 * Lesbare Farbnamen (Admin).
	 *
	 * @return array<string,string>
	 */
	public static function color_names(): array {
		return array(
			'rot'     => __( 'Rot', 'lifelink' ),
			'orange'  => __( 'Orange', 'lifelink' ),
			'gelb'    => __( 'Gelb', 'lifelink' ),
			'blau'    => __( 'Blau', 'lifelink' ),
			'gruen'   => __( 'Grün', 'lifelink' ),
			'neutral' => __( 'Neutral', 'lifelink' ),
		);
	}

	/**
	 * Sichtbares Label eines Banners (eigenes oder Standardlabel der Farbe).
	 *
	 * @param array $row Datenbankzeile.
	 */
	public static function effective_label( array $row ): string {
		$label = trim( (string) ( $row['label'] ?? '' ) );
		if ( '' !== $label ) {
			return $label;
		}
		$defaults = self::default_labels();
		return $defaults[ (string) ( $row['color'] ?? 'neutral' ) ] ?? $defaults['neutral'];
	}

	/**
	 * Registriert CSS (immer, damit es im <head> steht) und JS.
	 */
	public function register_assets(): void {
		wp_enqueue_style( 'lifelink-banners', LIFELINK_URL . 'assets/lifelink.css', array(), LIFELINK_VERSION );
		wp_register_script(
			'lifelink-banners',
			LIFELINK_URL . 'assets/lifelink.js',
			array(),
			LIFELINK_VERSION,
			array(
				'in_footer' => true,
				'strategy'  => 'defer',
			)
		);
	}

	/**
	 * Bindet das Skript samt Konfiguration ein (einmal pro Seite).
	 */
	private function enqueue_script(): void {
		if ( $this->script_enqueued ) {
			return;
		}
		$this->script_enqueued = true;

		if ( ! wp_script_is( 'lifelink-banners', 'registered' ) ) {
			$this->register_assets();
		}
		wp_enqueue_style( 'lifelink-banners' );
		wp_enqueue_script( 'lifelink-banners' );

		$config = array(
			'endpoint' => rest_url( LifeLink_REST_Controller::REST_NAMESPACE . '/public/banners' ),
			'refresh'  => (bool) $this->settings->get( 'refresh' ),
			'interval' => 120,
			'labels'   => self::default_labels(),
			'i18n'     => array(
				'expiredOne'  => __( 'Ein Hinweis ist abgelaufen und wurde ausgeblendet.', 'lifelink' ),
				'expiredMany' => __( '%d Hinweise sind abgelaufen und wurden ausgeblendet.', 'lifelink' ),
				'updated'     => __( 'Die Hinweise wurden aktualisiert.', 'lifelink' ),
				'linkText'    => __( 'Mehr erfahren', 'lifelink' ),
			),
		);
		wp_add_inline_script( 'lifelink-banners', 'window.lifelinkBanners = ' . wp_json_encode( $config ) . ';', 'before' );
	}

	/**
	 * Shortcode [lifelink_banners].
	 *
	 * @param array|string $atts Attribute (keine).
	 */
	public function shortcode( $atts = array() ): string {
		return $this->render( array( 'source' => 'shortcode' ) );
	}

	/**
	 * Automatische Ausgabe am Seitenanfang.
	 */
	public function auto_output(): void {
		if ( ! $this->settings->get( 'auto_output' ) ) {
			return;
		}
		echo $this->render( array( 'source' => 'auto' ) ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- render() escapes everything.
	}

	/**
	 * Rendert den Banner-Container für die aktuelle Seite.
	 *
	 * @param array $args { source: string, class: string }.
	 */
	public function render( array $args = array() ): string {
		if ( is_admin() || is_feed() || ( defined( 'REST_REQUEST' ) && REST_REQUEST ) ) {
			return '';
		}

		$args    = wp_parse_args(
			$args,
			array(
				'source' => 'shortcode',
				'class'  => '',
			)
		);
		$context = $this->targets->current_context();
		$rows    = $this->repository->active( $this->targets->targets_for_context( $context ) );
		$refresh = (bool) $this->settings->get( 'refresh' );

		if ( empty( $rows ) && ! $refresh ) {
			return '';
		}

		$this->enqueue_script();

		$classes = trim( 'lifelink-banners ' . $args['class'] );
		$html    = sprintf(
			'<div class="%1$s" role="region" aria-label="%2$s" data-lifelink-context="%3$s" data-lifelink-source="%4$s"%5$s>',
			esc_attr( $classes ),
			esc_attr__( 'Hinweise', 'lifelink' ),
			esc_attr( $context ),
			esc_attr( sanitize_key( (string) $args['source'] ) ),
			empty( $rows ) ? ' hidden' : ''
		);
		foreach ( $rows as $row ) {
			$html .= $this->render_banner( $row );
		}
		$html .= '</div>';

		return $html;
	}

	/**
	 * Gibt es für die aktuelle Seite aktive Banner?
	 */
	public function has_banners(): bool {
		$context = $this->targets->current_context();
		return array() !== $this->repository->active( $this->targets->targets_for_context( $context ) );
	}

	/**
	 * Rendert ein einzelnes Banner.
	 *
	 * @param array $row     Datenbankzeile.
	 * @param bool  $preview Admin-Vorschau (ohne Live-Rolle und ohne Ablauf-Attribut).
	 */
	public function render_banner( array $row, bool $preview = false ): string {
		$colors   = LifeLink_Validator::COLORS;
		$color    = in_array( $row['color'] ?? '', $colors, true ) ? (string) $row['color'] : 'neutral';
		$priority = in_array( $row['priority'] ?? '', LifeLink_Validator::PRIORITIES, true ) ? (string) $row['priority'] : 'normal';
		$ends     = LifeLink_Banner_Repository::ts( $row['ends_at'] ?? null );
		$label    = self::effective_label( $row );
		$title    = (string) ( $row['title'] ?? '' );
		$text     = (string) ( $row['body'] ?? '' );
		$link_url = (string) ( $row['link_url'] ?? '' );

		$attributes = sprintf(
			' class="%1$s"',
			esc_attr( 'lifelink-banner lifelink-banner--' . $color . ' lifelink-banner--prio-' . $priority )
		);
		if ( ! $preview ) {
			$attributes .= sprintf(
				' role="%1$s" data-lifelink-id="%2$s" data-lifelink-ends="%3$s"',
				'hoch' === $priority ? 'alert' : 'status',
				esc_attr( (string) $row['external_id'] ),
				esc_attr( null === $ends ? '' : LifeLink_Validator::to_iso( $ends ) )
			);
		}

		$html  = '<div' . $attributes . '>';
		$html .= '<div class="lifelink-banner__inner">';
		$html .= '<span class="lifelink-banner__label">' . esc_html( $label ) . '<span class="lifelink-visually-hidden">: </span></span>';
		$html .= '<div class="lifelink-banner__content">';
		$html .= '<strong class="lifelink-banner__title">' . esc_html( $title ) . '</strong>';
		if ( '' !== $text ) {
			$html .= '<p class="lifelink-banner__text">' . esc_html( $text ) . '</p>';
		}
		if ( '' !== $link_url ) {
			$link_text = trim( (string) ( $row['link_text'] ?? '' ) );
			$html     .= sprintf(
				'<a class="lifelink-banner__link" href="%1$s">%2$s</a>',
				esc_url( $link_url, array( 'http', 'https' ) ),
				esc_html( '' !== $link_text ? $link_text : __( 'Mehr erfahren', 'lifelink' ) )
			);
		}
		$html .= '</div></div></div>';

		return $html;
	}
}
