<?php
/**
 * Eigenständiger Test der HMAC-Signatur (Schnittstellenvertrag v1) ohne WordPress.
 *
 * Aufruf: php wordpress-plugin/tests/signature-test.php
 * Exit-Code 0 = alle Prüfungen bestanden, 1 = Fehler.
 *
 * Testvektor (identisch auf Server-Seite verwenden, berechnet mit Node.js crypto):
 *
 *   secret    = test-secret-123
 *   method    = PUT
 *   route     = /lifelink/v1/banners/11111111-2222-3333-4444-555555555555
 *   timestamp = 1767225600
 *   nonce     = abcdefghijklmnop
 *   body      = {"revision":1}
 *
 *   sha256(body)       = d8560b7658c792bdded69837b055e2ed54708be6123b7bb4cc9fadf261ea091f
 *   kanonischer String = "PUT\n/lifelink/v1/banners/11111111-2222-3333-4444-555555555555\n1767225600\nabcdefghijklmnop\nd8560b76…091f"
 *   X-LifeLink-Signature = v1=73759e973f4831f4aec90b172e6da7669829bf12d5ec87feec84d42b21decc76
 *
 * Node-Gegenprobe:
 *   node -e "const c=require('crypto');const b='{\"revision\":1}';const s=['PUT','/lifelink/v1/banners/11111111-2222-3333-4444-555555555555','1767225600','abcdefghijklmnop',c.createHash('sha256').update(b).digest('hex')].join('\n');console.log('v1='+c.createHmac('sha256','test-secret-123').update(s).digest('hex'))"
 *
 * @package LifeLink
 */

define( 'ABSPATH', __DIR__ . '/' );

require dirname( __DIR__ ) . '/lifelink/includes/class-lifelink-signature.php';

const LIFELINK_TEST_SECRET    = 'test-secret-123';
const LIFELINK_TEST_METHOD    = 'PUT';
const LIFELINK_TEST_ROUTE     = '/lifelink/v1/banners/11111111-2222-3333-4444-555555555555';
const LIFELINK_TEST_TIMESTAMP = '1767225600';
const LIFELINK_TEST_NONCE     = 'abcdefghijklmnop';
const LIFELINK_TEST_BODY      = '{"revision":1}';
const LIFELINK_TEST_BODY_HASH = 'd8560b7658c792bdded69837b055e2ed54708be6123b7bb4cc9fadf261ea091f';
const LIFELINK_TEST_EXPECTED  = 'v1=73759e973f4831f4aec90b172e6da7669829bf12d5ec87feec84d42b21decc76';

$failures = 0;

/**
 * Einzelne Prüfung.
 *
 * @param string $name Name.
 * @param bool   $ok   Ergebnis.
 */
function lifelink_check( string $name, bool $ok ): void {
	global $failures;
	echo ( $ok ? '[OK]   ' : '[FAIL] ' ) . $name . PHP_EOL;
	if ( ! $ok ) {
		++$failures;
	}
}

$canonical = LifeLink_Signature::canonical_string( LIFELINK_TEST_METHOD, LIFELINK_TEST_ROUTE, LIFELINK_TEST_TIMESTAMP, LIFELINK_TEST_NONCE, LIFELINK_TEST_BODY );
lifelink_check(
	'kanonischer String',
	"PUT\n" . LIFELINK_TEST_ROUTE . "\n1767225600\nabcdefghijklmnop\n" . LIFELINK_TEST_BODY_HASH === $canonical
);

$signature = LifeLink_Signature::sign( LIFELINK_TEST_SECRET, LIFELINK_TEST_METHOD, LIFELINK_TEST_ROUTE, LIFELINK_TEST_TIMESTAMP, LIFELINK_TEST_NONCE, LIFELINK_TEST_BODY );
lifelink_check( 'Signatur entspricht Testvektor (' . $signature . ')', LIFELINK_TEST_EXPECTED === $signature );

lifelink_check(
	'verify() akzeptiert Testvektor',
	LifeLink_Signature::verify( LIFELINK_TEST_SECRET, LIFELINK_TEST_EXPECTED, LIFELINK_TEST_METHOD, LIFELINK_TEST_ROUTE, LIFELINK_TEST_TIMESTAMP, LIFELINK_TEST_NONCE, LIFELINK_TEST_BODY )
);

