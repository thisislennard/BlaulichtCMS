<?php
/**
 * Zentrale Plugin-Klasse: verdrahtet alle Komponenten.
 *
 * @package LifeLink
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * LifeLink-Plugin (Singleton).
 */
final class LifeLink_Plugin {

	/**
	 * Instanz.
	 *
	 * @var LifeLink_Plugin|null
	 */
	private static ?LifeLink_Plugin $instance = null;

	private LifeLink_Settings $settings;
	private LifeLink_Keys $keys;
	private LifeLink_Audit_Log $audit;
	private LifeLink_Targets $targets;
	private LifeLink_Banner_Repository $repository;
	private LifeLink_Cache_Purger $purger;
	private LifeLink_Cron $cron;
	private LifeLink_Auth $auth;
	private LifeLink_Post_Handler $posts;
	private LifeLink_REST_Controller $rest;
	private LifeLink_Renderer $renderer;
	private LifeLink_Admin $admin;

	/**
	 * Bereits gestartet?
	 *
	 * @var bool
	 */
	private bool $booted = false;

	/**
	 * Singleton-Zugriff.
	 */
	public static function instance(): LifeLink_Plugin {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	/**
	 * Konstruktor: baut die Objekte (ohne Seiteneffekte).
	 */
	private function __construct() {
		$this->settings   = new LifeLink_Settings();
		$this->keys       = new LifeLink_Keys();
		$this->audit      = new LifeLink_Audit_Log();
		$this->targets    = new LifeLink_Targets();
		$this->repository = new LifeLink_Banner_Repository();
		$this->purger     = new LifeLink_Cache_Purger( $this->repository );
		$this->cron       = new LifeLink_Cron( $this->repository, $this->purger, $this->audit );
		$this->auth       = new LifeLink_Auth( $this->keys, $this->audit );
		$this->posts      = new LifeLink_Post_Handler( $this->settings, $this->audit );
		$this->rest       = new LifeLink_REST_Controller( $this->auth, $this->repository, $this->targets, $this->purger, $this->cron, $this->posts, $this->audit );
		$this->renderer   = new LifeLink_Renderer( $this->repository, $this->targets, $this->settings );
		$this->admin      = new LifeLink_Admin( $this->settings, $this->keys, $this->audit, $this->repository, $this->targets, $this->renderer, $this->purger, $this->cron );
	}

	/**
	 * Registriert alle Hooks.
	 */
	public function boot(): void {
		if ( $this->booted ) {
			return;
		}
		$this->booted = true;

		LifeLink_Installer::register();
		$this->cron->register();
		$this->rest->register();
		$this->renderer->register();
		$this->admin->register();

		add_action( 'init', array( $this, 'init' ) );
		add_action( 'widgets_init', array( $this, 'register_widget' ) );
	}

	/**
	 * init: Übersetzungen und Block.
	 */
	public function init(): void {
		load_plugin_textdomain( 'lifelink', false, dirname( plugin_basename( LIFELINK_FILE ) ) . '/languages' );
		register_block_type( LIFELINK_DIR . 'blocks/banners' );
	}

	/**
	 * Klassisches Widget registrieren.
	 */
	public function register_widget(): void {
		register_widget( 'LifeLink_Widget' );
	}

	/**
	 * Renderer (für Block und Widget).
	 */
	public function renderer(): LifeLink_Renderer {
		return $this->renderer;
	}
}
