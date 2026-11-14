<?php
/**
 * Veröffentlicht einen LifeLink-Auftrag als WordPress-Beitrag.
 *
 * Idempotent: Der Beitrag wird über die LifeLink-Beitrags-ID (Meta „_lifelink_post_id“) gefunden.
 * Erneutes Abholen oder ein Auftrag mit unbekanntem Ergebnis aktualisiert denselben Beitrag,
 * statt einen zweiten anzulegen. Medien werden über „_lifelink_media_id“ wiederverwendet.
 *
 * @package LifeLinkBridge
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class LifeLink_Bridge_Publisher {

	/** Vorhandenen Beitrag zu einer LifeLink-Beitrags-ID suchen (auch Papierkorb/Entwurf). */
	public static function find_post( string $lifelink_post_id ): int {
		$q = new WP_Query(
			array(
				'post_type'        => 'post',
				'post_status'      => 'any',
				'posts_per_page'   => 1,
				'fields'           => 'ids',
				'no_found_rows'    => true,
				'suppress_filters' => true,
				'meta_key'         => '_lifelink_post_id', // phpcs:ignore WordPress.DB.SlowDBQuery
				'meta_value'       => $lifelink_post_id,  // phpcs:ignore WordPress.DB.SlowDBQuery
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
				'meta_key'       => '_lifelink_media_id', // phpcs:ignore WordPress.DB.SlowDBQuery
				'meta_value'     => $media_id,           // phpcs:ignore WordPress.DB.SlowDBQuery
			)
		);
		return $q->posts ? (int) $q->posts[0] : 0;
	}

	/**
	 * Mediendatei aus LifeLink in die Mediathek übernehmen (einmal je LifeLink-Medien-ID).
	 *
	 * @return int|WP_Error Anhang-ID.
	 */
	private static function import_media( array $m, int $post_id ) {
		$existing = self::find_attachment( (string) $m['id'] );
		if ( $existing ) {
			return $existing;
		}
		require_once ABSPATH . 'wp-admin/includes/file.php';
		require_once ABSPATH . 'wp-admin/includes/media.php';
		require_once ABSPATH . 'wp-admin/includes/image.php';
		$tmp = LifeLink_Bridge_Client::download_media( (string) ( $m['path'] ?? '' ) );
		if ( is_wp_error( $tmp ) ) {
			return $tmp;
		}
		$file = array(
			'name'     => sanitize_file_name( (string) $m['filename'] ),
			'tmp_name' => $tmp,
		);
		$id = media_handle_sideload( $file, $post_id );
		if ( is_wp_error( $id ) ) {
			wp_delete_file( $tmp );
			return $id;
		}
		update_post_meta( $id, '_lifelink_media_id', (string) $m['id'] );
		return (int) $id;
	}

	/** Text aus LifeLink (einfache Absätze) sicher in HTML umwandeln. */
	private static function body_html( string $text ): string {
		return wpautop( esc_html( $text ) );
	}

	/**
	 * Veröffentlichten Beitrag zurückziehen (Status „Entwurf“). Idempotent: bereits zurückgezogen oder
	 * nicht vorhanden gilt als erledigt.
	 *
	 * @return array|WP_Error
	 */
	public static function unpublish( array $job ) {
		$llid    = (string) ( $job['lifelink_post_id'] ?? '' );
		$post_id = '' !== $llid ? self::find_post( $llid ) : 0;
		if ( ! $post_id ) {
			return array(
				'remote_id'     => 0,
				'url'           => '',
				'remote_status' => 'missing',
			);
		}
		if ( 'draft' !== get_post_status( $post_id ) ) {
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
			return new WP_Error( 'lifelink_job_type', 'Unbekannter Auftragstyp: ' . ( $job['type'] ?? '?' ) );
		}
		$p        = $job['post'] ?? array();
		$llid     = (string) ( $job['lifelink_post_id'] ?? '' );
		$settings = LifeLink_Bridge_Settings::all();
		if ( '' === $llid || empty( $p['title'] ) ) {
			return new WP_Error( 'lifelink_job_invalid', 'Auftrag ist unvollständig.' );
		}

		$post_id = self::find_post( $llid );
		$data    = array(
			'post_type'    => 'post',
			'post_title'   => sanitize_text_field( (string) $p['title'] ),
			'post_content' => self::body_html( (string) ( $p['body'] ?? '' ) ),
			'post_excerpt' => sanitize_textarea_field( (string) ( $p['excerpt'] ?? '' ) ),
			'post_status'  => 'publish',
		);
		if ( $settings['author_id'] ) {
			$data['post_author'] = (int) $settings['author_id'];
		}
		if ( $settings['category_id'] ) {
			$data['post_category'] = array( (int) $settings['category_id'] );
		}

		if ( $post_id ) {
			$data['ID'] = $post_id;
			$r          = wp_update_post( wp_slash( $data ), true );
		} else {
			$r = wp_insert_post( wp_slash( $data ), true );
		}
		if ( is_wp_error( $r ) ) {
			return $r;
		}
		$post_id = (int) $r;
		update_post_meta( $post_id, '_lifelink_post_id', $llid );
		update_post_meta( $post_id, '_lifelink_revision', (int) ( $job['revision'] ?? 0 ) );
		update_post_meta( $post_id, '_lifelink_kind', sanitize_key( (string) ( $job['kind'] ?? 'news' ) ) );
		update_post_meta( $post_id, '_lifelink_content_hash', sanitize_text_field( (string) ( $job['content_hash'] ?? '' ) ) );

		// Medien: Titelbild setzen, weitere Bilder und Videos unter dem Text anhängen.
		$cover   = (string) ( $p['cover_media_id'] ?? '' );
		$figures = array();
		foreach ( (array) ( $job['media'] ?? array() ) as $m ) {
			$att = self::import_media( $m, $post_id );
			if ( is_wp_error( $att ) ) {
				return $att;
			}
			if ( $cover === (string) $m['id'] ) {
				set_post_thumbnail( $post_id, $att );
				continue;
			}
			if ( 'video' === ( $m['kind'] ?? '' ) ) {
				$figures[] = '[video src="' . esc_url( wp_get_attachment_url( $att ) ) . '"]';
			} else {
				$figures[] = '<figure class="wp-block-image">' . wp_get_attachment_image( $att, 'large' ) . '</figure>';
			}
		}
		if ( ! $cover ) {
			delete_post_thumbnail( $post_id );
		}
		if ( $figures ) {
			wp_update_post(
				wp_slash(
					array(
						'ID'           => $post_id,
						'post_content' => $data['post_content'] . "\n" . implode( "\n", $figures ),
					)
				)
			);
		}

		$status = get_post_status( $post_id );
		return array(
			'remote_id'     => $post_id,
			'url'           => (string) get_permalink( $post_id ),
			'remote_status' => (string) $status,
		);
	}
}
