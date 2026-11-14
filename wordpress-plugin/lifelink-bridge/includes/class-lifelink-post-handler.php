<?php
/**
 * Anlegen/Aktualisieren von Beiträgen (POST /posts).
 *
 * @package LifeLink
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Beitrags-Upsert über die Post-Meta "_lifelink_external_id".
 */
final class LifeLink_Post_Handler {

	public const META_EXTERNAL_ID = '_lifelink_external_id';
	public const META_REVISION    = '_lifelink_revision';
	private const LOCK_PREFIX     = 'lifelink_lock_';
	private const LOCK_TTL        = 30;

	/**
	 * Status, die LifeLink nicht mehr verändert (Entscheidung liegt bei WordPress).
	 */
	private const PROTECTED_STATI = array( 'publish', 'private', 'trash' );

	/**
	 * Konstruktor.
	 *
	 * @param LifeLink_Settings  $settings Einstellungen.
	 * @param LifeLink_Audit_Log $audit    Audit-Log.
	 */
	public function __construct(
		private LifeLink_Settings $settings,
		private LifeLink_Audit_Log $audit
	) {}

	/**
	 * Upsert eines Beitrags.
	 *
	 * @param array  $data   Validierte Daten (LifeLink_Validator::post()).
	 * @param string $key_id Schlüssel-ID für das Protokoll.
	 * @return array|WP_Error Antwort-Daten.
	 */
	public function upsert( array $data, string $key_id ) {
		$author = $this->settings->author();
		if ( null === $author ) {
			$this->audit->add( $key_id, 'post.upsert', $data['external_id'], 'lifelink_forbidden' );
			return LifeLink_Error::make(
				'lifelink_forbidden',
				__( 'Im Plugin ist kein Autor mit der Berechtigung „Beiträge bearbeiten“ eingestellt.', 'lifelink' ),
				403
			);
		}

		if ( ! $this->acquire_lock( $data['external_id'] ) ) {
			return LifeLink_Error::make( 'lifelink_busy', __( 'Dieser Beitrag wird gerade bearbeitet. Bitte erneut versuchen.', 'lifelink' ), 503, true );
		}

		try {
			return $this->upsert_locked( $data, $key_id, $author );
		} finally {
			$this->release_lock( $data['external_id'] );
		}
	}

	/**
	 * Upsert unter Sperre.
	 *
	 * @param array   $data   Daten.
	 * @param string  $key_id Schlüssel-ID.
	 * @param WP_User $author Autor.
	 * @return array|WP_Error
	 */
	private function upsert_locked( array $data, string $key_id, WP_User $author ) {
		$existing = $this->find( $data['external_id'] );

		if ( null !== $existing ) {
			$stored_revision = (int) get_post_meta( $existing->ID, self::META_REVISION, true );
			if ( $stored_revision >= $data['revision'] ) {
				$this->audit->add( $key_id, 'post.upsert', 'post:' . $existing->ID, 'unchanged' );
				return $this->response( $existing->ID, true );
			}
			if ( in_array( $existing->post_status, self::PROTECTED_STATI, true ) ) {
				// Veröffentlichte, private oder gelöschte Beiträge bleiben in WordPress-Hand.
				$this->audit->add( $key_id, 'post.upsert', 'post:' . $existing->ID, 'unchanged:' . $existing->post_status );
				return $this->response( $existing->ID, true );
			}
		}

		$status = $data['status'];
		if ( 'future' === $status && ! $this->settings->get( 'allow_future' ) ) {
			$status = 'pending';
		}

		$postarr = array(
			'post_type'    => 'post',
			'post_title'   => $data['title'],
			'post_content' => $data['content'],
			'post_excerpt' => $data['excerpt'],
			'post_status'  => $status,
			'post_author'  => $author->ID,
			'tags_input'   => $data['tags'],
			'meta_input'   => array(
				self::META_EXTERNAL_ID => $data['external_id'],
				self::META_REVISION    => (int) $data['revision'],
			),
		);

		if ( null !== $data['publish_at'] ) {
			$gmt                     = gmdate( 'Y-m-d H:i:s', (int) $data['publish_at'] );
			$postarr['post_date_gmt'] = $gmt;
			$postarr['post_date']     = get_date_from_gmt( $gmt );
			$postarr['edit_date']     = true;
		}

		$category_id = $this->resolve_category( $data['category'] );
		if ( $category_id > 0 ) {
			$postarr['post_category'] = array( $category_id );
		}

		if ( null !== $existing ) {
			$postarr['ID'] = $existing->ID;
			$result        = wp_update_post( wp_slash( $postarr ), true );
		} else {
			$result = wp_insert_post( wp_slash( $postarr ), true );
		}

		if ( is_wp_error( $result ) || 0 === (int) $result ) {
			$this->audit->add( $key_id, 'post.upsert', $data['external_id'], 'error' );
			return LifeLink_Error::internal();
		}

		$post_id = (int) $result;
		$this->audit->add( $key_id, 'post.upsert', 'post:' . $post_id, 'ok:' . get_post_status( $post_id ) );
		return $this->response( $post_id, false );
	}

