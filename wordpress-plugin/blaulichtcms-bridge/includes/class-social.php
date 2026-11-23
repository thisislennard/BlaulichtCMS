<?php
/**
 * Social-Feed (ab 0.10.0): freigegebene Beiträge der Facebook-Seite bzw. des Instagram-Kontos aus BlaulichtCMS als
 * Kacheln oder Liste – Shortcode [blaulichtcms_social] und Block „BlaulichtCMS: Social-Feed“.
 *
 * Bei jedem Abruf meldet BlaulichtCMS den Stand des Feeds (Prüfsumme). Hat er sich geändert, holt die Bridge die
 * Beiträge und legt die Vorschaubilder unter wp-content/uploads/blaulichtcms-social/ ab. Besucher laden dadurch nichts
 * von Meta oder BlaulichtCMS nach – es gibt keine eingebetteten Skripte, Iframes oder Tracking; die Beiträge verlinken
 * nur auf das Original.
 *
 * @package BlaulichtCMSBridge
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class BlaulichtCMS_Bridge_Social {

	const OPTION = 'blaulichtcms_bridge_social';
	const DIR    = 'blaulichtcms-social';
	/** Höchstens so viele Beiträge speichert die Bridge (BlaulichtCMS liefert höchstens 50). */
	const MAX = 50;

	const NETWORKS = array(
		'facebook'  => 'Facebook',
		'instagram' => 'Instagram',
	);

	public static function boot(): void {
		add_shortcode( 'blaulichtcms_social', array( __CLASS__, 'shortcode' ) );
		add_action( 'init', array( __CLASS__, 'blocks' ) );
		add_action( 'wp_enqueue_scripts', array( __CLASS__, 'register_assets' ) );
	}

	/** Gespeicherter Stand: revision, items, synced_at. */
	public static function data(): array {
		$d = get_option( self::OPTION );
		return is_array( $d ) ? $d + array(
			'revision'  => '',
			'items'     => array(),
			'synced_at' => 0,
		) : array(
			'revision'  => '',
			'items'     => array(),
			'synced_at' => 0,
		);
	}

	/** Ablageort der Bilder (Pfad und Adresse). */
	private static function dir(): array {
		$u = wp_upload_dir( null, false );
		return array(
			'path' => trailingslashit( $u['basedir'] ) . self::DIR,
			'url'  => trailingslashit( $u['baseurl'] ) . self::DIR,
		);
	}

	private static function text( $v, int $max ): string {
		$s = sanitize_textarea_field( (string) $v );
		return function_exists( 'mb_substr' ) ? mb_substr( $s, 0, $max ) : substr( $s, 0, $max );
	}

	/**
	 * Mit dem Stand aus BlaulichtCMS abgleichen (aus dem Abruf aufgerufen). Gleicher Stand: nichts zu tun.
	 *
	 * @return true|WP_Error
	 */
	public static function sync( string $revision ) {
		$revision = preg_replace( '/[^a-f0-9]/', '', strtolower( $revision ) );
		$current  = self::data();
		if ( '' === $revision || $revision === $current['revision'] ) {
			return true;
		}
		$res = BlaulichtCMS_Bridge_Client::social_feed();
		if ( is_wp_error( $res ) ) {
			return $res;
		}
		$dir = self::dir();
		if ( ! wp_mkdir_p( $dir['path'] ) ) {
			return new WP_Error( 'blaulichtcms_social_dir', 'Ablageordner für den Social-Feed lässt sich nicht anlegen.' );
		}
		$items = array();
		$keep  = array();
		foreach ( array_slice( (array) ( $res['items'] ?? array() ), 0, self::MAX ) as $raw ) {
			$raw = (array) $raw;
			$id  = sanitize_text_field( (string) ( $raw['id'] ?? '' ) );
			$ts  = strtotime( (string) ( $raw['posted_at'] ?? '' ) );
			$net = (string) ( $raw['network'] ?? '' );
			if ( '' === $id || ! $ts || ! isset( self::NETWORKS[ $net ] ) ) {
				continue;
			}
			$image = null;
			$img   = (array) ( $raw['image'] ?? array() );
			$file  = (string) ( $img['file'] ?? '' );
			if ( preg_match( '/^[0-9a-f-]{36}\.webp$/', $file ) ) {
				$dest = $dir['path'] . '/' . $file;
				$ok   = file_exists( $dest ) ? true : BlaulichtCMS_Bridge_Client::download_social_image( $file, $dest );
				if ( true === $ok ) {
					$keep[] = $file;
					$image  = array(
						'file'   => $file,
						'width'  => max( 0, (int) ( $img['width'] ?? 0 ) ),
						'height' => max( 0, (int) ( $img['height'] ?? 0 ) ),
					);
				}
			}
			$link    = esc_url_raw( (string) ( $raw['permalink'] ?? '' ), array( 'https' ) );
			$items[] = array(
				'id'        => $id,
				'network'   => $net,
				'account'   => self::text( $raw['account'] ?? '', 200 ),
				'posted_at' => (int) $ts,
				'text'      => self::text( $raw['text'] ?? '', 5000 ),
				'permalink' => $link,
				'image'     => $image,
			);
		}
		// Nicht mehr verwendete Bilder entfernen
		foreach ( (array) glob( $dir['path'] . '/*.webp' ) as $f ) {
			if ( ! in_array( basename( (string) $f ), $keep, true ) ) {
				wp_delete_file( (string) $f );
			}
		}
		update_option(
			self::OPTION,
			array(
				'revision'  => preg_replace( '/[^a-f0-9]/', '', strtolower( (string) ( $res['revision'] ?? $revision ) ) ),
				'items'     => $items,
				'synced_at' => time(),
			),
			false
		);
		BlaulichtCMS_Bridge_Banners::purge_cache();
		return true;
	}

	/** Alles entfernen (Entkoppeln, Widerruf, Deinstallation). */
	public static function clear(): void {
		$dir = self::dir();
		foreach ( (array) glob( $dir['path'] . '/*.webp' ) as $f ) {
			wp_delete_file( (string) $f );
		}
		if ( is_dir( $dir['path'] ) ) {
			@rmdir( $dir['path'] ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged,WordPress.WP.AlternativeFunctions.file_system_operations_rmdir
		}
		delete_option( self::OPTION );
	}

	/* ------------------------------------------------------------------ Darstellung */

	public static function register_assets(): void {
		wp_register_style( 'blaulichtcms-bridge-social', plugins_url( 'assets/social.css', BLAULICHTCMS_BRIDGE_FILE ), array(), BLAULICHTCMS_BRIDGE_VERSION );
	}

	private static function bool( $v, bool $default ): bool {
		if ( null === $v || '' === $v ) {
			return $default;
		}
		return in_array( strtolower( (string) $v ), array( 'ja', '1', 'true', 'an', 'yes' ), true );
	}

	/** Attribute mit Vorgaben. */
	public static function atts( $atts ): array {
		$a   = shortcode_atts(
			array(
				'anzahl'      => '6',
				'darstellung' => 'kacheln',
				'netzwerk'    => '',
				'text'        => 'ja',
				'titel'       => '',
			),
			is_array( $atts ) ? $atts : array(),
			'blaulichtcms_social'
		);
		$net = strtolower( trim( (string) $a['netzwerk'] ) );
		return array(
			'anzahl'      => max( 1, min( self::MAX, (int) $a['anzahl'] ) ),
			'darstellung' => 'liste' === strtolower( (string) $a['darstellung'] ) ? 'liste' : 'kacheln',
			'netzwerk'    => isset( self::NETWORKS[ $net ] ) ? $net : '',
			'text'        => self::bool( $a['text'], true ),
			'titel'       => sanitize_text_field( (string) $a['titel'] ),
		);
	}

	public static function shortcode( $atts = array() ): string {
		return self::render( self::atts( $atts ) );
	}

	/** Gekürzter Text (Wortgrenze). */
	private static function excerpt( string $s, int $max ): string {
		$len = function_exists( 'mb_strlen' ) ? mb_strlen( $s ) : strlen( $s );
		if ( $len <= $max ) {
			return $s;
		}
		$cut = function_exists( 'mb_substr' ) ? mb_substr( $s, 0, $max ) : substr( $s, 0, $max );
		$sp  = strrpos( $cut, ' ' );
		return rtrim( false !== $sp && $sp > $max * 0.6 ? substr( $cut, 0, $sp ) : $cut ) . ' …';
	}

	public static function render( array $a ): string {
		wp_enqueue_style( 'blaulichtcms-bridge-social' );
		$items = self::data()['items'];
		if ( '' !== $a['netzwerk'] ) {
			$items = array_values( array_filter( $items, static fn( $i ) => $a['netzwerk'] === ( $i['network'] ?? '' ) ) );
		}
		$items = array_slice( $items, 0, $a['anzahl'] );
		$dir   = self::dir();
		$h     = '<section class="bcl-social bcl-social--' . esc_attr( $a['darstellung'] ) . '"' . ( '' !== $a['titel'] ? ' aria-label="' . esc_attr( $a['titel'] ) . '"' : '' ) . '>';
		if ( '' !== $a['titel'] ) {
			$h .= '<h2 class="bcl-social-heading">' . esc_html( $a['titel'] ) . '</h2>';
		}
		if ( ! $items ) {
			return $h . '<p class="bcl-social-empty">Derzeit keine Beiträge.</p></section>';
		}
		$h .= '<ul class="bcl-social-list">';
		foreach ( $items as $i ) {
			$net   = self::NETWORKS[ $i['network'] ] ?? '';
			$date  = wp_date( get_option( 'date_format' ), (int) $i['posted_at'] );
			$link  = (string) ( $i['permalink'] ?? '' );
			$h    .= '<li class="bcl-social-item">';
			if ( ! empty( $i['image']['file'] ) ) {
				$src = $dir['url'] . '/' . $i['image']['file'];
				$dim = ! empty( $i['image']['width'] ) ? ' width="' . (int) $i['image']['width'] . '" height="' . (int) $i['image']['height'] . '"' : '';
				$img = '<img class="bcl-social-img" src="' . esc_url( $src ) . '" alt="" loading="lazy" decoding="async"' . $dim . '>';
				$h  .= $link ? '<a class="bcl-social-media" href="' . esc_url( $link ) . '" target="_blank" rel="noopener noreferrer" tabindex="-1" aria-hidden="true">' . $img . '</a>' : '<div class="bcl-social-media">' . $img . '</div>';
			}
			$h .= '<div class="bcl-social-body">';
			$h .= '<p class="bcl-social-meta"><span class="bcl-social-net bcl-social-net--' . esc_attr( $i['network'] ) . '">' . esc_html( $net ) . '</span> · <time datetime="' . esc_attr( gmdate( 'c', (int) $i['posted_at'] ) ) . '">' . esc_html( $date ) . '</time></p>';
			if ( $a['text'] && '' !== $i['text'] ) {
				$h .= '<p class="bcl-social-text">' . nl2br( esc_html( self::excerpt( $i['text'], 'liste' === $a['darstellung'] ? 400 : 220 ) ) ) . '</p>';
			}
			if ( $link ) {
				$h .= '<a class="bcl-social-link" href="' . esc_url( $link ) . '" target="_blank" rel="noopener noreferrer">' . esc_html( sprintf( 'Auf %s ansehen', $net ) ) . '<span class="bcl-sr"> (öffnet ' . esc_html( $net ) . ' in neuem Fenster)</span></a>';
			}
			$h .= '</div></li>';
		}
		return $h . '</ul></section>';
	}

	public static function blocks(): void {
		register_block_type(
			'blaulichtcms/social',
			array(
				'api_version'     => 3,
				'title'           => 'BlaulichtCMS: Social-Feed',
				'category'        => 'widgets',
				'editor_script'   => 'blaulichtcms-bridge-blocks',
				'attributes'      => array(
					'anzahl'      => array(
						'type'    => 'string',
						'default' => '',
					),
					'darstellung' => array(
						'type'    => 'string',
						'default' => '',
					),
					'netzwerk'    => array(
						'type'    => 'string',
						'default' => '',
					),
					'text'        => array(
						'type'    => 'string',
						'default' => '',
					),
					'titel'       => array(
						'type'    => 'string',
						'default' => '',
					),
				),
				'render_callback' => static fn( $a ) => self::shortcode( array_filter( (array) $a, static fn( $v ) => '' !== $v && null !== $v ) ),
			)
		);
	}
}
