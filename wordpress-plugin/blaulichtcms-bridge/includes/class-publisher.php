<?php
/**
 * Veröffentlicht einen BlaulichtCMS-Auftrag als WordPress-Beitrag.
 *
 * Idempotent: Der Beitrag wird über die BlaulichtCMS-Beitrags-ID (Meta „_blaulichtcms_post_id“) gefunden.
 * Erneutes Abholen oder ein Auftrag mit unbekanntem Ergebnis aktualisiert denselben Beitrag,
 * statt einen zweiten anzulegen. Medien werden über „_blaulichtcms_media_id“ wiederverwendet.
 *
 * Zurückziehen und aus einer Fassung entfernte Medien (#98): Jeder Beitrag merkt sich die BlaulichtCMS-Medien, die er
 * verwendet (Meta „_blaulichtcms_uses_media“, je Medium ein Eintrag). Wird ein Medium nicht mehr gebraucht, löscht die Bridge
 * den Anhang samt Dateien endgültig – sofern kein anderer Beitrag und keine andere Seite ihn noch verwendet.
 *
 * @package BlaulichtCMSBridge
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class BlaulichtCMS_Bridge_Publisher {
	/**
	 * Nach so vielen Sekunden in einem Auftrag werden keine weiteren Mediendateien mehr begonnen (#123). Der Auftrag
	 * endet dann ohne Rückmeldung; BlaulichtCMS liefert ihn erneut aus, bereits übernommene Medien werden wiederverwendet.
	 */
	const MAX_JOB_SECONDS = 240;

	/** Vorhandenen Beitrag zu einer BlaulichtCMS-Beitrags-ID suchen (auch Papierkorb/Entwurf). 'any' schließt den Papierkorb aus (#85). */
	public static function find_post( string $blaulichtcms_post_id ): int {
		$q = new WP_Query(
			array(
				'post_type'        => 'post',
				'post_status'      => array( 'publish', 'future', 'draft', 'pending', 'private', 'trash' ),
				'posts_per_page'   => 1,
				'fields'           => 'ids',
				'no_found_rows'    => true,
				'suppress_filters' => true,
				'meta_key'         => '_blaulichtcms_post_id', // phpcs:ignore WordPress.DB.SlowDBQuery
				'meta_value'       => $blaulichtcms_post_id,  // phpcs:ignore WordPress.DB.SlowDBQuery
			)
		);
		return $q->posts ? (int) $q->posts[0] : 0;
	}

	private static function find_attachment( string $media_id ): int {
		$q = new WP_Query(
			array(
				'post_type'      => 'attachment',
				'post_status'    => 'inherit',
				'posts_per_page' => 1,
				'fields'         => 'ids',
				'no_found_rows'  => true,
				'meta_key'       => '_blaulichtcms_media_id', // phpcs:ignore WordPress.DB.SlowDBQuery
				'meta_value'     => $media_id,           // phpcs:ignore WordPress.DB.SlowDBQuery
			)
		);
		return $q->posts ? (int) $q->posts[0] : 0;
	}

	/**
	 * Mediendatei aus BlaulichtCMS in die Mediathek übernehmen (einmal je BlaulichtCMS-Medien-ID).
	 *
	 * @param bool $downloaded Wird true, wenn die Datei in diesem Aufruf neu geladen wurde.
	 * @return int|WP_Error Anhang-ID.
	 */
	private static function import_media( array $m, int $post_id, bool &$downloaded = false ) {
		$alt      = sanitize_text_field( (string) ( $m['alt'] ?? '' ) );
		$existing = self::find_attachment( (string) $m['id'] );
		if ( $existing ) {
			// Ältere Übernahmen ohne Alternativtext nachziehen, redaktionell gesetzte Texte nicht überschreiben.
			if ( '' !== $alt && '' === (string) get_post_meta( $existing, '_wp_attachment_image_alt', true ) ) {
				update_post_meta( $existing, '_wp_attachment_image_alt', $alt );
			}
			return $existing;
		}
		require_once ABSPATH . 'wp-admin/includes/file.php';
		require_once ABSPATH . 'wp-admin/includes/media.php';
		require_once ABSPATH . 'wp-admin/includes/image.php';
		// Sperre vor und nach jedem Download erneuern: ein großes Video darf nicht als verwaister Abruf gelten (#123)
		if ( ! BlaulichtCMS_Bridge_Sync::heartbeat() ) {
			return new WP_Error( 'blaulichtcms_lock_lost', 'Abrufsperre verloren.' );
		}
		$tmp = BlaulichtCMS_Bridge_Client::download_media( (string) ( $m['path'] ?? '' ) );
		if ( ! BlaulichtCMS_Bridge_Sync::heartbeat() ) {
			if ( ! is_wp_error( $tmp ) ) {
				wp_delete_file( $tmp );
			}
			return new WP_Error( 'blaulichtcms_lock_lost', 'Abrufsperre verloren.' );
		}
		if ( is_wp_error( $tmp ) ) {
			return $tmp;
		}
		$downloaded = true;
		$file = array(
			'name'     => sanitize_file_name( (string) $m['filename'] ),
			'tmp_name' => $tmp,
		);
		$id = media_handle_sideload( $file, $post_id, null, '' !== $alt ? array( 'post_title' => $alt ) : array() );
		if ( is_wp_error( $id ) ) {
			wp_delete_file( $tmp );
			return $id;
		}
		update_post_meta( $id, '_blaulichtcms_media_id', (string) $m['id'] );
		if ( '' !== $alt ) {
			update_post_meta( $id, '_wp_attachment_image_alt', $alt );
		}
		return (int) $id;
	}

	/**
	 * Letzter Rückfall, wenn kein Autor ermittelt oder angelegt werden konnte: unter WP-Cron/CLI gibt es keinen
	 * angemeldeten Benutzer, die Beiträge hätten sonst keinen bzw. je nach Abrufweg einen anderen Autor (#86).
	 */
	private static function fallback_author(): int {
		$ids = get_users(
			array(
				'role'    => 'administrator',
				'number'  => 1,
				'orderby' => 'ID',
				'order'   => 'ASC',
				'fields'  => 'ID',
			)
		);
		return $ids ? (int) $ids[0] : 0;
	}

	/** Meta je verwendetem BlaulichtCMS-Medium. */
	const USES_META = '_blaulichtcms_uses_media';
	/** Markiert einen zurückgezogenen Beitrag (zählt nicht mehr als Verwendung seiner Medien). */
	const WITHDRAWN_META = '_blaulichtcms_withdrawn';

	/**
	 * BlaulichtCMS-Medien, die ein Beitrag verwendet. Für Übernahmen vor 0.6.0 (ohne Meta) zusätzlich die an den Beitrag
	 * angehängten BlaulichtCMS-Anhänge und das Beitragsbild.
	 *
	 * @return string[]
	 */
	private static function used_media( int $post_id ): array {
		$ids = array_map( 'strval', (array) get_post_meta( $post_id, self::USES_META, false ) );
		$att = get_posts(
			array(
				'post_type'        => 'attachment',
				'post_status'      => 'inherit',
				'post_parent'      => $post_id,
				'posts_per_page'   => 200,
				'fields'           => 'ids',
				'suppress_filters' => true,
				'meta_key'         => '_blaulichtcms_media_id', // phpcs:ignore WordPress.DB.SlowDBQuery
				'meta_compare'     => 'EXISTS',
			)
		);
		$thumb = (int) get_post_thumbnail_id( $post_id );
		if ( $thumb ) {
			$att[] = $thumb;
		}
		foreach ( $att as $a ) {
			$mid = (string) get_post_meta( (int) $a, '_blaulichtcms_media_id', true );
			if ( '' !== $mid ) {
				$ids[] = $mid;
			}
		}
		return array_values( array_unique( array_filter( $ids ) ) );
	}

	/** Verwendete Medien eines Beitrags festhalten (ersetzt die bisherige Liste). */
	private static function set_used_media( int $post_id, array $media_ids ): void {
		delete_post_meta( $post_id, self::USES_META );
		foreach ( array_unique( array_map( 'strval', $media_ids ) ) as $mid ) {
			if ( '' !== $mid ) {
				add_post_meta( $post_id, self::USES_META, $mid );
			}
		}
	}

	/**
	 * Verwendet ein anderer Inhalt (nicht zurückgezogen, nicht im Papierkorb) diesen Anhang noch? Geprüft werden andere
	 * BlaulichtCMS-Beiträge (Meta), Beitragsbilder, der Elternbeitrag und eingebettete Verweise in beliebigen Beiträgen und
	 * Seiten – auch von Hand angelegten.
	 */
	private static function attachment_in_use( int $att_id, string $media_id, int $except_post ): bool {
		global $wpdb;
		$live = "p.post_status NOT IN ('trash','auto-draft','inherit') AND p.ID <> %d AND NOT EXISTS (SELECT 1 FROM {$wpdb->postmeta} w WHERE w.post_id = p.ID AND w.meta_key = %s)";
		// Andere BlaulichtCMS-Beiträge mit diesem Medium oder diesem Beitragsbild
		$by_meta = (int) $wpdb->get_var(
			$wpdb->prepare(
				"SELECT COUNT(*) FROM {$wpdb->posts} p JOIN {$wpdb->postmeta} m ON m.post_id = p.ID
				  WHERE ( ( m.meta_key = %s AND m.meta_value = %s ) OR ( m.meta_key = '_thumbnail_id' AND m.meta_value = %s ) ) AND $live", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				self::USES_META,
				$media_id,
				(string) $att_id,
				$except_post,
				self::WITHDRAWN_META
			)
		);
		if ( $by_meta > 0 ) {
			return true;
		}
		// Elternbeitrag (Übernahmen vor 0.6.0)
		$parent = (int) wp_get_post_parent_id( $att_id );
		if ( $parent && $parent !== $except_post ) {
			$status = get_post_status( $parent );
			if ( $status && ! in_array( $status, array( 'trash', 'auto-draft' ), true ) && ! get_post_meta( $parent, self::WITHDRAWN_META, true ) ) {
				return true;
			}
		}
		// Eingebettet in Inhalte (Block-Klasse wp-image-<id> oder Datei-Adresse, auch verkleinerte Fassungen „name-1024x768.jpg“)
		$url  = (string) wp_get_attachment_url( $att_id );
		$file = '' !== $url ? wp_basename( $url ) : '';
		$stem = (string) preg_replace( '/-(scaled|rotated)$/', '', (string) pathinfo( $file, PATHINFO_FILENAME ) );
		$file = strlen( $stem ) >= 16 ? $stem : $file;
		$sql  = "SELECT COUNT(*) FROM {$wpdb->posts} p WHERE p.post_type NOT IN ('attachment','revision','nav_menu_item') AND $live AND ( p.post_content LIKE %s";
		$args = array( $except_post, self::WITHDRAWN_META, '%' . $wpdb->esc_like( 'wp-image-' . $att_id . '"' ) . '%' );
		if ( '' !== $file ) {
			$sql   .= ' OR p.post_content LIKE %s';
			$args[] = '%' . $wpdb->esc_like( $file ) . '%';
		}
		$sql .= ' )';
		return (int) $wpdb->get_var( $wpdb->prepare( $sql, $args ) ) > 0; // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
	}

	/**
	 * Anhänge zu BlaulichtCMS-Medien endgültig löschen (Datei und alle Bildgrößen), sofern sie nicht anderweitig verwendet
	 * werden.
	 *
	 * @param string[] $media_ids BlaulichtCMS-Medien-IDs.
	 * @return int Anzahl gelöschter Anhänge.
	 */
	private static function delete_unused_media( array $media_ids, int $post_id ): int {
		$deleted = 0;
		foreach ( array_unique( array_map( 'strval', $media_ids ) ) as $mid ) {
			if ( '' === $mid ) {
				continue;
			}
			$att = self::find_attachment( $mid );
			if ( ! $att || self::attachment_in_use( $att, $mid, $post_id ) ) {
				continue;
			}
			if ( (int) get_post_thumbnail_id( $post_id ) === $att ) {
				delete_post_thumbnail( $post_id );
			}
			if ( wp_delete_attachment( $att, true ) ) {
				++$deleted;
			}
		}
		return $deleted;
	}

	/**
	 * Kategorie-IDs aus BlaulichtCMS prüfen: nur vorhandene Kategorien dieser Website, höchstens 20.
	 *
	 * @return int[]
	 */
	private static function categories( array $ids ): array {
		$out = array();
		foreach ( array_slice( $ids, 0, 20 ) as $id ) {
			$id = absint( $id );
			if ( $id && term_exists( $id, 'category' ) ) {
				$out[] = $id;
			}
		}
		return array_values( array_unique( $out ) );
	}

	/** Text aus BlaulichtCMS (einfache Absätze) sicher in HTML umwandeln. */
	private static function body_html( string $text ): string {
		return wpautop( esc_html( $text ) );
	}

	/**
	 * Veröffentlichten Beitrag zurückziehen (Status „Entwurf“) und die übernommenen Medien endgültig aus der Mediathek
	 * löschen, sofern sie nicht anderweitig verwendet werden (#98) – sonst blieben sie unter /wp-content/uploads, über
	 * Anhangseiten und /wp/v2/media öffentlich abrufbar. Idempotent: bereits zurückgezogen oder nicht vorhanden gilt als
	 * erledigt.
	 *
	 * @return array|WP_Error
	 */
	public static function unpublish( array $job ) {
		$llid    = (string) ( $job['blaulichtcms_post_id'] ?? '' );
		$post_id = '' !== $llid ? self::find_post( $llid ) : 0;
		if ( ! $post_id ) {
			return array(
				'remote_id'     => 0,
				'url'           => '',
				'remote_status' => 'missing',
			);
		}
		// Zuerst markieren: der Beitrag zählt ab jetzt nicht mehr als Verwendung seiner Medien
		update_post_meta( $post_id, self::WITHDRAWN_META, time() );
		if ( ! in_array( get_post_status( $post_id ), array( 'draft', 'trash' ), true ) ) {
			$r = wp_update_post(
				array(
					'ID'          => $post_id,
					'post_status' => 'draft',
				),
				true
			);
			if ( is_wp_error( $r ) ) {
				return $r;
			}
		}
		$media = array_merge( self::used_media( $post_id ), array_map( 'strval', (array) ( $job['media_ids'] ?? array() ) ) );
		self::delete_unused_media( $media, $post_id );
		return array(
			'remote_id'     => $post_id,
			'url'           => '',
			'remote_status' => 'draft',
		);
	}

	/**
	 * Auftrag verarbeiten.
	 *
	 * @return array{remote_id:int,url:string,remote_status:string}|WP_Error
	 */
	public static function upsert( array $job ) {
		if ( 'post.upsert' !== ( $job['type'] ?? '' ) ) {
			return new WP_Error( 'blaulichtcms_job_type', 'Unbekannter Auftragstyp: ' . ( $job['type'] ?? '?' ) );
		}
		$p        = $job['post'] ?? array();
		$llid     = (string) ( $job['blaulichtcms_post_id'] ?? '' );
		$settings = BlaulichtCMS_Bridge_Settings::all();
		if ( '' === $llid || empty( $p['title'] ) ) {
			return new WP_Error( 'blaulichtcms_job_invalid', 'Auftrag ist unvollständig.' );
		}

		$post_id = self::find_post( $llid );
		$before  = $post_id ? self::used_media( $post_id ) : array();
		if ( $post_id && 'trash' === get_post_status( $post_id ) ) {
			// Bewusst in WordPress gelöscht: nicht stillschweigend wiederherstellen und keinen zweiten Beitrag anlegen (#85).
			return new WP_Error( 'blaulichtcms_post_trashed', 'Der Beitrag liegt in WordPress im Papierkorb. Bitte dort wiederherstellen oder endgültig löschen und den Auftrag wiederholen.' );
		}
		$content = self::body_html( (string) ( $p['body'] ?? '' ) );
		$data    = array(
			'post_type'    => 'post',
			'post_title'   => sanitize_text_field( (string) $p['title'] ),
			'post_content' => $content,
			'post_excerpt' => sanitize_textarea_field( (string) ( $p['excerpt'] ?? '' ) ),
		);
		// Autor (#186): eigener Autor der Bridge, je Person aus BlaulichtCMS oder fester Benutzer
		$author = BlaulichtCMS_Bridge_Authors::for_job( $job ) ?: self::fallback_author();
		if ( $author ) {
			$data['post_author'] = $author;
		}
		// Kategorien (#186): Auswahl aus BlaulichtCMS, sofern es sie in WordPress gibt; sonst die Standardkategorie
		$categories = self::categories( (array) ( $p['categories'] ?? array() ) );
		if ( ! $categories && $settings['category_id'] && term_exists( (int) $settings['category_id'], 'category' ) ) {
			$categories = array( (int) $settings['category_id'] );
		}
		if ( $categories ) {
			$data['post_category'] = $categories;
		}

		// Neuer Beitrag zunächst als Entwurf: erst wenn alle Medien übernommen sind, wird er öffentlich (#68).
		// Ein bestehender Beitrag bleibt bis dahin unverändert in seiner bisherigen Fassung.
		if ( ! $post_id ) {
			$r = wp_insert_post( wp_slash( $data + array( 'post_status' => 'draft' ) ), true );
			if ( is_wp_error( $r ) ) {
				return $r;
			}
			$post_id = (int) $r;
			update_post_meta( $post_id, '_blaulichtcms_post_id', $llid );
		}

		// Medien: Titelbild setzen, weitere Bilder und Videos unter dem Text anhängen.
		$cover    = (string) ( $p['cover_media_id'] ?? '' );
		$figures  = array();
		$cover_id = 0;
		$started  = time();
		$fresh    = 0;
		foreach ( (array) ( $job['media'] ?? array() ) as $m ) {
			// Laufzeit auch zwischen Medien prüfen. Mindestens eine neue Datei je Lauf, damit der Auftrag vorankommt.
			if ( $fresh > 0 && time() - $started > self::MAX_JOB_SECONDS ) {
				return new WP_Error( 'blaulichtcms_deferred', 'Medienübernahme wird beim nächsten Abruf fortgesetzt.' );
			}
			$downloaded = false;
			$att        = self::import_media( $m, $post_id, $downloaded );
			if ( is_wp_error( $att ) ) {
				return $att;
			}
			if ( $downloaded ) {
				++$fresh;
			}
			if ( $cover === (string) $m['id'] ) {
				$cover_id = (int) $att;
				continue;
			}
			if ( 'video' === ( $m['kind'] ?? '' ) ) {
				$figures[] = '[video src="' . esc_url( wp_get_attachment_url( $att ) ) . '"]';
			} else {
				$figures[] = '<figure class="wp-block-image">' . wp_get_attachment_image( $att, 'large' ) . '</figure>';
			}
		}

		// Alles in einem Schritt übernehmen und veröffentlichen.
		$data['ID']           = $post_id;
		$data['post_status']  = 'publish';
		$data['post_content'] = $figures ? $content . "\n" . implode( "\n", $figures ) : $content;
		$r                    = wp_update_post( wp_slash( $data ), true );
		if ( is_wp_error( $r ) ) {
			return $r;
		}
		update_post_meta( $post_id, '_blaulichtcms_post_id', $llid );
		delete_post_meta( $post_id, self::WITHDRAWN_META ); // erneut veröffentlicht
		$now_used = array_map( static fn( $m ) => (string) ( $m['id'] ?? '' ), (array) ( $job['media'] ?? array() ) );
		self::set_used_media( $post_id, $now_used );
		update_post_meta( $post_id, '_blaulichtcms_revision', (int) ( $job['revision'] ?? 0 ) );
		update_post_meta( $post_id, '_blaulichtcms_kind', sanitize_key( (string) ( $job['kind'] ?? 'news' ) ) );
		update_post_meta( $post_id, '_blaulichtcms_content_hash', sanitize_text_field( (string) ( $job['content_hash'] ?? '' ) ) );
		if ( $cover_id ) {
			set_post_thumbnail( $post_id, $cover_id );
		} else {
			delete_post_thumbnail( $post_id );
		}
		// In der neuen Fassung entfernte Medien aus der Mediathek löschen (sofern nicht anderweitig verwendet)
		self::delete_unused_media( array_diff( $before, $now_used ), $post_id );

		$status = get_post_status( $post_id );
		return array(
			'remote_id'     => $post_id,
			'url'           => (string) get_permalink( $post_id ),
			'remote_status' => (string) $status,
		);
	}
}
