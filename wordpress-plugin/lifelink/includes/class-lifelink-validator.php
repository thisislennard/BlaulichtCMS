<?php
/**
 * Validierung und Bereinigung der Nutzlasten.
 *
 * @package LifeLink
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Prüft Banner- und Beitragsdaten streng nach Vertrag.
 */
final class LifeLink_Validator {

	public const COLORS     = array( 'rot', 'orange', 'gelb', 'blau', 'gruen', 'neutral' );
	public const PRIORITIES = array( 'niedrig', 'normal', 'hoch' );
	public const POST_STATI = array( 'draft', 'pending', 'future' );

	public const MAX_TITLE     = 120;
	public const MAX_TEXT      = 600;
	public const MAX_LABEL     = 30;
	public const MAX_LINK_TEXT = 80;
	public const MAX_URL       = 2048;
	public const MAX_PAGES     = 50;

	public const MAX_POST_TITLE    = 300;
	public const MAX_POST_CONTENT  = 200000;
	public const MAX_POST_EXCERPT  = 1000;
	public const MAX_CATEGORY      = 100;
	public const MAX_TAGS          = 20;
	public const MAX_TAG           = 50;
	public const MAX_BODY_BYTES    = 1048576;

	/**
	 * Ist das eine UUID?
	 *
	 * @param mixed $value Wert.
	 */
	public static function is_uuid( $value ): bool {
		return is_string( $value ) && 1 === preg_match( '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i', $value );
	}

	/**
	 * Dekodiert den rohen JSON-Body zu einem Objekt (assoziatives Array).
	 *
	 * @param string $body Roher Body.
	 * @return array|WP_Error
	 */
	public static function decode_body( string $body ) {
		if ( strlen( $body ) > self::MAX_BODY_BYTES ) {
			return LifeLink_Error::invalid( array( 'body' => __( 'Body ist zu groß.', 'lifelink' ) ) );
		}
		$data = json_decode( $body, true, 32 );
		if ( ! is_array( $data ) || ( array() !== $data && array_is_list( $data ) ) ) {
			return LifeLink_Error::invalid( array( 'body' => __( 'Body ist kein gültiges JSON-Objekt.', 'lifelink' ) ) );
		}
		return $data;
	}

	/**
	 * Wandelt ISO 8601 (UTC oder mit Offset) in einen Unix-Zeitstempel.
	 *
	 * @param mixed $value Wert.
	 */
	public static function parse_iso( $value ): ?int {
		if ( ! is_string( $value ) || 1 !== preg_match( '/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/', $value, $m ) ) {
			return null;
		}
		if ( ! checkdate( (int) $m[2], (int) $m[3], (int) $m[1] ) || (int) $m[4] > 23 || (int) $m[5] > 59 || (int) $m[6] > 59 ) {
			return null;
		}
		try {
			$date = new DateTimeImmutable( $m[1] . '-' . $m[2] . '-' . $m[3] . 'T' . $m[4] . ':' . $m[5] . ':' . $m[6] . ( 'Z' === $m[8] ? '+00:00' : $m[8] ) );
		} catch ( Exception $e ) {
			return null;
		}
		return $date->getTimestamp();
	}

	/**
	 * ISO-8601-UTC-Darstellung eines Zeitstempels.
	 *
	 * @param int $timestamp Unix-Zeit.
	 */
	public static function to_iso( int $timestamp ): string {
		return gmdate( 'Y-m-d\TH:i:s\Z', $timestamp );
	}

	/**
	 * Reiner Text, einzeilig oder mehrzeilig.
	 *
	 * sanitize_text_field() wandelt ein alleinstehendes "<" in "&lt;". Da die Ausgabe
	 * immer escaped wird, wird das zurückgewandelt, damit z. B. "Temperatur < 0 °C"
	 * nicht als "&lt;" erscheint.
	 *
	 * @param string $value     Rohwert.
	 * @param bool   $multiline Zeilenumbrüche erhalten.
	 */
	public static function plain_text( string $value, bool $multiline = false ): string {
		$clean = $multiline ? sanitize_textarea_field( $value ) : sanitize_text_field( $value );
		return str_replace( '&lt;', '<', $clean );
	}

