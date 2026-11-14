<?php
/**
 * REST-Routen unter /wp-json/lifelink/v1/.
 *
 * @package LifeLink
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * REST-Controller nach Schnittstellenvertrag v1.
 */
final class LifeLink_REST_Controller {

	public const REST_NAMESPACE = 'lifelink/v1';

	/**
	 * Konstruktor.
	 *
	 * @param LifeLink_Auth              $auth       Signaturprüfung.
	 * @param LifeLink_Banner_Repository $repository Banner.
	 * @param LifeLink_Targets           $targets    Zielseiten.
	 * @param LifeLink_Cache_Purger      $purger     Cache-Purger.
	 * @param LifeLink_Cron              $cron       Zeitsteuerung.
	 * @param LifeLink_Post_Handler      $posts      Beiträge.
	 * @param LifeLink_Audit_Log         $audit      Audit-Log.
	 */
	public function __construct(
		private LifeLink_Auth $auth,
		private LifeLink_Banner_Repository $repository,
		private LifeLink_Targets $targets,
		private LifeLink_Cache_Purger $purger,
		private LifeLink_Cron $cron,
		private LifeLink_Post_Handler $posts,
		private LifeLink_Audit_Log $audit
	) {}

	/**
	 * Hooks registrieren.
	 */
	public function register(): void {
		add_action( 'rest_api_init', array( $this, 'register_routes' ) );
		add_filter( 'rest_post_dispatch', array( $this, 'add_headers' ), 10, 3 );
		add_filter( 'rest_request_before_callbacks', array( $this, 'defer_json_error' ), 10, 3 );
	}

	/**
	 * WordPress lehnt ungültiges JSON sonst schon vor der Signaturprüfung mit 400
	 * "rest_invalid_json" ab. Für die eigenen Routen wird zuerst signiert geprüft und
	 * ungültiges JSON danach vertragsgemäß mit 422 "lifelink_invalid" beantwortet.
	 *
	 * @param mixed           $response Bisheriges Ergebnis (null oder Fehler).
	 * @param array           $handler  Routen-Handler.
	 * @param WP_REST_Request $request  Anfrage.
	 * @return mixed
	 */
	public function defer_json_error( $response, $handler, $request ) {
		if (
			is_wp_error( $response )
			&& 'rest_invalid_json' === $response->get_error_code()
			&& $request instanceof WP_REST_Request
			&& str_starts_with( (string) $request->get_route(), '/' . self::REST_NAMESPACE . '/' )
		) {
			return null;
		}
		return $response;
	}

	/**
	 * Routen registrieren.
	 */
	public function register_routes(): void {
		$signed = array( $this->auth, 'authorize' );

		register_rest_route(
			self::REST_NAMESPACE,
			'/status',
			array(
				'methods'             => 'GET',
				'callback'            => $this->guard( array( $this, 'get_status' ) ),
				'permission_callback' => $signed,
			)
		);

		register_rest_route(
			self::REST_NAMESPACE,
			'/pages',
			array(
				'methods'             => 'GET',
				'callback'            => $this->guard( array( $this, 'get_pages' ) ),
				'permission_callback' => $signed,
			)
		);

		register_rest_route(
			self::REST_NAMESPACE,
			'/banners',
			array(
				'methods'             => 'GET',
				'callback'            => $this->guard( array( $this, 'get_banners' ) ),
				'permission_callback' => $signed,
			)
		);

		register_rest_route(
			self::REST_NAMESPACE,
			'/banners/(?P<external_id>[^/]+)',
			array(
				array(
					'methods'             => 'PUT',
					'callback'            => $this->guard( array( $this, 'put_banner' ) ),
					'permission_callback' => $signed,
				),
				array(
					'methods'             => 'DELETE',
					'callback'            => $this->guard( array( $this, 'delete_banner' ) ),
					'permission_callback' => $signed,
				),
			)
		);

		register_rest_route(
			self::REST_NAMESPACE,
			'/posts',
			array(
				'methods'             => 'POST',
				'callback'            => $this->guard( array( $this, 'post_post' ) ),
				'permission_callback' => $signed,
			)
		);

		register_rest_route(
			self::REST_NAMESPACE,
			'/public/banners',
			array(
				'methods'             => 'GET',
				'callback'            => $this->guard( array( $this, 'get_public_banners' ) ),
				'permission_callback' => '__return_true',
			)
		);
	}

