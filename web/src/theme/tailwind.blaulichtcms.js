/**
 * BlaulichtCMS Tailwind-Preset: eingebunden in src/index.css per @config.
 * Farben zeigen auf die CSS-Variablen aus tokens.css,
 * dadurch funktionieren Dark/Light ohne dark:-Varianten.
 */
const v = (name) => `var(--bc-${name})`;

export default {
  theme: {
    extend: {
      colors: {
        primary: { DEFAULT: v('primary'), solid: v('primary-solid'), hover: v('primary-hover'), soft: v('primary-soft') },
        'on-primary': v('on-primary'),
        signal: v('signal'),
        bg: v('bg'),
        card: v('card'),
        raised: v('raised'),
        line: v('border'),
        fg: { DEFAULT: v('text'), muted: v('text-2'), link: v('link') },
        ok: { DEFAULT: v('ok'), soft: v('ok-soft') },
        warn: { DEFAULT: v('warn'), soft: v('warn-soft') },
        err: { DEFAULT: v('err'), soft: v('err-soft') },
        knob: v('knob'),
        flow: { input: v('flow-input'), 'input-soft': v('flow-input-soft'), output: v('flow-output'), 'output-soft': v('flow-output-soft') },
        scrim: v('scrim'),
        site: {
          info: { bg: v('site-info-bg'), fg: v('site-info-fg'), line: v('site-info-line') },
          warning: { bg: v('site-warning-bg'), fg: v('site-warning-fg'), line: v('site-warning-line') },
          danger: { bg: v('site-danger-bg'), fg: v('site-danger-fg'), line: v('site-danger-line') },
        },
      },
      fontFamily: {
        sans: ['"IBM Plex Sans"', 'system-ui', '"Segoe UI"', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        label: ['12px', { lineHeight: '16px', letterSpacing: '0.08em', fontWeight: '500' }],
        meta: ['12px', '16px'],
        sm: ['13px', '18px'],
        base: ['14px', '20px'],
        section: ['15px', '20px'],
        topbar: ['17px', '24px'],
        title: ['20px', '28px'],
        page: ['30px', '36px'],
        kpi: ['28px', '34px'],
      },
      borderRadius: {
        chip: '6px',
        control: '10px',
        node: '12px',
        card: '14px',
      },
      // Am Handy 40 px (Touch-Ziele, #264): Werte aus tokens.css, dort per Medienabfrage umgestellt
      height: { 'ctl-sm': v('h-ctl-sm'), ctl: v('h-ctl'), field: v('h-field') },
      maxWidth: { content: '1440px' },
      boxShadow: {
        float: v('shadow-float'),
        ring: v('ring'),
        selected: v('ring-selected'),
      },
      transitionDuration: { fast: '120ms', panel: '180ms' },
    },
  },
};