	/**
	 * Prüft eine URL (nur http/https).
	 *
	 * @param string $url URL.
	 */
	public static function clean_url( string $url ): ?string {
		$url = trim( $url );
		if ( '' === $url || strlen( $url ) > self::MAX_URL ) {
			return null;
		}
		$parts = wp_parse_url( $url );
		if ( ! is_array( $parts ) || empty( $parts['scheme'] ) || empty( $parts['host'] ) ) {
			return null;
		}
		if ( ! in_array( strtolower( $parts['scheme'] ), array( 'http', 'https' ), true ) ) {
			return null;
		}
		$clean = esc_url_raw( $url, array( 'http', 'https' ) );
		return '' === $clean ? null : $clean;
	}

	/**
	 * Prüft ein Banner (PUT /banners/{external_id}).
	 *
	 * @param array            $in      Dekodierter Body.
	 * @param LifeLink_Targets $targets Zielseiten.
	 * @return array|WP_Error Bereinigte Daten (Zeiten als Unix-Zeit).
	 */
	public static function banner( array $in, LifeLink_Targets $targets ) {
		$errors = array();
		$out    = array();

		// revision.
		if ( ! isset( $in['revision'] ) || ! is_int( $in['revision'] ) || $in['revision'] < 1 ) {
			$errors['revision'] = __( 'Ganze Zahl ≥ 1 erwartet.', 'lifelink' );
		} else {
			$out['revision'] = $in['revision'];
		}

		// title.
		$title = $in['title'] ?? null;
		if ( ! is_string( $title ) || '' === trim( $title ) ) {
			$errors['title'] = __( 'Titel fehlt.', 'lifelink' );
		} elseif ( mb_strlen( $title ) > self::MAX_TITLE ) {
			$errors['title'] = __( 'Titel ist länger als 120 Zeichen.', 'lifelink' );
		} else {
			$out['title'] = self::plain_text( $title );
			if ( '' === $out['title'] ) {
				$errors['title'] = __( 'Titel ist leer.', 'lifelink' );
			}
		}

		// text.
		$text = $in['text'] ?? '';
		if ( null === $text ) {
			$text = '';
		}
		if ( ! is_string( $text ) ) {
			$errors['text'] = __( 'Text muss eine Zeichenkette sein.', 'lifelink' );
		} elseif ( mb_strlen( $text ) > self::MAX_TEXT ) {
			$errors['text'] = __( 'Text ist länger als 600 Zeichen.', 'lifelink' );
		} else {
			$out['text'] = self::plain_text( $text, true );
		}

		// color.
		$color = $in['color'] ?? null;
		if ( ! is_string( $color ) || ! in_array( $color, self::COLORS, true ) ) {
			$errors['color'] = __( 'Unbekannte Farbe.', 'lifelink' );
		} else {
			$out['color'] = $color;
		}

		// label.
		$label = $in['label'] ?? null;
		if ( null === $label ) {
			$out['label'] = '';
		} elseif ( ! is_string( $label ) ) {
			$errors['label'] = __( 'Label muss eine Zeichenkette sein.', 'lifelink' );
		} elseif ( mb_strlen( $label ) > self::MAX_LABEL ) {
			$errors['label'] = __( 'Label ist länger als 30 Zeichen.', 'lifelink' );
		} else {
			$out['label'] = self::plain_text( $label );
		}

		// priority.
		$priority = $in['priority'] ?? null;
		if ( ! is_string( $priority ) || ! in_array( $priority, self::PRIORITIES, true ) ) {
			$errors['priority'] = __( 'Unbekannte Priorität.', 'lifelink' );
		} else {
			$out['priority'] = $priority;
		}

		// starts_at / ends_at.
		$starts = self::parse_iso( $in['starts_at'] ?? null );
		if ( null === $starts ) {
			$errors['starts_at'] = __( 'ISO-8601-Zeit (UTC) erwartet.', 'lifelink' );
		} else {
			$out['starts_at'] = $starts;
		}

		if ( ! array_key_exists( 'ends_at', $in ) || null === $in['ends_at'] ) {
			$out['ends_at'] = null;
		} else {
			$ends = self::parse_iso( $in['ends_at'] );
			if ( null === $ends ) {
				$errors['ends_at'] = __( 'ISO-8601-Zeit (UTC) oder null erwartet.', 'lifelink' );
			} elseif ( null !== $starts && $ends <= $starts ) {
				$errors['ends_at'] = __( 'Ende muss nach dem Start liegen.', 'lifelink' );
			} else {
				$out['ends_at'] = $ends;
			}
		}

		// pages.
		$pages = $in['pages'] ?? null;
		if ( ! is_array( $pages ) || ! array_is_list( $pages ) || array() === $pages ) {
			$errors['pages'] = __( 'Mindestens eine Zielseite erwartet.', 'lifelink' );
		} elseif ( count( $pages ) > self::MAX_PAGES ) {
			$errors['pages'] = __( 'Zu viele Zielseiten.', 'lifelink' );
		} else {
			$clean = array();
			foreach ( $pages as $page ) {
				if ( ! is_string( $page ) || ! $targets->is_valid( $page ) ) {
					$errors['pages'] = __( 'Unbekannte oder nicht veröffentlichte Zielseite.', 'lifelink' );
					break;
				}
				if ( ! in_array( $page, $clean, true ) ) {
					$clean[] = $page;
				}
			}
			if ( ! isset( $errors['pages'] ) ) {
				$out['pages'] = $clean;
			}
		}

		// link_url / link_text.
		$link_url = $in['link_url'] ?? null;
		if ( null === $link_url || '' === $link_url ) {
			$out['link_url'] = null;
		} elseif ( ! is_string( $link_url ) ) {
			$errors['link_url'] = __( 'URL muss eine Zeichenkette sein.', 'lifelink' );
		} else {
			$url = self::clean_url( $link_url );
			if ( null === $url ) {
				$errors['link_url'] = __( 'Nur http:// oder https:// erlaubt.', 'lifelink' );
			} else {
				$out['link_url'] = $url;
			}
		}

		$link_text = $in['link_text'] ?? null;
		if ( null === $link_text || '' === $link_text ) {
			$out['link_text'] = null;
		} elseif ( ! is_string( $link_text ) ) {
			$errors['link_text'] = __( 'Linktext muss eine Zeichenkette sein.', 'lifelink' );
		} elseif ( mb_strlen( $link_text ) > self::MAX_LINK_TEXT ) {
			$errors['link_text'] = __( 'Linktext ist länger als 80 Zeichen.', 'lifelink' );
		} else {
			$clean_text       = self::plain_text( $link_text );
			$out['link_text'] = '' === $clean_text ? null : $clean_text;
		}
		if ( empty( $errors ) && null === $out['link_url'] ) {
			$out['link_text'] = null;
		}

		return empty( $errors ) ? $out : LifeLink_Error::invalid( $errors );
	}