	/**
	 * Fängt unerwartete Fehler ab und liefert ein JSON-Fehlerobjekt (500, wiederholbar).
	 *
	 * @param callable $callback Eigentlicher Callback.
	 */
	private function guard( callable $callback ): Closure {
		return static function ( WP_REST_Request $request ) use ( $callback ) {
			try {
				return call_user_func( $callback, $request );
			} catch ( Throwable $e ) {
				if ( defined( 'WP_DEBUG' ) && WP_DEBUG ) {
					error_log( 'LifeLink: ' . $e->getMessage() ); // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
				}
				return LifeLink_Error::internal();
			}
		};
	}

	/**
	 * Ergänzt Retry-After bei 429 und Cache-Header des öffentlichen Endpunkts.
	 *
	 * @param WP_HTTP_Response $result  Antwort.
	 * @param WP_REST_Server   $server  Server.
	 * @param WP_REST_Request  $request Anfrage.
	 * @return WP_HTTP_Response
	 */
	public function add_headers( $result, $server, $request ) {
		if ( ! $result instanceof WP_HTTP_Response || ! $request instanceof WP_REST_Request ) {
			return $result;
		}
		if ( ! str_starts_with( (string) $request->get_route(), '/' . self::REST_NAMESPACE . '/' ) ) {
			return $result;
		}
		$data = $result->get_data();
		if ( 429 === $result->get_status() && is_array( $data ) && 'lifelink_rate_limited' === ( $data['code'] ?? '' ) ) {
			$retry = isset( $data['data']['retry_after'] ) ? (int) $data['data']['retry_after'] : 60;
			$result->header( 'Retry-After', (string) max( 1, $retry ) );
		}
		if ( ! str_starts_with( (string) $request->get_route(), '/' . self::REST_NAMESPACE . '/public/' ) ) {
			// Signierte Antworten nie zwischenspeichern.
			$result->header( 'Cache-Control', 'no-store, private' );
		}
		return $result;
	}

	/**
	 * Schlüssel-ID der Anfrage (für Protokoll und Antworten).
	 */
	private function key_id(): string {
		return (string) $this->auth->current_key_id();
	}

	/**
	 * GET /status
	 *
	 * @param WP_REST_Request $request Anfrage.
	 */
	public function get_status( WP_REST_Request $request ): WP_REST_Response {
		return new WP_REST_Response(
			array(
				'plugin_version' => LIFELINK_VERSION,
				'api_version'    => LIFELINK_API_VERSION,
				'site_name'      => wp_specialchars_decode( (string) get_bloginfo( 'name' ), ENT_QUOTES ),
				'site_url'       => home_url(),
				'timezone'       => wp_timezone_string(),
				'wp_version'     => (string) get_bloginfo( 'version' ),
				'php_version'    => PHP_VERSION,
				'multisite'      => is_multisite(),
				'banners_active' => count( $this->repository->active() ),
				'key_id'         => $this->key_id(),
				'time'           => LifeLink_Validator::to_iso( time() ),
			),
			200
		);
	}

	/**
	 * GET /pages
	 *
	 * @param WP_REST_Request $request Anfrage.
	 */
	public function get_pages( WP_REST_Request $request ): WP_REST_Response {
		return new WP_REST_Response( array( 'pages' => $this->targets->all() ), 200 );
	}

	/**
	 * GET /banners
	 *
	 * @param WP_REST_Request $request Anfrage.
	 */
	public function get_banners( WP_REST_Request $request ): WP_REST_Response {
		$banners = array_map(
			array( LifeLink_Banner_Repository::class, 'to_api' ),
			$this->repository->all_recent()
		);
		return new WP_REST_Response( array( 'banners' => $banners ), 200 );
	}

	/**
	 * Prüft die external_id aus der Route.
	 *
	 * @param WP_REST_Request $request Anfrage.
	 * @return string|WP_Error
	 */
	private function route_external_id( WP_REST_Request $request ) {
		$id = (string) $request->get_param( 'external_id' );
		if ( ! LifeLink_Validator::is_uuid( $id ) ) {
			return LifeLink_Error::invalid( array( 'external_id' => __( 'UUID erwartet.', 'lifelink' ) ) );
		}
		return strtolower( $id );
	}

