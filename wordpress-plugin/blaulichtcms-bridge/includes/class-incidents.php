<?php
/**
 * Einsatzliste (#213): Einträge aus BlaulichtCMS als eigener Inhaltstyp, Liste mit Filtern und Jahresübersicht,
 * Jahresstatistik mit Diagramm und Detailseite je Einsatz.
 *
 * Daten: Aufträge „incident.upsert“/„incident.delete“ aus BlaulichtCMS (nur freigegebene Fassungen). Jeder Eintrag ist
 * ein Beitrag vom Typ „blaulichtcms_einsatz“, gefunden über die BlaulichtCMS-ID (Meta „_bcl_id“) – erneutes Abholen
 * aktualisiert denselben Eintrag. Die Liste und die Statistik entstehen lokal in WordPress, auch ohne Verbindung.
 *
 * Darstellung: erbt Schrift und Farben des Themes; Akzent-, Kopfzeilen- und Kategorienfarben sowie Symbole sind in
 * „Einstellungen → BlaulichtCMS Einsatzliste“ einstellbar. Alles Weitere über Attribute der Shortcodes
 * [blaulichtcms_einsatzliste] und [blaulichtcms_einsatzstatistik] bzw. der gleichnamigen Blöcke.
 *
 * @package BlaulichtCMSBridge
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class BlaulichtCMS_Bridge_Incidents {
	const CPT     = 'blaulichtcms_einsatz';
	const OPTION  = 'blaulichtcms_bridge_incidents';
	const VERSION = 'blaulichtcms_bridge_incidents_rev';

	/** Spalten der Liste: Schlüssel → Überschrift. */
	const COLUMNS = array(
		'nr'        => 'Lfd.',
		'datum'     => 'Datum',
		'stichwort' => 'Einsatzart',
		'bedeutung' => 'Bedeutung',
		'kategorie' => 'Kategorie',
		'meldung'   => 'Einsatzmeldung',
		'ort'       => 'Einsatzort',
		'fahrzeuge' => 'Fahrzeuge',
		'kraefte'   => 'Weitere Kräfte',
		'bild'      => 'Bild',
	);

	/** Symbole (eigene, einfache SVG-Pfade auf 24×24). */
	const ICONS = array(
		''         => 'kein Symbol',
		'feuer'    => 'Flamme',
		'technik'  => 'Werkzeug',
		'gefahr'   => 'Gefahrstoff',
		'wasser'   => 'Wasser',
		'verkehr'  => 'Fahrzeug',
		'tier'     => 'Tier',
		'alarm'    => 'Alarm',
		'rettung'  => 'Kreuz',
		'info'     => 'Information',
	);

	const ICON_PATHS = array(
		'feuer'   => 'M12 2c1 3.5 5 5.5 5 10a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5 0 2 1 3 2 3 0-3-1-5.5 1-8.5z',
		'technik' => 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z',
		'gefahr'  => 'M12 3 2 21h20L12 3zm0 6v6m0 2.5v.5',
		'wasser'  => 'M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z',
		'verkehr' => 'M5 16V11l2-5h10l2 5v5M5 16h14M5 16v2m14-2v2M7.5 13h.01M16.5 13h.01',
		'tier'    => 'M8 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm8 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM12 13c-3 0-5 3-5 5s2 2 5 2 5 0 5-2-2-5-5-5z',
		'alarm'   => 'M6 17h12l-1.5-2V10a4.5 4.5 0 0 0-9 0v5L6 17zm4 2a2 2 0 0 0 4 0',
		'rettung' => 'M9 3h6v6h6v6h-6v6H9v-6H3V9h6z',
		'info'    => 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 8v6m0-9.5v.5',
	);

	public static function boot(): void {
		add_action( 'init', array( __CLASS__, 'register' ) );
		add_action( 'init', array( __CLASS__, 'blocks' ) );
		add_shortcode( 'blaulichtcms_einsatzliste', array( __CLASS__, 'shortcode_list' ) );
		add_shortcode( 'blaulichtcms_einsatzstatistik', array( __CLASS__, 'shortcode_stats' ) );
		add_filter( 'the_content', array( __CLASS__, 'detail_content' ) );
		add_action( 'wp_enqueue_scripts', array( __CLASS__, 'assets' ) );
		add_action( 'template_redirect', array( __CLASS__, 'detail_guard' ) );
	}

	/* ------------------------------------------------------------------ Einstellungen */

	public static function defaults(): array {
		return array(
			'columns'     => array( 'nr', 'datum', 'stichwort', 'meldung', 'ort', 'fahrzeuge', 'kraefte' ),
			'sort'        => 'desc',
			'per_page'    => 20,
			'filters'     => array( 'jahr', 'kategorie' ),
			'display'     => 'tabelle',
			'group'       => 'keine',
			'year'        => 'aktuell',
			'detail'      => true,
			'slug'        => 'einsatz',
			'accent'      => '',
			'head_bg'     => '',
			'head_fg'     => '',
			'stats_views' => array( 'summe', 'monate', 'kategorien' ),
			'categories'  => array(),
		);
	}

	public static function settings(): array {
		$s = get_option( self::OPTION, array() );
		return array_merge( self::defaults(), is_array( $s ) ? $s : array() );
	}

	/** Eingaben der Einstellungsseite prüfen. */
	public static function sanitize_settings( array $in ): array {
		$d   = self::defaults();
		$col = array_values( array_intersect( array_map( 'sanitize_key', (array) ( $in['columns'] ?? array() ) ), array_keys( self::COLUMNS ) ) );
		$cats = array();
		foreach ( (array) ( $in['categories'] ?? array() ) as $row ) {
			$name = sanitize_text_field( (string) ( $row['name'] ?? '' ) );
			if ( '' === $name ) {
				continue;
			}
			$cats[ $name ] = array(
				'color' => (string) ( sanitize_hex_color( (string) ( $row['color'] ?? '' ) ) ?? '' ),
				'icon'  => array_key_exists( (string) ( $row['icon'] ?? '' ), self::ICONS ) ? (string) $row['icon'] : '',
			);
		}
		$slug = sanitize_title( (string) ( $in['slug'] ?? '' ) );
		return array(
			'columns'     => $col ? $col : $d['columns'],
			'sort'        => 'asc' === ( $in['sort'] ?? '' ) ? 'asc' : 'desc',
			'per_page'    => max( 1, min( 200, (int) ( $in['per_page'] ?? 20 ) ) ),
			'filters'     => array_values( array_intersect( (array) ( $in['filters'] ?? array() ), array( 'jahr', 'kategorie' ) ) ),
			'display'     => 'karten' === ( $in['display'] ?? '' ) ? 'karten' : 'tabelle',
			'group'       => 'jahr' === ( $in['group'] ?? '' ) ? 'jahr' : 'keine',
			'year'        => in_array( $in['year'] ?? '', array( 'aktuell', 'alle' ), true ) ? $in['year'] : 'aktuell',
			'detail'      => ! empty( $in['detail'] ),
			'slug'        => '' !== $slug ? substr( $slug, 0, 40 ) : 'einsatz',
			'accent'      => (string) ( sanitize_hex_color( (string) ( $in['accent'] ?? '' ) ) ?? '' ),
			'head_bg'     => (string) ( sanitize_hex_color( (string) ( $in['head_bg'] ?? '' ) ) ?? '' ),
			'head_fg'     => (string) ( sanitize_hex_color( (string) ( $in['head_fg'] ?? '' ) ) ?? '' ),
			'stats_views' => array_values( array_intersect( (array) ( $in['stats_views'] ?? array() ), array( 'summe', 'monate', 'kategorien', 'jahre' ) ) ),
			'categories'  => $cats,
		);
	}

	/* ------------------------------------------------------------------ Inhaltstyp */

	public static function register(): void {
		$s      = self::settings();
		$detail = ! empty( $s['detail'] );
		register_post_type(
			self::CPT,
			array(
				'labels'              => array(
					'name'          => 'Einsätze',
					'singular_name' => 'Einsatz',
				),
				'public'              => $detail,
				'publicly_queryable'  => $detail,
				'exclude_from_search' => ! $detail,
				'show_ui'             => false,
				'show_in_nav_menus'   => false,
				'show_in_rest'        => false,
				'has_archive'         => false,
				'rewrite'             => array(
					'slug'       => $s['slug'],
					'with_front' => false,
				),
				'supports'            => array( 'title', 'editor', 'thumbnail' ),
			)
		);
		// Permalinks nach einer Änderung von Detailseite oder Adresse neu aufbauen (einmalig)
		$sig = md5( $s['slug'] . '|' . ( $detail ? 1 : 0 ) );
		if ( get_option( 'blaulichtcms_bridge_incidents_rewrite' ) !== $sig ) {
			flush_rewrite_rules( false );
			update_option( 'blaulichtcms_bridge_incidents_rewrite', $sig, true );
		}
	}

	/** Detailseiten aus: Aufrufe einer Einzelseite enden mit 404. */
	public static function detail_guard(): void {
		if ( is_singular( self::CPT ) && empty( self::settings()['detail'] ) ) {
			global $wp_query;
			$wp_query->set_404();
			status_header( 404 );
		}
	}

	public static function find( string $id ): int {
		$q = new WP_Query(
			array(
				'post_type'        => self::CPT,
				'post_status'      => 'any',
				'posts_per_page'   => 1,
				'fields'           => 'ids',
				'no_found_rows'    => true,
				'suppress_filters' => true,
				'meta_key'         => '_bcl_id', // phpcs:ignore WordPress.DB.SlowDBQuery
				'meta_value'       => $id,       // phpcs:ignore WordPress.DB.SlowDBQuery
			)
		);
		return $q->posts ? (int) $q->posts[0] : 0;
	}

	private static function bump(): void {
		update_option( self::VERSION, (int) get_option( self::VERSION, 0 ) + 1, true );
		BlaulichtCMS_Bridge_Banners::purge_cache();
	}

	private static function text( $v, int $max ): string {
		$s = sanitize_text_field( (string) $v );
		return function_exists( 'mb_substr' ) ? mb_substr( $s, 0, $max ) : substr( $s, 0, $max );
	}

	/**
	 * Eintrag anlegen oder aktualisieren.
	 *
	 * @return array|WP_Error
	 */
	public static function upsert( array $job ) {
		$e  = (array) ( $job['incident'] ?? array() );
		$id = sanitize_text_field( (string) ( $e['id'] ?? '' ) );
		$ts = strtotime( (string) ( $e['alarm_at'] ?? '' ) );
		if ( '' === $id || ! $ts || '' === trim( (string) ( $e['title'] ?? '' ) ) ) {
			return new WP_Error( 'blaulichtcms_job_invalid', 'Einsatz-Auftrag ist unvollständig.' );
		}
		$post_id = self::find( $id );
		$before  = $post_id ? BlaulichtCMS_Bridge_Publisher::used_media( $post_id ) : array();
		$local   = wp_date( 'Y-m-d H:i:s', $ts );
		$data    = array(
			'post_type'     => self::CPT,
			'post_title'    => self::text( $e['title'], 200 ),
			'post_content'  => wpautop( esc_html( (string) ( $e['report'] ?? '' ) ) ),
			'post_date'     => $local,
			'post_date_gmt' => gmdate( 'Y-m-d H:i:s', $ts ),
			'post_name'     => sanitize_title( wp_date( 'Y-m-d', $ts ) . '-' . (string) $e['title'] ),
		);
		if ( ! $post_id ) {
			$r = wp_insert_post( wp_slash( $data + array( 'post_status' => 'draft' ) ), true );
			if ( is_wp_error( $r ) ) {
				return $r;
			}
			$post_id = (int) $r;
			update_post_meta( $post_id, '_bcl_id', $id );
		}
		$images = array();
		$cover  = (string) ( $e['cover_media_id'] ?? '' );
		$cover_id = 0;
		foreach ( (array) ( $job['media'] ?? array() ) as $m ) {
			if ( 'image' !== ( $m['kind'] ?? '' ) ) {
				continue;
			}
			$att = BlaulichtCMS_Bridge_Publisher::import_media( (array) $m, $post_id );
			if ( is_wp_error( $att ) ) {
				return $att;
			}
			$images[] = (int) $att;
			if ( $cover === (string) $m['id'] ) {
				$cover_id = (int) $att;
			}
		}
		$data['ID']          = $post_id;
		$data['post_status'] = 'publish';
		$r                   = wp_update_post( wp_slash( $data ), true );
		if ( is_wp_error( $r ) ) {
			return $r;
		}
		$meta = array(
			'_bcl_alarm'         => (int) $ts,
			'_bcl_year'          => (int) wp_date( 'Y', $ts ),
			'_bcl_month'         => (int) wp_date( 'n', $ts ),
			'_bcl_number'        => max( 0, (int) ( $e['number'] ?? 0 ) ),
			'_bcl_keyword'       => self::text( $e['keyword'] ?? '', 60 ),
			'_bcl_keyword_label' => self::text( $e['keyword_label'] ?? '', 200 ),
			'_bcl_category'      => self::text( $e['category'] ?? '', 60 ),
			'_bcl_location'      => self::text( $e['location'] ?? '', 80 ),
			'_bcl_vehicles'      => self::text( $e['vehicles'] ?? '', 500 ),
			'_bcl_units'         => self::text( $e['units'] ?? '', 500 ),
			'_bcl_link'          => esc_url_raw( (string) ( $e['link_url'] ?? '' ), array( 'http', 'https' ) ),
			'_bcl_featured'      => ! empty( $e['featured'] ) ? 1 : 0,
			'_bcl_false_alarm'   => ! empty( $e['false_alarm'] ) ? 1 : 0,
			'_bcl_revision'      => (int) ( $e['revision'] ?? 0 ),
			'_bcl_images'        => $images,
		);
		foreach ( $meta as $k => $v ) {
			update_post_meta( $post_id, $k, $v );
		}
		delete_post_meta( $post_id, BlaulichtCMS_Bridge_Publisher::WITHDRAWN_META );
		$now = array_map( static fn( $m ) => (string) ( $m['id'] ?? '' ), (array) ( $job['media'] ?? array() ) );
		BlaulichtCMS_Bridge_Publisher::set_used_media( $post_id, $now );
		if ( $cover_id ) {
			set_post_thumbnail( $post_id, $cover_id );
		} else {
			delete_post_thumbnail( $post_id );
		}
		BlaulichtCMS_Bridge_Publisher::delete_unused_media( array_diff( $before, $now ), $post_id );
		self::bump();
		return array(
			'remote_id'     => $post_id,
			'url'           => ! empty( self::settings()['detail'] ) ? (string) get_permalink( $post_id ) : '',
			'remote_status' => 'publish',
		);
	}

	/**
	 * Eintrag entfernen (endgültig, samt nicht anderweitig verwendeter Bilder). Nicht vorhanden gilt als erledigt.
	 *
	 * @return array
	 */
	public static function delete( array $job ): array {
		$id      = sanitize_text_field( (string) ( $job['incident']['id'] ?? '' ) );
		$post_id = '' !== $id ? self::find( $id ) : 0;
		if ( $post_id ) {
			update_post_meta( $post_id, BlaulichtCMS_Bridge_Publisher::WITHDRAWN_META, time() );
			$media = array_merge( BlaulichtCMS_Bridge_Publisher::used_media( $post_id ), array_map( 'strval', (array) ( $job['media_ids'] ?? array() ) ) );
			BlaulichtCMS_Bridge_Publisher::delete_unused_media( $media, $post_id );
			wp_delete_post( $post_id, true );
			self::bump();
		}
		return array(
			'remote_id'     => $post_id,
			'url'           => '',
			'remote_status' => $post_id ? 'deleted' : 'missing',
		);
	}

	/* ------------------------------------------------------------------ Daten lesen */

	/** Ein Eintrag als Feldliste (für Liste, Karten und Detailseite). */
	public static function row( WP_Post $p ): array {
		$m = static fn( string $k ) => get_post_meta( $p->ID, $k, true );
		return array(
			'post'          => $p,
			'id'            => $p->ID,
			'ts'            => (int) $m( '_bcl_alarm' ),
			'year'          => (int) $m( '_bcl_year' ),
			'month'         => (int) $m( '_bcl_month' ),
			'number'        => (int) $m( '_bcl_number' ),
			'keyword'       => (string) $m( '_bcl_keyword' ),
			'keyword_label' => (string) $m( '_bcl_keyword_label' ),
			'category'      => (string) $m( '_bcl_category' ),
			'title'         => get_the_title( $p ),
			'location'      => (string) $m( '_bcl_location' ),
			'vehicles'      => (string) $m( '_bcl_vehicles' ),
			'units'         => (string) $m( '_bcl_units' ),
			'link'          => (string) $m( '_bcl_link' ),
			'featured'      => (bool) $m( '_bcl_featured' ),
			'false_alarm'   => (bool) $m( '_bcl_false_alarm' ),
			'images'        => array_values( array_filter( array_map( 'intval', (array) $m( '_bcl_images' ) ) ) ),
			'report'        => (string) $p->post_content,
		);
	}

	/** Jahre mit Einträgen (absteigend). */
	public static function years(): array {
		global $wpdb;
		$rows = $wpdb->get_col(
			$wpdb->prepare(
				"SELECT DISTINCT m.meta_value FROM {$wpdb->postmeta} m JOIN {$wpdb->posts} p ON p.ID = m.post_id WHERE m.meta_key = '_bcl_year' AND p.post_type = %s AND p.post_status = 'publish' ORDER BY m.meta_value DESC",
				self::CPT
			)
		);
		return array_values( array_filter( array_map( 'intval', (array) $rows ) ) );
	}

	/** Kategorien mit Einträgen. */
	public static function categories(): array {
		global $wpdb;
		$rows = $wpdb->get_col(
			$wpdb->prepare(
				"SELECT DISTINCT m.meta_value FROM {$wpdb->postmeta} m JOIN {$wpdb->posts} p ON p.ID = m.post_id WHERE m.meta_key = '_bcl_category' AND m.meta_value <> '' AND p.post_type = %s AND p.post_status = 'publish' ORDER BY m.meta_value",
				self::CPT
			)
		);
		return array_map( 'strval', (array) $rows );
	}

	/**
	 * Einträge abfragen.
	 *
	 * @return array{rows: array, total: int, pages: int}
	 */
	public static function query( array $a ): array {
		$meta = array();
		if ( ! empty( $a['year'] ) ) {
			$meta[] = array(
				'key'   => '_bcl_year',
				'value' => (int) $a['year'],
				'type'  => 'NUMERIC',
			);
		}
		if ( ! empty( $a['category'] ) ) {
			$meta[] = array(
				'key'   => '_bcl_category',
				'value' => (string) $a['category'],
			);
		}
		if ( ! empty( $a['featured'] ) ) {
			$meta[] = array(
				'key'   => '_bcl_featured',
				'value' => 1,
				'type'  => 'NUMERIC',
			);
		}
		$per = (int) ( $a['per_page'] ?? 20 );
		$q   = new WP_Query(
			array(
				'post_type'      => self::CPT,
				'post_status'    => 'publish',
				'posts_per_page' => $per > 0 ? $per : -1,
				'paged'          => max( 1, (int) ( $a['page'] ?? 1 ) ),
				'meta_query'     => $meta, // phpcs:ignore WordPress.DB.SlowDBQuery
				'meta_key'       => '_bcl_alarm', // phpcs:ignore WordPress.DB.SlowDBQuery
				'orderby'        => 'meta_value_num',
				'order'          => 'asc' === ( $a['sort'] ?? 'desc' ) ? 'ASC' : 'DESC',
				'no_found_rows'  => $per <= 0,
			)
		);
		$rows = array_map( array( __CLASS__, 'row' ), $q->posts );
		self::fill_numbers( $rows );
		return array(
			'rows'  => $rows,
			'total' => $per > 0 ? (int) $q->found_posts : count( $rows ),
			'pages' => $per > 0 ? (int) $q->max_num_pages : 1,
		);
	}

	/** Laufende Nummer je Jahr: angegebene Nummer, sonst Platz nach Alarmzeit im Jahr. */
	private static function fill_numbers( array &$rows ): void {
		static $cache = array();
		foreach ( $rows as &$r ) {
			if ( $r['number'] > 0 || ! $r['year'] ) {
				continue;
			}
			if ( ! isset( $cache[ $r['year'] ] ) ) {
				$ids                  = get_posts(
					array(
						'post_type'      => self::CPT,
						'post_status'    => 'publish',
						'posts_per_page' => -1,
						'fields'         => 'ids',
						'meta_key'       => '_bcl_alarm', // phpcs:ignore WordPress.DB.SlowDBQuery
						'orderby'        => 'meta_value_num',
						'order'          => 'ASC',
						'meta_query'     => array( array( 'key' => '_bcl_year', 'value' => $r['year'], 'type' => 'NUMERIC' ) ), // phpcs:ignore WordPress.DB.SlowDBQuery
					)
				);
				$cache[ $r['year'] ] = array_flip( array_map( 'intval', $ids ) );
			}
			$r['number'] = isset( $cache[ $r['year'] ][ $r['id'] ] ) ? $cache[ $r['year'] ][ $r['id'] ] + 1 : 0;
		}
	}

	/**
	 * Zahlen für die Statistik (zwischengespeichert bis zur nächsten Änderung).
	 *
	 * @return array{years: array<int,int>, months: array<int,array<int,int>>, categories: array<int,array<string,int>>, false_alarms: array<int,int>}
	 */
	public static function stats(): array {
		$key = 'blaulichtcms_bcl_stats_' . (int) get_option( self::VERSION, 0 );
		$c   = get_transient( $key );
		if ( is_array( $c ) ) {
			return $c;
		}
		global $wpdb;
		$rows = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT y.meta_value AS y, mo.meta_value AS m, COALESCE(c.meta_value, '') AS c, COALESCE(f.meta_value, '0') AS f, COUNT(*) AS n
				   FROM {$wpdb->posts} p
				   JOIN {$wpdb->postmeta} y ON y.post_id = p.ID AND y.meta_key = '_bcl_year'
				   JOIN {$wpdb->postmeta} mo ON mo.post_id = p.ID AND mo.meta_key = '_bcl_month'
				   LEFT JOIN {$wpdb->postmeta} c ON c.post_id = p.ID AND c.meta_key = '_bcl_category'
				   LEFT JOIN {$wpdb->postmeta} f ON f.post_id = p.ID AND f.meta_key = '_bcl_false_alarm'
				  WHERE p.post_type = %s AND p.post_status = 'publish'
				  GROUP BY y.meta_value, mo.meta_value, c.meta_value, f.meta_value",
				self::CPT
			),
			ARRAY_A
		);
		$out = array(
			'years'        => array(),
			'months'       => array(),
			'categories'   => array(),
			'false_alarms' => array(),
		);
		foreach ( (array) $rows as $r ) {
			$y = (int) $r['y'];
			$n = (int) $r['n'];
			$out['years'][ $y ]                     = ( $out['years'][ $y ] ?? 0 ) + $n;
			$out['months'][ $y ][ (int) $r['m'] ]   = ( $out['months'][ $y ][ (int) $r['m'] ] ?? 0 ) + $n;
			$cat                                    = '' !== $r['c'] ? (string) $r['c'] : 'Ohne Kategorie';
			$out['categories'][ $y ][ $cat ]        = ( $out['categories'][ $y ][ $cat ] ?? 0 ) + $n;
			$out['false_alarms'][ $y ]              = ( $out['false_alarms'][ $y ] ?? 0 ) + ( '1' === (string) $r['f'] ? $n : 0 );
		}
		krsort( $out['years'] );
		set_transient( $key, $out, DAY_IN_SECONDS );
		return $out;
	}

	/* ------------------------------------------------------------------ Darstellung */

	public static function assets(): void {
		wp_register_style( 'blaulichtcms-bridge-incidents', plugins_url( 'assets/incidents.css', BLAULICHTCMS_BRIDGE_FILE ), array(), BLAULICHTCMS_BRIDGE_VERSION );
		wp_add_inline_style( 'blaulichtcms-bridge-incidents', self::inline_css() );
		if ( is_singular( self::CPT ) ) {
			wp_enqueue_style( 'blaulichtcms-bridge-incidents' );
		}
	}

	/** Farben aus den Einstellungen als CSS-Variablen; leer = Theme bzw. Grundfarbe des Stylesheets. */
	public static function inline_css(): string {
		$s    = self::settings();
		$vars = array();
		if ( $s['accent'] ) {
			$vars[] = '--bcl-accent:' . $s['accent'];
		}
		if ( $s['head_bg'] ) {
			$vars[] = '--bcl-head-bg:' . $s['head_bg'];
		}
		if ( $s['head_fg'] ) {
			$vars[] = '--bcl-head-fg:' . $s['head_fg'];
		}
		return $vars ? '.bcl{' . implode( ';', $vars ) . '}' : '';
	}

	private static function enqueue(): void {
		if ( ! wp_style_is( 'blaulichtcms-bridge-incidents', 'registered' ) ) {
			self::assets();
		}
		wp_enqueue_style( 'blaulichtcms-bridge-incidents' );
	}

	public static function icon( string $name ): string {
		if ( ! isset( self::ICON_PATHS[ $name ] ) ) {
			return '';
		}
		return '<svg class="bcl-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path d="' . esc_attr( self::ICON_PATHS[ $name ] ) . '"/></svg>';
	}

	/** Kategorie als Kennzeichnung mit Farbe und Symbol (Farbe nie allein: der Name steht immer daneben). */
	public static function badge( string $cat ): string {
		if ( '' === $cat ) {
			return '';
		}
		$conf  = self::settings()['categories'][ $cat ] ?? array();
		$style = ! empty( $conf['color'] ) ? ' style="--bcl-cat:' . esc_attr( $conf['color'] ) . '"' : '';
		return '<span class="bcl-cat"' . $style . '>' . self::icon( (string) ( $conf['icon'] ?? '' ) ) . esc_html( $cat ) . '</span>';
	}

	private static function bool( $v ): bool {
		return in_array( strtolower( (string) $v ), array( '1', 'ja', 'true', 'an', 'yes' ), true );
	}

	/** Attribute des Shortcodes mit den Einstellungen als Vorgabe. */
	public static function list_atts( $atts ): array {
		$s = self::settings();
		$a = shortcode_atts(
			array(
				'jahr'          => $s['year'],
				'kategorie'     => '',
				'spalten'       => implode( ',', $s['columns'] ),
				'sortierung'    => 'asc' === $s['sort'] ? 'aufsteigend' : 'absteigend',
				'anzahl'        => (string) $s['per_page'],
				'filter'        => $s['filters'] ? implode( ',', $s['filters'] ) : 'aus',
				'darstellung'   => $s['display'],
				'gruppierung'   => $s['group'],
				'detail'        => $s['detail'] ? 'ja' : 'nein',
				'nur_besondere' => 'nein',
				'titel'         => '',
			),
			is_array( $atts ) ? $atts : array(),
			'blaulichtcms_einsatzliste'
		);
		$cols = array_values( array_intersect( array_map( 'trim', explode( ',', strtolower( (string) $a['spalten'] ) ) ), array_keys( self::COLUMNS ) ) );
		return array(
			'year'      => (string) $a['jahr'],
			'category'  => sanitize_text_field( (string) $a['kategorie'] ),
			'columns'   => $cols ? $cols : $s['columns'],
			'sort'      => in_array( strtolower( (string) $a['sortierung'] ), array( 'aufsteigend', 'asc' ), true ) ? 'asc' : 'desc',
			'per_page'  => max( 0, min( 500, (int) $a['anzahl'] ) ),
			'filters'   => array_values( array_intersect( array_map( 'trim', explode( ',', strtolower( (string) $a['filter'] ) ) ), array( 'jahr', 'kategorie' ) ) ),
			'display'   => 'karten' === strtolower( (string) $a['darstellung'] ) ? 'karten' : 'tabelle',
			'group'     => 'jahr' === strtolower( (string) $a['gruppierung'] ) ? 'jahr' : 'keine',
			'detail'    => self::bool( $a['detail'] ) && ! empty( $s['detail'] ),
			'featured'  => self::bool( $a['nur_besondere'] ),
			'title'     => sanitize_text_field( (string) $a['titel'] ),
		);
	}

	/** Gewähltes Jahr: Filter der Seite, sonst Attribut („aktuell“ = neuestes Jahr mit Einträgen, „alle“ = ohne). */
	private static function resolve_year( string $attr, array $years, bool $filterable ): int {
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- öffentlicher Filter ohne Wirkung
		if ( $filterable && isset( $_GET['bcl_jahr'] ) ) {
			$y = absint( wp_unslash( $_GET['bcl_jahr'] ) ); // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			return in_array( $y, $years, true ) ? $y : 0;
		}
		if ( 'alle' === $attr ) {
			return 0;
		}
		if ( ctype_digit( $attr ) ) {
			return (int) $attr;
		}
		return $years ? (int) $years[0] : (int) wp_date( 'Y' );
	}

	public static function shortcode_list( $atts = array() ): string {
		self::enqueue();
		$a = self::list_atts( $atts );
		return self::render_list( $a );
	}

	/**
	 * Liste ausgeben.
	 *
	 * @param array      $a    Aufbereitete Attribute (list_atts()).
	 * @param array|null $demo Beispieldaten für die Vorschau ohne Einträge.
	 */
	public static function render_list( array $a, ?array $demo = null ): string {
		$years = null === $demo ? self::years() : array( (int) wp_date( 'Y' ) );
		$fy    = in_array( 'jahr', $a['filters'], true );
		$fc    = in_array( 'kategorie', $a['filters'], true );
		$year  = self::resolve_year( $a['year'], $years, $fy );
		// phpcs:disable WordPress.Security.NonceVerification.Recommended -- öffentliche Filter ohne Wirkung
		$cat  = $fc && isset( $_GET['bcl_kat'] ) ? sanitize_text_field( wp_unslash( $_GET['bcl_kat'] ) ) : $a['category'];
		$page = isset( $_GET['bcl_seite'] ) ? max( 1, absint( wp_unslash( $_GET['bcl_seite'] ) ) ) : 1;
		// phpcs:enable
		$out = '<div class="bcl bcl-list">';
		if ( '' !== $a['title'] ) {
			$out .= '<h2 class="bcl-heading">' . esc_html( $a['title'] ) . '</h2>';
		}
		if ( ( $fy || $fc ) && 'jahr' !== $a['group'] ) {
			$out .= self::filter_form( $fy ? $years : array(), $fc ? ( null === $demo ? self::categories() : array_unique( array_column( $demo, 'category' ) ) ) : array(), $year, $cat );
		}
		if ( 'jahr' === $a['group'] ) {
			// Jahresübersicht: je Jahr ein aufklappbarer Abschnitt (das neueste offen)
			$list = $year && ctype_digit( $a['year'] ) ? array( $year ) : $years;
			if ( ! $list ) {
				return $out . '<p class="bcl-empty">Noch keine Einsätze.</p></div>';
			}
			foreach ( $list as $i => $y ) {
				$res  = null === $demo ? self::query( array( 'year' => $y, 'category' => $cat, 'sort' => $a['sort'], 'per_page' => 0, 'featured' => $a['featured'] ) ) : array( 'rows' => $demo, 'total' => count( $demo ) );
				$out .= '<details class="bcl-year"' . ( 0 === $i ? ' open' : '' ) . '><summary><span>Einsätze ' . (int) $y . '</span><span class="bcl-count">' . (int) $res['total'] . '</span></summary>';
				$out .= self::render_rows( $res['rows'], $a, sprintf( 'Einsätze %d', $y ) ) . '</details>';
			}
			return $out . '</div>';
		}
		$res = null === $demo ? self::query( array( 'year' => $year, 'category' => $cat, 'sort' => $a['sort'], 'per_page' => $a['per_page'], 'page' => $page, 'featured' => $a['featured'] ) ) : array( 'rows' => $demo, 'total' => count( $demo ), 'pages' => 1 );
		if ( ! $res['rows'] ) {
			return $out . '<p class="bcl-empty">Keine Einsätze gefunden.</p></div>';
		}
		$caption = trim( 'Einsätze' . ( $year ? ' ' . $year : '' ) . ( '' !== $cat ? ' – ' . $cat : '' ) );
		$out    .= self::render_rows( $res['rows'], $a, $caption );
		if ( $res['pages'] > 1 ) {
			$out .= self::pagination( $page, (int) $res['pages'] );
		}
		return $out . '</div>';
	}

	private static function filter_form( array $years, array $cats, int $year, string $cat ): string {
		$h = '<form class="bcl-filter" method="get" role="search" aria-label="Einsätze filtern">';
		// Andere Parameter der Seite erhalten (z. B. page_id ohne schöne Permalinks)
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended
		foreach ( $_GET as $k => $v ) {
			if ( is_string( $v ) && ! in_array( $k, array( 'bcl_jahr', 'bcl_kat', 'bcl_seite' ), true ) ) {
				$h .= '<input type="hidden" name="' . esc_attr( sanitize_key( $k ) ) . '" value="' . esc_attr( sanitize_text_field( wp_unslash( $v ) ) ) . '">';
			}
		}
		if ( $years ) {
			$h .= '<label><span>Jahr</span><select name="bcl_jahr">';
			foreach ( $years as $y ) {
				$h .= '<option value="' . (int) $y . '"' . selected( $year, $y, false ) . '>' . (int) $y . '</option>';
			}
			$h .= '<option value="0"' . selected( $year, 0, false ) . '>Alle Jahre</option></select></label>';
		}
		if ( $cats ) {
			$h .= '<label><span>Kategorie</span><select name="bcl_kat"><option value="">Alle</option>';
			foreach ( $cats as $c ) {
				$h .= '<option value="' . esc_attr( $c ) . '"' . selected( $cat, $c, false ) . '>' . esc_html( $c ) . '</option>';
			}
			$h .= '</select></label>';
		}
		return $h . '<button type="submit">Anzeigen</button></form>';
	}

	private static function pagination( int $page, int $pages ): string {
		$h = '<nav class="bcl-pages" aria-label="Seiten der Einsatzliste"><ul>';
		for ( $i = 1; $i <= $pages; $i++ ) {
			$url = esc_url( add_query_arg( 'bcl_seite', $i ) );
			$h  .= $i === $page ? '<li><span aria-current="page">' . $i . '</span></li>' : '<li><a href="' . $url . '">' . $i . '</a></li>';
		}
		return $h . '</ul></nav>';
	}

	private static function cell( string $col, array $r, bool $detail ): string {
		switch ( $col ) {
			case 'nr':
				return $r['number'] ? (string) $r['number'] : '–';
			case 'datum':
				return '<time datetime="' . esc_attr( gmdate( 'c', $r['ts'] ) ) . '">' . esc_html( wp_date( 'd.m.Y', $r['ts'] ) ) . ' <span class="bcl-time">' . esc_html( wp_date( 'H:i', $r['ts'] ) ) . '</span></time>';
			case 'stichwort':
				return esc_html( $r['keyword'] ) . ( '' !== $r['keyword_label'] ? '<span class="bcl-sub">' . esc_html( $r['keyword_label'] ) . '</span>' : '' );
			case 'bedeutung':
				return esc_html( $r['keyword_label'] );
			case 'kategorie':
				return self::badge( $r['category'] );
			case 'meldung':
				$t     = esc_html( $r['title'] );
				$t     = $detail && ! empty( $r['post'] ) ? '<a href="' . esc_url( get_permalink( $r['post'] ) ) . '">' . $t . '</a>' : $t;
				$flags = ( $r['featured'] ? '<span class="bcl-flag bcl-flag-special">Besonderer Einsatz</span>' : '' ) . ( $r['false_alarm'] ? '<span class="bcl-flag">Fehlalarm</span>' : '' );
				return $t . $flags;
			case 'ort':
				return esc_html( $r['location'] );
			case 'fahrzeuge':
				return esc_html( $r['vehicles'] );
			case 'kraefte':
				return esc_html( $r['units'] );
			case 'bild':
				return $r['images'] ? wp_get_attachment_image( $r['images'][0], 'thumbnail', false, array( 'class' => 'bcl-thumb' ) ) : '';
		}
		return '';
	}

	private static function render_rows( array $rows, array $a, string $caption ): string {
		if ( ! $rows ) {
			return '<p class="bcl-empty">Keine Einsätze.</p>';
		}
		if ( 'karten' === $a['display'] ) {
			$h = '<ul class="bcl-cards" aria-label="' . esc_attr( $caption ) . '">';
			foreach ( $rows as $r ) {
				$h .= '<li class="bcl-card' . ( $r['featured'] ? ' is-special' : '' ) . '"><article>';
				if ( in_array( 'bild', $a['columns'], true ) && $r['images'] ) {
					$h .= wp_get_attachment_image( $r['images'][0], 'medium', false, array( 'class' => 'bcl-card-img' ) );
				}
				$h .= '<div class="bcl-card-body"><p class="bcl-card-meta">' . self::cell( 'datum', $r, false ) . ( $r['number'] && in_array( 'nr', $a['columns'], true ) ? ' · Nr. ' . (int) $r['number'] : '' ) . '</p>';
				$h .= '<h3 class="bcl-card-title">' . self::cell( 'meldung', $r, $a['detail'] ) . '</h3><dl class="bcl-facts">';
				foreach ( $a['columns'] as $c ) {
					if ( in_array( $c, array( 'nr', 'datum', 'meldung', 'bild' ), true ) ) {
						continue;
					}
					$v = self::cell( $c, $r, false );
					if ( '' !== trim( wp_strip_all_tags( $v ) ) ) {
						$h .= '<div><dt>' . esc_html( self::COLUMNS[ $c ] ) . '</dt><dd>' . $v . '</dd></div>';
					}
				}
				$h .= '</dl></div></article></li>';
			}
			return $h . '</ul>';
		}
		$h = '<div class="bcl-table-wrap"><table class="bcl-table"><caption class="bcl-sr">' . esc_html( $caption ) . '</caption><thead><tr>';
		foreach ( $a['columns'] as $c ) {
			$h .= '<th scope="col" class="bcl-col-' . esc_attr( $c ) . '">' . esc_html( self::COLUMNS[ $c ] ) . '</th>';
		}
		$h .= '</tr></thead><tbody>';
		foreach ( $rows as $r ) {
			$h .= '<tr' . ( $r['featured'] ? ' class="is-special"' : '' ) . '>';
			foreach ( $a['columns'] as $c ) {
				$h .= '<td class="bcl-col-' . esc_attr( $c ) . '" data-label="' . esc_attr( self::COLUMNS[ $c ] ) . '">' . self::cell( $c, $r, $a['detail'] ) . '</td>';
			}
			$h .= '</tr>';
		}
		return $h . '</tbody></table></div>';
	}

	/* ------------------------------------------------------------------ Statistik */

	const MONTHS = array( 1 => 'Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez' );
	const MONTHS_LONG = array( 1 => 'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember' );

	public static function stats_atts( $atts ): array {
		$s = self::settings();
		$a = shortcode_atts(
			array(
				'jahr'      => 'aktuell',
				'ansicht'   => $s['stats_views'] ? implode( ',', $s['stats_views'] ) : 'summe,monate,kategorien',
				'diagramm'  => 'balken',
				'auswahl'   => 'ja',
				'titel'     => '',
			),
			is_array( $atts ) ? $atts : array(),
			'blaulichtcms_einsatzstatistik'
		);
		$views = array_values( array_intersect( array_map( 'trim', explode( ',', strtolower( (string) $a['ansicht'] ) ) ), array( 'summe', 'monate', 'kategorien', 'jahre' ) ) );
		return array(
			'year'   => (string) $a['jahr'],
			'views'  => $views ? $views : array( 'summe', 'monate', 'kategorien' ),
			'chart'  => 'aus' !== strtolower( (string) $a['diagramm'] ),
			'select' => self::bool( $a['auswahl'] ),
			'title'  => sanitize_text_field( (string) $a['titel'] ),
		);
	}

	public static function shortcode_stats( $atts = array() ): string {
		self::enqueue();
		return self::render_stats( self::stats_atts( $atts ) );
	}

	/** Balken einer Reihe: Höhe/Breite relativ zum größten Wert, Wert als Text; Tabelle als Alternative. */
	private static function bars( array $data, string $label, bool $chart, bool $horizontal, array $colors = array() ): string {
		$max = $data ? max( 1, max( $data ) ) : 1;
		$h   = '<figure class="bcl-chart' . ( $horizontal ? ' is-horizontal' : '' ) . '"><figcaption>' . esc_html( $label ) . '</figcaption>';
		if ( $chart ) {
			$h .= '<ol class="bcl-bars" aria-hidden="true">';
			foreach ( $data as $k => $n ) {
				$pct   = round( 100 * $n / $max, 1 );
				$style = '--bcl-v:' . $pct . '%' . ( ! empty( $colors[ $k ] ) ? ';--bcl-bar:' . $colors[ $k ] : '' );
				$h    .= '<li title="' . esc_attr( $k . ': ' . $n ) . '"><span class="bcl-bar-label">' . esc_html( (string) $k ) . '</span><span class="bcl-bar-track"><span class="bcl-bar" style="' . esc_attr( $style ) . '"></span></span><span class="bcl-bar-value">' . (int) $n . '</span></li>';
			}
			$h .= '</ol><details class="bcl-as-table"><summary>Als Tabelle</summary>';
		}
		$h .= '<table class="bcl-table bcl-mini"><thead><tr><th scope="col">' . esc_html( $horizontal ? 'Kategorie' : 'Zeitraum' ) . '</th><th scope="col">Einsätze</th></tr></thead><tbody>';
		foreach ( $data as $k => $n ) {
			$h .= '<tr><td>' . esc_html( (string) $k ) . '</td><td>' . (int) $n . '</td></tr>';
		}
		$h .= '</tbody></table>' . ( $chart ? '</details>' : '' );
		return $h . '</figure>';
	}

	public static function render_stats( array $a, ?array $demo = null ): string {
		$st    = null === $demo ? self::stats() : $demo;
		$years = array_keys( $st['years'] );
		$year  = self::resolve_year( $a['year'], $years, $a['select'] );
		$out   = '<div class="bcl bcl-stats">';
		if ( '' !== $a['title'] ) {
			$out .= '<h2 class="bcl-heading">' . esc_html( $a['title'] ) . '</h2>';
		}
		if ( ! $years ) {
			return $out . '<p class="bcl-empty">Noch keine Einsätze.</p></div>';
		}
		if ( $a['select'] && count( $years ) > 1 && null === $demo ) {
			$out .= self::filter_form( $years, array(), $year, '' );
		}
		$cats = self::settings()['categories'];
		if ( in_array( 'summe', $a['views'], true ) ) {
			$total = $year ? (int) ( $st['years'][ $year ] ?? 0 ) : array_sum( $st['years'] );
			$prev  = $year ? (int) ( $st['years'][ $year - 1 ] ?? 0 ) : 0;
			$out  .= '<div class="bcl-total"><span class="bcl-total-n">' . (int) $total . '</span><span class="bcl-total-l">' . esc_html( $year ? 'Einsätze im Jahr ' . $year : 'Einsätze insgesamt' ) . '</span>';
			if ( $year && $prev ) {
				$out .= '<span class="bcl-total-prev">' . esc_html( sprintf( 'Vorjahr: %d', $prev ) ) . '</span>';
			}
			$fa = $year ? (int) ( $st['false_alarms'][ $year ] ?? 0 ) : array_sum( $st['false_alarms'] );
			if ( $fa ) {
				$out .= '<span class="bcl-total-prev">' . esc_html( sprintf( 'davon Fehlalarme: %d', $fa ) ) . '</span>';
			}
			$out .= '</div>';
		}
		if ( in_array( 'monate', $a['views'], true ) && $year ) {
			$m = array();
			foreach ( self::MONTHS as $i => $name ) {
				$m[ $name ] = (int) ( $st['months'][ $year ][ $i ] ?? 0 );
			}
			$out .= self::bars( $m, 'Einsätze je Monat ' . $year, $a['chart'], false );
		}
		if ( in_array( 'kategorien', $a['views'], true ) ) {
			$c = array();
			foreach ( $year ? array( $year ) : $years as $y ) {
				foreach ( (array) ( $st['categories'][ $y ] ?? array() ) as $k => $n ) {
					$c[ $k ] = ( $c[ $k ] ?? 0 ) + (int) $n;
				}
			}
			arsort( $c );
			$colors = array();
			foreach ( array_keys( $c ) as $k ) {
				$colors[ $k ] = (string) ( $cats[ $k ]['color'] ?? '' );
			}
			if ( $c ) {
				$out .= self::bars( $c, 'Einsätze je Kategorie' . ( $year ? ' ' . $year : '' ), $a['chart'], true, $colors );
			}
		}
		if ( in_array( 'jahre', $a['views'], true ) ) {
			$y = $st['years'];
			ksort( $y );
			$out .= self::bars( $y, 'Einsätze je Jahr', $a['chart'], false );
		}
		return $out . '</div>';
	}

	/* ------------------------------------------------------------------ Detailseite */

	public static function detail_content( string $content ): string {
		if ( ! is_singular( self::CPT ) || ! in_the_loop() || ! is_main_query() ) {
			return $content;
		}
		$p = get_post();
		if ( ! $p || self::CPT !== $p->post_type ) {
			return $content;
		}
		$rows = array( self::row( $p ) );
		self::fill_numbers( $rows );
		$r     = $rows[0];
		$facts = array(
			'Datum'          => esc_html( wp_date( 'j. F Y \u\m H:i \U\h\r', $r['ts'] ) ),
			'Lfd. Nr.'       => $r['number'] ? (string) (int) $r['number'] : '',
			'Einsatzart'     => esc_html( trim( $r['keyword'] . ( '' !== $r['keyword_label'] ? ' – ' . $r['keyword_label'] : '' ), ' –' ) ),
			'Kategorie'      => self::badge( $r['category'] ),
			'Einsatzort'     => esc_html( $r['location'] ),
			'Fahrzeuge'      => esc_html( $r['vehicles'] ),
			'Weitere Kräfte' => esc_html( $r['units'] ),
		);
		$h = '<div class="bcl bcl-detail">';
		if ( $r['featured'] || $r['false_alarm'] ) {
			$h .= '<p>' . ( $r['featured'] ? '<span class="bcl-flag bcl-flag-special">Besonderer Einsatz</span>' : '' ) . ( $r['false_alarm'] ? '<span class="bcl-flag">Fehlalarm</span>' : '' ) . '</p>';
		}
		$h .= '<dl class="bcl-facts">';
		foreach ( $facts as $k => $v ) {
			if ( '' !== trim( wp_strip_all_tags( $v ) ) ) {
				$h .= '<div><dt>' . esc_html( $k ) . '</dt><dd>' . $v . '</dd></div>';
			}
		}
		$h .= '</dl>';
		if ( '' !== trim( wp_strip_all_tags( $content ) ) ) {
			$h .= '<div class="bcl-report">' . $content . '</div>';
		}
		$imgs = array_filter( $r['images'], static fn( $i ) => $i !== (int) get_post_thumbnail_id( $p ) || count( $r['images'] ) > 1 );
		if ( $imgs ) {
			$h .= '<div class="bcl-gallery">';
			foreach ( $imgs as $i ) {
				$h .= '<figure>' . wp_get_attachment_image( $i, 'large' ) . '</figure>';
			}
			$h .= '</div>';
		}
		if ( '' !== $r['link'] ) {
			$h .= '<p><a class="bcl-more" href="' . esc_url( $r['link'] ) . '">Ausführlicher Bericht</a></p>';
		}
		return $h . '</div>';
	}

	/* ------------------------------------------------------------------ Blöcke */

	public static function blocks(): void {
		$list = array(
			'jahr'          => array( 'type' => 'string', 'default' => '' ),
			'kategorie'     => array( 'type' => 'string', 'default' => '' ),
			'spalten'       => array( 'type' => 'string', 'default' => '' ),
			'sortierung'    => array( 'type' => 'string', 'default' => '' ),
			'anzahl'        => array( 'type' => 'string', 'default' => '' ),
			'filter'        => array( 'type' => 'string', 'default' => '' ),
			'darstellung'   => array( 'type' => 'string', 'default' => '' ),
			'gruppierung'   => array( 'type' => 'string', 'default' => '' ),
			'detail'        => array( 'type' => 'string', 'default' => '' ),
			'nur_besondere' => array( 'type' => 'string', 'default' => '' ),
			'titel'         => array( 'type' => 'string', 'default' => '' ),
		);
		$stats = array(
			'jahr'     => array( 'type' => 'string', 'default' => '' ),
			'ansicht'  => array( 'type' => 'string', 'default' => '' ),
			'diagramm' => array( 'type' => 'string', 'default' => '' ),
			'auswahl'  => array( 'type' => 'string', 'default' => '' ),
			'titel'    => array( 'type' => 'string', 'default' => '' ),
		);
		// Leere Attribute = Vorgabe aus den Einstellungen
		$clean = static fn( array $a ) => array_filter( $a, static fn( $v ) => '' !== $v && null !== $v );
		register_block_type(
			'blaulichtcms/einsatzliste',
			array(
				'api_version'     => 3,
				'title'           => 'BlaulichtCMS: Einsatzliste',
				'category'        => 'widgets',
				'editor_script'   => 'blaulichtcms-bridge-blocks',
				'attributes'      => $list,
				'render_callback' => static fn( $a ) => self::shortcode_list( $clean( (array) $a ) ),
			)
		);
		register_block_type(
			'blaulichtcms/einsatzstatistik',
			array(
				'api_version'     => 3,
				'title'           => 'BlaulichtCMS: Einsatzstatistik',
				'category'        => 'widgets',
				'editor_script'   => 'blaulichtcms-bridge-blocks',
				'attributes'      => $stats,
				'render_callback' => static fn( $a ) => self::shortcode_stats( $clean( (array) $a ) ),
			)
		);
	}

	/* ------------------------------------------------------------------ Vorschau */

	/** Beispieldaten für die Vorschau, solange noch keine Einträge übertragen wurden. */
	public static function demo_rows(): array {
		$base = strtotime( wp_date( 'Y' ) . '-03-01 12:00:00' );
		$mk   = static fn( int $d, string $kw, string $label, string $cat, string $title, string $loc, string $veh, string $units, bool $special = false ) => array(
			'post'          => null,
			'id'            => 0,
			'ts'            => $base + $d * DAY_IN_SECONDS,
			'year'          => (int) wp_date( 'Y' ),
			'month'         => 3,
			'number'        => 0,
			'keyword'       => $kw,
			'keyword_label' => $label,
			'category'      => $cat,
			'title'         => $title,
			'location'      => $loc,
			'vehicles'      => $veh,
			'units'         => $units,
			'link'          => '',
			'featured'      => $special,
			'false_alarm'   => false,
			'images'        => array(),
			'report'        => '',
		);
		$rows = array(
			$mk( 20, 'F 2', 'Brand', 'Brand', 'Kaminbrand (Beispiel)', 'Nord', 'HLF, DLK', 'Polizei, Rettungsdienst', true ),
			$mk( 12, 'H 1', '', 'Hilfeleistung', 'Wasserschaden (Beispiel)', 'Süd', 'HLF', '' ),
			$mk( 3, 'F BMA', '', 'Brand', 'Brandmeldeanlage (Beispiel)', 'Mitte', 'HLF', '' ),
		);
		foreach ( $rows as $i => &$r ) {
			$r['number'] = 3 - $i;
		}
		return $rows;
	}

	public static function demo_stats(): array {
		$y = (int) wp_date( 'Y' );
		return array(
			'years'        => array( $y => 42, $y - 1 => 57 ),
			'months'       => array( $y => array( 1 => 4, 5, 3, 6, 2, 5, 7, 3, 2, 4, 1, 0 ) ),
			'categories'   => array( $y => array( 'Hilfeleistung' => 24, 'Brand' => 15, 'Unwetter' => 3 ) ),
			'false_alarms' => array( $y => 5 ),
		);
	}
}
