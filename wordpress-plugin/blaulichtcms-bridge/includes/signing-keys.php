<?php
/**
 * Öffentliche Schlüssel für die Signaturprüfung von Bridge-Updates (#107). Erzeugt mit
 * `node scripts/bridge-signing.mjs keygen`. Eine Bridge mit mindestens einem Schlüssel installiert nur Updates, die mit
 * einem dieser Schlüssel signiert sind. Die zugehörigen privaten Schlüssel liegen nicht auf dem BlaulichtCMS-Server.
 * Leere Liste = Rückfallbetrieb (nur Prüfsumme aus BlaulichtCMS), siehe docs/bridge-signatur.md.
 *
 * @package BlaulichtCMSBridge
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

return array(
	'atg1y8zLUY4uuvCe4VD5SJYAG7uhejUBGgwYQgTnr+o=',
);
