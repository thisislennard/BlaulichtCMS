<?php
/**
 * Serverseitige Ausgabe des Blocks lifelink/banners.
 *
 * Verfügbare Variablen: $attributes, $content, $block.
 *
 * @package LifeLink
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

$lifelink_classes = 'wp-block-lifelink-banners';
if ( isset( $attributes['align'] ) && in_array( $attributes['align'], array( 'wide', 'full' ), true ) ) {
	$lifelink_classes .= ' align' . $attributes['align'];
}
if ( ! empty( $attributes['className'] ) && is_string( $attributes['className'] ) ) {
	$lifelink_classes .= ' ' . implode( ' ', array_map( 'sanitize_html_class', preg_split( '/\s+/', $attributes['className'] ) ) );
}

echo LifeLink_Plugin::instance()->renderer()->render( // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- escaped in renderer.
	array(
		'source' => 'block',
		'class'  => $lifelink_classes,
	)
);
