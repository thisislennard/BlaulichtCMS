<?php
/**
 * Zielseiten für Banner ("all", "front", "page:<ID>").
 *
 * @package LifeLink
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Kennt die möglichen Zielseiten und ermittelt den Kontext der aktuellen Seite.
 */
final class LifeLink_Targets {

	public const MAX_PAGES = 200;

	/**
	 * Liste für GET /pages.
	 *
	 * @return array<int,array{id:string,label:string}>
	 */
	public function all(): array {
		$list = array(
			array(
				'id'    => 'all',
				'label' => __( 'Alle Seiten', 'lifelink' ),
			),
			array(
				'id'    => 'front',
				'label' => __( 'Startseite', 'lifelink' ),
			),
		);

		$pages = get_posts(
			array(
				'post_type'              => 'page',
				'post_status'            => 'publish',
				'numberposts'            => self::MAX_PAGES,
				'orderby'                => array(
					'menu_order' => 'ASC',
					'title'      => 'ASC',
				),
				'suppress_filters'       => true,
				'no_found_rows'          => true,
				'update_post_meta_cache' => false,
				'update_post_term_cache' => false,
			)
		);

		foreach ( $pages as $page ) {
			$list[] = array(
				'id'    => 'page:' . $page->ID,
				'label' => self::page_title( $page ),
			);
		}

		return $list;
	}

	/**
	 * Klartext-Titel einer Seite.
	 *
	 * @param WP_Post $page Seite.
	 */
	private static function page_title( WP_Post $page ): string {
		$title = trim( wp_strip_all_tags( $page->post_title ) );
		/* translators: %d: page ID */
		return '' !== $title ? $title : sprintf( __( '(ohne Titel) #%d', 'lifelink' ), $page->ID );
	}

	/**
	 * Ist das ein gültiges Ziel (all, front oder veröffentlichte Seite)?
	 *
	 * @param string $target Ziel.
	 */
	public function is_valid( string $target ): bool {
		if ( 'all' === $target || 'front' === $target ) {
			return true;
		}
		$id = self::page_id( $target );
		if ( null === $id ) {
			return false;
		}
		$post = get_post( $id );
		return $post instanceof WP_Post && 'page' === $post->post_type && 'publish' === $post->post_status;
	}

	/**
	 * Seiten-ID aus "page:<ID>" oder null.
	 *
	 * @param string $target Ziel.
	 */
	public static function page_id( string $target ): ?int {
		if ( 1 !== preg_match( '/^page:([1-9][0-9]{0,19})$/', $target, $m ) ) {
			return null;
		}
		return (int) $m[1];
	}

	/**
	 * Ist der Wert formal ein Kontext ("all", "front", "page:<ID>")?
	 *
	 * @param string $context Kontext.
	 */
	public static function is_context( string $context ): bool {
		return 'all' === $context || 'front' === $context || null !== self::page_id( $context );
	}

	/**
	 * Statische Startseite (ID) oder 0.
	 */
	private static function static_front_page_id(): int {
		if ( 'page' !== get_option( 'show_on_front' ) ) {
			return 0;
		}
		return (int) get_option( 'page_on_front' );
	}

	/**
	 * Alle Ziele, die für einen Kontext gelten.
	 *
	 * "page:<ID>" der statischen Startseite trifft auch "front" und umgekehrt.
	 *
	 * @param string $context Kontext.
	 * @return string[]
	 */
	public function targets_for_context( string $context ): array {
		$targets = array( 'all' );
		$front   = self::static_front_page_id();

		if ( 'front' === $context ) {
			$targets[] = 'front';
			if ( $front > 0 ) {
				$targets[] = 'page:' . $front;
			}
		} else {
			$id = self::page_id( $context );
			if ( null !== $id ) {
				$targets[] = 'page:' . $id;
				if ( $front > 0 && $front === $id ) {
					$targets[] = 'front';
				}
			}
		}

		return array_values( array_unique( $targets ) );
	}

	/**
	 * Kontext der aktuell aufgerufenen Seite (Frontend).
	 */
	public function current_context(): string {
		if ( is_front_page() ) {
			$front = self::static_front_page_id();
			return $front > 0 ? 'page:' . $front : 'front';
		}
		if ( is_page() ) {
			$id = (int) get_queried_object_id();
			return $id > 0 ? 'page:' . $id : 'all';
		}
		if ( is_home() ) {
			$posts_page = (int) get_option( 'page_for_posts' );
			if ( $posts_page > 0 ) {
				return 'page:' . $posts_page;
			}
		}
		return 'all';
	}

	/**
	 * Lesbarer Name eines Ziels für die Admin-Anzeige.
	 *
	 * @param string $target Ziel.
	 */
	public function label( string $target ): string {
		if ( 'all' === $target ) {
			return __( 'Alle Seiten', 'lifelink' );
		}
		if ( 'front' === $target ) {
			return __( 'Startseite', 'lifelink' );
		}
		$id   = self::page_id( $target );
		$post = null !== $id ? get_post( $id ) : null;
		if ( $post instanceof WP_Post ) {
			return self::page_title( $post );
		}
		return $target;
	}
}