	/**
	 * Antwortobjekt.
	 *
	 * @param int  $post_id   Post-ID.
	 * @param bool $unchanged Unverändert.
	 */
	private function response( int $post_id, bool $unchanged ): array {
		return array(
			'post_id'   => $post_id,
			'status'    => (string) get_post_status( $post_id ),
			'edit_url'  => admin_url( 'post.php?post=' . $post_id . '&action=edit' ),
			'unchanged' => $unchanged,
		);
	}

	/**
	 * Sucht den Beitrag zu einer external_id (alle Status inkl. Papierkorb).
	 *
	 * @param string $external_id UUID.
	 */
	private function find( string $external_id ): ?WP_Post {
		$posts = get_posts(
			array(
				'post_type'        => 'post',
				'post_status'      => array( 'publish', 'future', 'draft', 'pending', 'private', 'trash' ),
				'meta_key'         => self::META_EXTERNAL_ID, // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_key
				'meta_value'       => $external_id, // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_value
				'numberposts'      => 1,
				'orderby'          => 'ID',
				'order'            => 'ASC',
				'suppress_filters' => true,
				'no_found_rows'    => true,
			)
		);
		return ( ! empty( $posts ) && $posts[0] instanceof WP_Post ) ? $posts[0] : null;
	}

	/**
	 * Kategorie per Name suchen und – falls erlaubt – anlegen.
	 *
	 * @param string $name Name.
	 * @return int Term-ID oder 0.
	 */
	private function resolve_category( string $name ): int {
		if ( '' === $name ) {
			return 0;
		}
		$term = get_term_by( 'name', $name, 'category' );
		if ( $term instanceof WP_Term ) {
			return (int) $term->term_id;
		}
		if ( ! $this->settings->get( 'allow_categories' ) ) {
			return 0;
		}
		$created = wp_insert_term( $name, 'category' );
		if ( is_wp_error( $created ) ) {
			$existing = $created->get_error_data( 'term_exists' );
			return is_numeric( $existing ) ? (int) $existing : 0;
		}
		return (int) $created['term_id'];
	}

	/**
	 * Einfache Sperre je external_id gegen parallele Doppelanlage.
	 *
	 * @param string $external_id UUID.
	 */
	private function acquire_lock( string $external_id ): bool {
		global $wpdb;
		$name     = self::LOCK_PREFIX . md5( $external_id );
		$deadline = microtime( true ) + 5;

		do {
			if ( wp_using_ext_object_cache() ) {
				if ( wp_cache_add( $name, 1, 'lifelink_locks', self::LOCK_TTL ) ) {
					return true;
				}
			} else {
				// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
				$inserted = $wpdb->query(
					$wpdb->prepare(
						"INSERT IGNORE INTO {$wpdb->options} (option_name, option_value, autoload) VALUES (%s, %s, 'no')",
						$name,
						(string) time()
					)
				);
				if ( 1 === (int) $inserted ) {
					return true;
				}
				// Verwaiste Sperre (z. B. nach Absturz) entfernen.
				// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
				$wpdb->query(
					$wpdb->prepare(
						"DELETE FROM {$wpdb->options} WHERE option_name = %s AND CAST(option_value AS UNSIGNED) < %d",
						$name,
						time() - self::LOCK_TTL
					)
				);
			}
			usleep( 200000 );
		} while ( microtime( true ) < $deadline );

		return false;
	}

	/**
	 * Gibt die Sperre frei.
	 *
	 * @param string $external_id UUID.
	 */
	private function release_lock( string $external_id ): void {
		global $wpdb;
		$name = self::LOCK_PREFIX . md5( $external_id );
		if ( wp_using_ext_object_cache() ) {
			wp_cache_delete( $name, 'lifelink_locks' );
			return;
		}
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
		$wpdb->query( $wpdb->prepare( "DELETE FROM {$wpdb->options} WHERE option_name = %s", $name ) );
	}
}