	/**
	 * PUT /banners/{external_id}
	 *
	 * @param WP_REST_Request $request Anfrage.
	 * @return WP_REST_Response|WP_Error
	 */
	public function put_banner( WP_REST_Request $request ) {
		$external_id = $this->route_external_id( $request );
		if ( is_wp_error( $external_id ) ) {
			return $external_id;
		}

		$body = LifeLink_Validator::decode_body( (string) $request->get_body() );
		if ( is_wp_error( $body ) ) {
			$this->audit->add( $this->key_id(), 'banner.upsert', $external_id, 'lifelink_invalid' );
			return $body;
		}

		$data = LifeLink_Validator::banner( $body, $this->targets );
		if ( is_wp_error( $data ) ) {
			$this->audit->add( $this->key_id(), 'banner.upsert', $external_id, 'lifelink_invalid' );
			return $data;
		}

		$result = $this->repository->upsert( $external_id, $data );
		if ( is_wp_error( $result ) ) {
			$this->audit->add( $this->key_id(), 'banner.upsert', $external_id, 'error' );
			return $result;
		}

		if ( ! $result['unchanged'] ) {
			$pages = LifeLink_Banner_Repository::pages( $result['banner'] );
			if ( null !== $result['previous'] ) {
				$pages = array_values( array_unique( array_merge( $pages, LifeLink_Banner_Repository::pages( $result['previous'] ) ) ) );
			}
			$this->cron->schedule_transitions( $result['banner'] );
			$this->purger->purge( $pages );
			$this->cron->remember_fingerprint();
		}

		$this->audit->add(
			$this->key_id(),
			'banner.upsert',
			$external_id . ' r' . (int) $result['banner']['revision'],
			$result['unchanged'] ? 'unchanged' : 'ok'
		);

		return new WP_REST_Response(
			array(
				'banner'    => LifeLink_Banner_Repository::to_api( $result['banner'] ),
				'unchanged' => (bool) $result['unchanged'],
			),
			200
		);
	}

	/**
	 * DELETE /banners/{external_id}
	 *
	 * @param WP_REST_Request $request Anfrage.
	 * @return WP_REST_Response|WP_Error
	 */
	public function delete_banner( WP_REST_Request $request ) {
		$external_id = $this->route_external_id( $request );
		if ( is_wp_error( $external_id ) ) {
			return $external_id;
		}

		$row = $this->repository->deactivate( $external_id );
		if ( null === $row ) {
			$this->audit->add( $this->key_id(), 'banner.deactivate', $external_id, 'unknown' );
			return new WP_REST_Response( array( 'deactivated' => false ), 200 );
		}

		$this->cron->clear_transitions( $external_id );
		$this->purger->purge( LifeLink_Banner_Repository::pages( $row ) );
		$this->cron->remember_fingerprint();
		$this->audit->add( $this->key_id(), 'banner.deactivate', $external_id, 'ok' );

		return new WP_REST_Response( array( 'deactivated' => true ), 200 );
	}

	/**
	 * POST /posts
	 *
	 * @param WP_REST_Request $request Anfrage.
	 * @return WP_REST_Response|WP_Error
	 */
	public function post_post( WP_REST_Request $request ) {
		$body = LifeLink_Validator::decode_body( (string) $request->get_body() );
		if ( is_wp_error( $body ) ) {
			$this->audit->add( $this->key_id(), 'post.upsert', '-', 'lifelink_invalid' );
			return $body;
		}

		$data = LifeLink_Validator::post( $body );
		if ( is_wp_error( $data ) ) {
			$object = LifeLink_Validator::is_uuid( $body['external_id'] ?? null ) ? (string) $body['external_id'] : '-';
			$this->audit->add( $this->key_id(), 'post.upsert', $object, 'lifelink_invalid' );
			return $data;
		}

		$result = $this->posts->upsert( $data, $this->key_id() );
		if ( is_wp_error( $result ) ) {
			return $result;
		}
		return new WP_REST_Response( $result, 200 );
	}

	/**
	 * GET /public/banners?page=<id> (ohne Signatur).
	 *
	 * @param WP_REST_Request $request Anfrage.
	 * @return WP_REST_Response|WP_Error
	 */
	public function get_public_banners( WP_REST_Request $request ) {
		$page = $request->get_param( 'page' );
		$page = ( null === $page || '' === $page ) ? 'all' : $page;
		if ( ! is_string( $page ) || ! LifeLink_Targets::is_context( $page ) ) {
			return LifeLink_Error::invalid( array( 'page' => __( 'Erwartet: all, front oder page:<ID>.', 'lifelink' ) ) );
		}

		$rows    = $this->repository->active( $this->targets->targets_for_context( $page ) );
		$banners = array();
		foreach ( $rows as $row ) {
			$banners[] = LifeLink_Banner_Repository::to_api( $row, true );
		}

		$response = new WP_REST_Response( array( 'banners' => $banners ), 200 );
		$response->header( 'Cache-Control', 'public, max-age=60' );
		return $response;
	}
}
