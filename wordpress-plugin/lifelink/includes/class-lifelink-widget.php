<?php
/**
 * Klassisches Widget "LifeLink-Hinweise".
 *
 * @package LifeLink
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Widget, das die aktiven Banner der aktuellen Seite anzeigt.
 */
class LifeLink_Widget extends WP_Widget {

	/**
	 * Konstruktor.
	 */
	public function __construct() {
		parent::__construct(
			'lifelink_banners',
			__( 'LifeLink-Hinweise', 'lifelink' ),
			array(
				'description'                 => __( 'Zeigt die aktiven Hinweis-Banner aus LifeLink an.', 'lifelink' ),
				'customize_selective_refresh' => true,
				'show_instance_in_rest'       => true,
			)
		);
	}

	/**
	 * Ausgabe im Frontend.
	 *
	 * @param array $args     Sidebar-Argumente.
	 * @param array $instance Einstellungen.
	 */
	public function widget( $args, $instance ) {
		$renderer = LifeLink_Plugin::instance()->renderer();
		$html     = $renderer->render( array( 'source' => 'widget' ) );
		if ( '' === $html ) {
			return;
		}

		// Ohne aktive Banner nur den (versteckten) Container ausgeben, keinen leeren Widget-Rahmen.
		if ( ! $renderer->has_banners() ) {
			echo $html; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- escaped in renderer.
			return;
		}

		$title = isset( $instance['title'] ) ? (string) $instance['title'] : '';
		/** This filter is documented in wp-includes/widgets/class-wp-widget-pages.php */
		$title = apply_filters( 'widget_title', $title, $instance, $this->id_base );

		echo $args['before_widget'] ?? ''; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- theme markup.
		if ( '' !== trim( (string) $title ) ) {
			echo ( $args['before_title'] ?? '' ) . esc_html( $title ) . ( $args['after_title'] ?? '' ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- theme markup.
		}
		echo $html; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- escaped in renderer.
		echo $args['after_widget'] ?? ''; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- theme markup.
	}

	/**
	 * Formular im Backend.
	 *
	 * @param array $instance Einstellungen.
	 * @return string
	 */
	public function form( $instance ) {
		$title = isset( $instance['title'] ) ? (string) $instance['title'] : '';
		printf(
			'<p><label for="%1$s">%2$s</label><input class="widefat" id="%1$s" name="%3$s" type="text" value="%4$s"></p>',
			esc_attr( $this->get_field_id( 'title' ) ),
			esc_html__( 'Titel (optional):', 'lifelink' ),
			esc_attr( $this->get_field_name( 'title' ) ),
			esc_attr( $title )
		);
		echo '<p class="description">' . esc_html__( 'Zeigt nur Banner, die für die aufgerufene Seite aktiv sind.', 'lifelink' ) . '</p>';
		return '';
	}

	/**
	 * Speichern.
	 *
	 * @param array $new_instance Neue Werte.
	 * @param array $old_instance Alte Werte.
	 * @return array
	 */
	public function update( $new_instance, $old_instance ) {
		return array(
			'title' => isset( $new_instance['title'] ) ? sanitize_text_field( (string) $new_instance['title'] ) : '',
		);
	}
}
