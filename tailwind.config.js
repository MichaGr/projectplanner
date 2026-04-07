/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        background: '#0c0e10',
        'surface-dim': '#0c0e10',
        'surface-lowest': '#000000',
        'surface-low': '#111416',
        surface: '#171a1d',
        'surface-high': '#1d2023',
        'surface-highest': '#22262a',
        'surface-bright': '#282d31',
        'surface-variant': '#1b2027',
        outline: '#44484c',
        primary: '#e1c3ff',
        'primary-strong': '#d6b2fc',
        'primary-ink': '#553777',
        mint: '#8bd6b4',
        warning: '#ffb6be',
        rose: '#fd6f85',
        'rose-container': 'rgba(138, 22, 50, 0.2)',
        'on-surface': '#e3e6ea',
        'on-surface-variant': '#a8abb0',
        'on-surface-dim': '#80848a',
      },
      fontFamily: {
        headline: ['"Space Grotesk"', 'sans-serif'],
        body: ['Manrope', 'sans-serif'],
      },
      boxShadow: {
        ambient: '0 40px 40px -10px rgba(0, 0, 0, 0.08)',
      },
      backdropBlur: {
        architectural: '12px',
      },
    },
  },
  plugins: [],
};