lifelink_check(
	'verify() akzeptiert Hex in Großbuchstaben',
	LifeLink_Signature::verify( LIFELINK_TEST_SECRET, 'v1=' . strtoupper( substr( LIFELINK_TEST_EXPECTED, 3 ) ), LIFELINK_TEST_METHOD, LIFELINK_TEST_ROUTE, LIFELINK_TEST_TIMESTAMP, LIFELINK_TEST_NONCE, LIFELINK_TEST_BODY )
);

lifelink_check(
	'Methode wird in Großbuchstaben gewandelt',
	LIFELINK_TEST_EXPECTED === LifeLink_Signature::sign( LIFELINK_TEST_SECRET, 'put', LIFELINK_TEST_ROUTE, LIFELINK_TEST_TIMESTAMP, LIFELINK_TEST_NONCE, LIFELINK_TEST_BODY )
);

$tampered = array(
	'geänderter Body'      => array( LIFELINK_TEST_SECRET, LIFELINK_TEST_METHOD, LIFELINK_TEST_ROUTE, LIFELINK_TEST_TIMESTAMP, LIFELINK_TEST_NONCE, '{"revision":2}' ),
	'geänderte Route'      => array( LIFELINK_TEST_SECRET, LIFELINK_TEST_METHOD, '/lifelink/v1/banners', LIFELINK_TEST_TIMESTAMP, LIFELINK_TEST_NONCE, LIFELINK_TEST_BODY ),
	'geänderte Methode'    => array( LIFELINK_TEST_SECRET, 'DELETE', LIFELINK_TEST_ROUTE, LIFELINK_TEST_TIMESTAMP, LIFELINK_TEST_NONCE, LIFELINK_TEST_BODY ),
	'geänderter Timestamp' => array( LIFELINK_TEST_SECRET, LIFELINK_TEST_METHOD, LIFELINK_TEST_ROUTE, '1767225601', LIFELINK_TEST_NONCE, LIFELINK_TEST_BODY ),
	'geänderte Nonce'      => array( LIFELINK_TEST_SECRET, LIFELINK_TEST_METHOD, LIFELINK_TEST_ROUTE, LIFELINK_TEST_TIMESTAMP, 'abcdefghijklmnoq', LIFELINK_TEST_BODY ),
	'falsches Geheimnis'   => array( 'test-secret-124', LIFELINK_TEST_METHOD, LIFELINK_TEST_ROUTE, LIFELINK_TEST_TIMESTAMP, LIFELINK_TEST_NONCE, LIFELINK_TEST_BODY ),
);
foreach ( $tampered as $name => $args ) {
	lifelink_check(
		'verify() lehnt ab: ' . $name,
		! LifeLink_Signature::verify( $args[0], LIFELINK_TEST_EXPECTED, $args[1], $args[2], $args[3], $args[4], $args[5] )
	);
}

lifelink_check(
	'verify() lehnt fehlendes Präfix ab',
	! LifeLink_Signature::verify( LIFELINK_TEST_SECRET, substr( LIFELINK_TEST_EXPECTED, 3 ), LIFELINK_TEST_METHOD, LIFELINK_TEST_ROUTE, LIFELINK_TEST_TIMESTAMP, LIFELINK_TEST_NONCE, LIFELINK_TEST_BODY )
);

lifelink_check(
	'verify() lehnt leeres Geheimnis ab',
	! LifeLink_Signature::verify( '', LIFELINK_TEST_EXPECTED, LIFELINK_TEST_METHOD, LIFELINK_TEST_ROUTE, LIFELINK_TEST_TIMESTAMP, LIFELINK_TEST_NONCE, LIFELINK_TEST_BODY )
);

lifelink_check(
	'GET mit leerem Body nutzt sha256("")',
	str_ends_with(
		LifeLink_Signature::canonical_string( 'GET', '/lifelink/v1/status', '1767225600', LIFELINK_TEST_NONCE, '' ),
		"\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
	)
);

echo PHP_EOL . ( 0 === $failures ? 'Alle Prüfungen bestanden.' : $failures . ' Prüfung(en) fehlgeschlagen.' ) . PHP_EOL;
exit( 0 === $failures ? 0 : 1 );