	/**
	 * Prüft einen Beitrag (POST /posts).
	 *
	 * @param array $in Dekodierter Body.
	 * @return array|WP_Error
	 */
	public static function post( array $in ) {
		$errors = array();
		$out    = array();

		if ( ! self::is_uuid( $in['external_id'] ?? null ) ) {
			$errors['external_id'] = __( 'UUID erwartet.', 'lifelink' );
		} else {
			$out['external_id'] = strtolower( $in['external_id'] );
		}

		if ( ! isset( $in['revision'] ) || ! is_int( $in['revision'] ) || $in['revision'] < 1 ) {
			$errors['revision'] = __( 'Ganze Zahl ≥ 1 erwartet.', 'lifelink' );
		} else {
			$out['revision'] = $in['revision'];
		}

		$title = $in['title'] ?? null;
		if ( ! is_string( $title ) || '' === trim( $title ) ) {
			$errors['title'] = __( 'Titel fehlt.', 'lifelink' );
		} elseif ( mb_strlen( $title ) > self::MAX_POST_TITLE ) {
			$errors['title'] = __( 'Titel ist zu lang.', 'lifelink' );
		} else {
			$out['title'] = self::plain_text( $title );
			if ( '' === $out['title'] ) {
				$errors['title'] = __( 'Titel ist leer.', 'lifelink' );
			}
		}

		$content = $in['content'] ?? '';
		if ( null === $content ) {
			$content = '';
		}
		if ( ! is_string( $content ) ) {
			$errors['content'] = __( 'Inhalt muss eine Zeichenkette sein.', 'lifelink' );
		} elseif ( strlen( $content ) > self::MAX_POST_CONTENT ) {
			$errors['content'] = __( 'Inhalt ist zu lang.', 'lifelink' );
		} else {
			$out['content'] = wp_kses_post( $content );
		}

		$excerpt = $in['excerpt'] ?? '';
		if ( null === $excerpt ) {
			$excerpt = '';
		}
		if ( ! is_string( $excerpt ) ) {
			$errors['excerpt'] = __( 'Auszug muss eine Zeichenkette sein.', 'lifelink' );
		} elseif ( mb_strlen( $excerpt ) > self::MAX_POST_EXCERPT ) {
			$errors['excerpt'] = __( 'Auszug ist zu lang.', 'lifelink' );
		} else {
			$out['excerpt'] = self::plain_text( $excerpt, true );
		}

		$category = $in['category'] ?? null;
		if ( null === $category || '' === $category ) {
			$out['category'] = '';
		} elseif ( ! is_string( $category ) || mb_strlen( $category ) > self::MAX_CATEGORY ) {
			$errors['category'] = __( 'Kategorie ungültig.', 'lifelink' );
		} else {
			$out['category'] = self::plain_text( $category );
		}

		$tags = $in['tags'] ?? array();
		if ( null === $tags ) {
			$tags = array();
		}
		if ( ! is_array( $tags ) || ! array_is_list( $tags ) || count( $tags ) > self::MAX_TAGS ) {
			$errors['tags'] = __( 'Liste mit höchstens 20 Schlagwörtern erwartet.', 'lifelink' );
		} else {
			$clean_tags = array();
			foreach ( $tags as $tag ) {
				if ( ! is_string( $tag ) || mb_strlen( $tag ) > self::MAX_TAG ) {
					$errors['tags'] = __( 'Schlagwort ungültig.', 'lifelink' );
					break;
				}
				$tag = self::plain_text( $tag );
				// Kommas würden in tags_input als Trenner gelten.
				$tag = trim( str_replace( ',', ' ', $tag ) );
				if ( '' !== $tag && ! in_array( $tag, $clean_tags, true ) ) {
					$clean_tags[] = $tag;
				}
			}
			if ( ! isset( $errors['tags'] ) ) {
				$out['tags'] = $clean_tags;
			}
		}

		$status = $in['status'] ?? null;
		if ( ! is_string( $status ) || ! in_array( $status, self::POST_STATI, true ) ) {
			$errors['status'] = __( 'Status muss draft, pending oder future sein.', 'lifelink' );
		} else {
			$out['status'] = $status;
		}

		$publish_at = $in['publish_at'] ?? null;
		if ( null === $publish_at ) {
			$out['publish_at'] = null;
		} else {
			$ts = self::parse_iso( $publish_at );
			if ( null === $ts ) {
				$errors['publish_at'] = __( 'ISO-8601-Zeit (UTC) oder null erwartet.', 'lifelink' );
			} else {
				$out['publish_at'] = $ts;
			}
		}

		if ( isset( $out['status'] ) && 'future' === $out['status'] && ! isset( $errors['publish_at'] ) ) {
			if ( null === $out['publish_at'] ) {
				$errors['publish_at'] = __( 'Bei Status future ist publish_at Pflicht.', 'lifelink' );
			} elseif ( $out['publish_at'] <= time() ) {
				// WordPress würde einen "future"-Beitrag mit vergangenem Datum sofort veröffentlichen.
				$errors['publish_at'] = __( 'publish_at muss in der Zukunft liegen.', 'lifelink' );
			}
		}

		return empty( $errors ) ? $out : LifeLink_Error::invalid( $errors );
	}
}
