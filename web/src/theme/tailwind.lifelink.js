/**
 * LifeLink Tailwind-Preset: eingebunden in src/index.css per @config.
 * Farben zeigen auf die CSS-Variablen aus tokens.css,
 * dadurch funktionieren Dark/Light ohne dark:-Varianten.
 */
const v = (name) => `var(--ll-${name})`;

export default {
  theme: {
    extend: {
      colors: {
        primary: { DEFAULT: v('primary'), solid: v('primary-solid'), soft: v('primary-soft') },
        accent: v('accent'),
        signal: v('signal'),
        bg: v('bg'),
        sidebar: v('sidebar'),
        card: v('card'),
        raised: v('raised'),
        line: v('border'),
        fg: { DEFAULT: v('text'), muted: v('text-2'), link: v('link') },
        ok: { DEFAULT: v('ok'), soft: v('ok-soft') },
        warn: { DEFAULT: v('warn'), soft: v('warn-soft') },
        err: { DEFAULT: v('err'), soft: v('err-soft') },
        cyan: v('cyan'),
        node: {
          trigger: v('node-trigger'),
          condition: v('node-condition'),
          data: v('node-data'),
          action: v('node-action'),
          control: v('node-control'),
        },
      },
      fontFamily: {
        sans: ['"Geist Variable"', 'Geist', 'system-ui', 'sans-serif'],
        mono: ['"Geist Mono Variable"', '"Geist Mono"', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        label: ['11px', { lineHeight: '16px', letterSpacing: '0.06em', fontWeight: '600' }],
        meta: ['12px', '16px'],
        sm: ['13px', '18px'],
        base: ['14px', '20px'],
        section: ['15px', '20px'],
        topbar: ['17px', '24px'],
        title: ['20px', '28px'],
        page: ['24px', '32px'],
        kpi: ['28px', '34px'],
      },
      borderRadius: {
        chip: '4px',
        control: '6px',
        node: '6px',
        card: '8px',
      },
      height: { 'ctl-sm': '32px', ctl: '36px', field: '38px' },
      width: { sidebar: '248px', 'sidebar-collapsed': '64px', panel: '400px', palette: '256px' },
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
