<?php
/**
 * Leert Caches nach Banneränderungen.
 *
 * @package LifeLink
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Cache-Invalidierung (Objekt-Cache, Post-Cache, verbreitete Seiten-Cache-Plugins).
 */
final class LifeLink_Cache_Purger {

	/**
	 * Konstruktor.
	 *
	 * @param LifeLink_Banner_Repository $repository Banner-Repository.
	 */
	public function __construct( private LifeLink_Banner_Repository $repository ) {}

	/**
	 * Leert alle relevanten Caches.
	 *
	 * @param string[] $pages Betroffene Zielseiten ("all", "front", "page:<ID>").
	 */
	public function purge( array $pages = array() ): void {
		// Eigener Objekt-Cache.
		$this->repository->invalidate();
		if ( function_exists( 'wp_cache_flush_group' ) && function_exists( 'wp_cache_supports' ) && wp_cache_supports( 'flush_group' ) ) {
			wp_cache_flush_group( LifeLink_Banner_Repository::CACHE_GROUP );
		}

		// Post-Caches der betroffenen Seiten.
		if ( function_exists( 'clean_post_cache' ) ) {
			$ids = array();
			foreach ( $pages as $page ) {
				$id = LifeLink_Targets::page_id( (string) $page );
				if ( null !== $id ) {
					$ids[] = $id;
				}
			}
			if ( in_array( 'front', $pages, true ) || in_array( 'all', $pages, true ) ) {
				$front = (int) get_option( 'page_on_front' );
				if ( $front > 0 ) {
					$ids[] = $front;
				}
			}
			foreach ( array_unique( $ids ) as $id ) {
				clean_post_cache( $id );
			}
		}

		/**
		 * Erlaubt, das Leeren der Seiten-Caches von Drittanbieter-Plugins abzuschalten.
		 *
		 * @param bool     $purge Ob Seiten-Caches geleert werden.
		 * @param string[] $pages Betroffene Ziele.
		 */
		if ( apply_filters( 'lifelink_purge_page_caches', true, $pages ) ) {
			$this->purge_page_caches();
		}

		/**
		 * Wird ausgelöst, wenn sich die sichtbaren Banner geändert haben (oder ändern könnten).
		 */
		do_action( 'lifelink_banners_changed' );
	}

	/**
	 * Ruft die Lösch-Funktionen bekannter Cache-Plugins auf, sofern vorhanden.
	 */
	private function purge_page_caches(): void {
		// LiteSpeed Cache.
		if ( has_action( 'litespeed_purge_all' ) ) {
			do_action( 'litespeed_purge_all' );
		}

		// WP Rocket.
		if ( function_exists( 'rocket_clean_domain' ) ) {
			rocket_clean_domain();
		}

		// W3 Total Cache.
		if ( function_exists( 'w3tc_flush_all' ) ) {
			w3tc_flush_all();
		}

		// WP Super Cache.
		if ( function_exists( 'wp_cache_clear_cache' ) ) {
			if ( is_multisite() ) {
				wp_cache_clear_cache( get_current_blog_id() );
			} else {
				wp_cache_clear_cache();
			}
		}

		// WP Fastest Cache.
		if ( function_exists( 'wpfc_clear_all_cache' ) ) {
			wpfc_clear_all_cache( true );
		} elseif ( has_action( 'wpfc_clear_all_cache' ) ) {
			do_action( 'wpfc_clear_all_cache' );
		}
	}
}
