<?php
/**
 * Plugin-Details (Fenster „Details ansehen“ in der Plugin-Liste und bei Aktualisierungen) aus der readme.txt.
 *
 * Bei einem angebotenen Update kommt die readme.txt der NEUEN Version von BlaulichtCMS mit (Feld `readme` des
 * Update-Angebots); sonst gilt die readme.txt der installierten Bridge. Der Text wird vollständig maskiert und nur mit
 * wenigen eigenen Auszeichnungen (Überschrift, Liste, fett, Code) wieder aufgebaut – WordPress filtert die Abschnitte
 * zusätzlich mit wp_kses.
 *
 * @package BlaulichtCMSBridge
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class BlaulichtCMS_Bridge_Readme {
	/** Abschnitte der readme.txt → Reiter im Details-Fenster. Weitere Abschnitte hängen an die Beschreibung an. */
	const TABS = array(
		'Beschreibung'    => 'description',
		'Installation'    => 'installation',
		'Häufige Fragen'  => 'faq',
		'Changelog'       => 'changelog',
	);
	/** So viele Versionen zeigt der Reiter „Changelog“. */
	const CHANGELOG_VERSIONS = 6;

	/** readme.txt der installierten Bridge. */
	public static function local(): string {
		$file = BLAULICHTCMS_BRIDGE_DIR . 'readme.txt';
		return is_readable( $file ) ? (string) file_get_contents( $file ) : ''; // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents
	}

	/** Bilder der installierten Bridge für Plugin-Liste und Details-Fenster. */
	public static function icons(): array {
		return array(
			'1x' => plugins_url( 'assets/icon-128x128.png', BLAULICHTCMS_BRIDGE_FILE ),
			'2x' => plugins_url( 'assets/icon-256x256.png', BLAULICHTCMS_BRIDGE_FILE ),
		);
	}

	public static function banners(): array {
		return array(
			'low'  => plugins_url( 'assets/banner-772x250.png', BLAULICHTCMS_BRIDGE_FILE ),
			'high' => plugins_url( 'assets/banner-1544x500.png', BLAULICHTCMS_BRIDGE_FILE ),
		);
	}

	/**
	 * Abschnitte als HTML.
	 *
	 * @return array<string,string>
	 */
	public static function sections( string $readme ): array {
		$parts = array();
		$name  = '';
		foreach ( preg_split( '/\r\n|\r|\n/', $readme ) as $line ) {
			if ( preg_match( '/^==\s*(.+?)\s*==\s*$/', $line, $m ) ) {
				$name           = $m[1];
				$parts[ $name ] = array();
				continue;
			}
			if ( '' !== $name ) {
				$parts[ $name ][] = $line;
			}
		}
		$out = array();
		foreach ( $parts as $title => $lines ) {
			if ( 'Changelog' === $title ) {
				$lines = self::latest_versions( $lines );
			}
			$html = self::to_html( $lines );
			if ( '' === trim( $html ) ) {
				continue;
			}
			$key = self::TABS[ $title ] ?? null;
			if ( $key ) {
				$out[ $key ] = ( $out[ $key ] ?? '' ) . $html;
			} else {
				$out['description'] = ( $out['description'] ?? '' ) . '<h3>' . esc_html( $title ) . '</h3>' . $html;
			}
		}
		// Beschreibung zuerst, dann die übrigen Reiter in der Reihenfolge von WordPress.org
		$sorted = array();
		foreach ( array( 'description', 'installation', 'faq', 'changelog' ) as $key ) {
			if ( isset( $out[ $key ] ) ) {
				$sorted[ $key ] = $out[ $key ];
			}
		}
		return $sorted;
	}

	/** Nur die neuesten Versionen des Changelogs (Abschnitte „= x.y.z =“). */
	private static function latest_versions( array $lines ): array {
		$keep = array();
		$seen = 0;
		foreach ( $lines as $line ) {
			if ( preg_match( '/^=\s*[0-9.]+\s*=\s*$/', $line ) && ++$seen > self::CHANGELOG_VERSIONS ) {
				break;
			}
			$keep[] = $line;
		}
		return $keep;
	}

	/** Zeilen der readme.txt (WordPress-Readme-Format, Markdown-ähnlich) → HTML. */
	private static function to_html( array $lines ): string {
		$html  = '';
		$list  = '';
		$para  = array();
		$code  = array();
		$flush = static function () use ( &$html, &$list, &$para, &$code ) {
			if ( $para ) {
				$html .= '<p>' . implode( ' ', $para ) . '</p>';
				$para  = array();
			}
			if ( $list ) {
				$html .= '</' . $list . '>';
				$list  = '';
			}
			if ( $code ) {
				$html .= '<pre><code>' . esc_html( implode( "\n", $code ) ) . '</code></pre>';
				$code  = array();
			}
		};
		foreach ( $lines as $line ) {
			if ( preg_match( '/^(?:    |\t)(.*)$/', $line, $m ) && ! $list ) {
				if ( $para ) {
					$flush();
				}
				$code[] = $m[1];
				continue;
			}
			if ( $code ) {
				$flush();
			}
			$text = trim( $line );
			if ( '' === $text ) {
				$flush();
				continue;
			}
			if ( preg_match( '/^=\s*(.+?)\s*=$/', $text, $m ) ) {
				$flush();
				$html .= '<h4>' . self::inline( $m[1] ) . '</h4>';
				continue;
			}
			$item = null;
			$type = '';
			if ( preg_match( '/^[*-]\s+(.*)$/', $text, $m ) ) {
				$item = $m[1];
				$type = 'ul';
			} elseif ( preg_match( '/^\d+\.\s+(.*)$/', $text, $m ) ) {
				$item = $m[1];
				$type = 'ol';
			}
			if ( null !== $item ) {
				if ( $para || ( $list && $list !== $type ) ) {
					$flush();
				}
				if ( ! $list ) {
					$html .= '<' . $type . '>';
					$list  = $type;
				}
				$html .= '<li>' . self::inline( $item ) . '</li>';
				continue;
			}
			if ( $list ) {
				$flush();
			}
			$para[] = self::inline( $text );
		}
		$flush();
		return $html;
	}

	/** Maskieren, dann **fett** und `Code`. */
	private static function inline( string $text ): string {
		$text = esc_html( $text );
		$text = (string) preg_replace( '/`([^`]+)`/', '<code>$1</code>', $text );
		return (string) preg_replace( '/\*\*([^*]+)\*\*/', '<strong>$1</strong>', $text );
	}
}
