<?php
/**
 * Prüft BlaulichtCMS_Bridge_Readme ohne WordPress (CI: `php test/wordpress/readme-sections.php`):
 * Reiter aus der readme.txt der Bridge, Maskierung, Changelog auf die neuesten Versionen begrenzt.
 */
define( 'ABSPATH', __DIR__ . '/' );
define( 'BLAULICHTCMS_BRIDGE_DIR', dirname( __DIR__, 2 ) . '/wordpress-plugin/blaulichtcms-bridge/' );
define( 'BLAULICHTCMS_BRIDGE_FILE', BLAULICHTCMS_BRIDGE_DIR . 'blaulichtcms-bridge.php' );
function esc_html( $t ) { return htmlspecialchars( (string) $t, ENT_QUOTES, 'UTF-8' ); }
function plugins_url( $p, $f ) { return 'https://example.org/wp-content/plugins/blaulichtcms-bridge/' . $p; }
require BLAULICHTCMS_BRIDGE_DIR . 'includes/class-readme.php';

$fail = 0;
function check( $cond, $msg ) {
	global $fail;
	echo ( $cond ? 'ok   ' : 'FEHL ' ) . $msg . "\n";
	if ( ! $cond ) {
		$fail++;
	}
}

$readme = BlaulichtCMS_Bridge_Readme::local();
check( '' !== $readme, 'readme.txt der Bridge gelesen' );
$s = BlaulichtCMS_Bridge_Readme::sections( $readme );
check( array_keys( $s ) === array( 'description', 'installation', 'faq', 'changelog' ), 'Reiter: ' . implode( ', ', array_keys( $s ) ) );
check( str_contains( $s['description'], '<ul><li>' ), 'Beschreibung mit Liste' );
check( str_contains( $s['description'], '<h3>Einstellungen</h3>' ), 'weitere Abschnitte hängen an der Beschreibung' );
check( str_contains( $s['installation'], '<ol><li>' ), 'Installation als nummerierte Liste' );
check( str_contains( $s['installation'], '<pre><code>* * * * * wp' ), 'Einrückung wird zu Code' );
check( str_contains( $s['faq'], '<h4>' ), 'Fragen als Überschriften' );
preg_match( '/^Stable tag:\s*([0-9.]+)/m', $readme, $m );
check( str_contains( $s['changelog'], '<h4>' . $m[1] . '</h4>' ), 'Changelog beginnt mit der aktuellen Version ' . $m[1] );
check( substr_count( $s['changelog'], '<h4>' ) === BlaulichtCMS_Bridge_Readme::CHANGELOG_VERSIONS, 'Changelog auf die neuesten Versionen begrenzt' );
check( str_contains( $s['changelog'], '<code>' ) && str_contains( $s['description'], '<strong>' ), 'Code und Fettdruck' );

$evil = "== Beschreibung ==\n\n<script>alert(1)</script> **<img src=x onerror=alert(1)>** `<b>`\n* <a href=\"javascript:x\">x</a>\n";
$e    = BlaulichtCMS_Bridge_Readme::sections( $evil );
check( ! preg_match( '/<(script|img|a|b)\b/', $e['description'] ), 'HTML aus der readme.txt wird maskiert' );
check( 2 === count( BlaulichtCMS_Bridge_Readme::icons() ) && 2 === count( BlaulichtCMS_Bridge_Readme::banners() ), 'Symbol und Titelbild' );
foreach ( array( 'icon-128x128.png', 'icon-256x256.png', 'banner-772x250.png', 'banner-1544x500.png' ) as $img ) {
	check( is_readable( BLAULICHTCMS_BRIDGE_DIR . 'assets/' . $img ), "Bild $img vorhanden" );
}
exit( $fail ? 1 : 0 );
