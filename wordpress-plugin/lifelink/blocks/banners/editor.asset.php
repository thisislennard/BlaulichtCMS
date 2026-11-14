<?php
/**
 * Abhängigkeiten des Editor-Skripts (ohne Build-Schritt von Hand gepflegt).
 *
 * @package LifeLink
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

return array(
	'dependencies' => array( 'wp-blocks', 'wp-element', 'wp-block-editor', 'wp-components', 'wp-i18n' ),
	'version'      => '1.0.0',
);
