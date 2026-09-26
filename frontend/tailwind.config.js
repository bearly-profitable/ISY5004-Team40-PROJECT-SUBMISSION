/** Tailwind, compiled at build time (it used to run from cdn.tailwindcss.com
 * in the browser, which put a third-party script in charge of every page).
 * @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './*.{ts,tsx}',
    './{components,pages,lib}/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // Lumi's hood: the app's primary lavender (or the user's accent).
        // Themeable: values live in index.css (1b. Accent themes).
        lumina: {
          50: 'rgb(var(--lumina-50) / <alpha-value>)',
          100: 'rgb(var(--lumina-100) / <alpha-value>)',
          200: 'rgb(var(--lumina-200) / <alpha-value>)',
          300: 'rgb(var(--lumina-300) / <alpha-value>)',
          400: 'rgb(var(--lumina-400) / <alpha-value>)',
          500: 'rgb(var(--lumina-500) / <alpha-value>)',
          600: 'rgb(var(--lumina-600) / <alpha-value>)',
          700: 'rgb(var(--lumina-700) / <alpha-value>)',
          800: 'rgb(var(--lumina-800) / <alpha-value>)',
          900: 'rgb(var(--lumina-900) / <alpha-value>)',
        },
        // Lumi's body: rose fading into peach.
        blush: {
          100: '#fbe6ea',
          200: '#f6ccd4',
          300: '#eeabb8',
          400: '#e38c9e',
          500: '#d66f86',
        },
        peach: {
          100: '#fdeee2',
          200: '#fad8bf',
          300: '#f5bd95',
          400: '#eea06c',
          500: '#e2844a',
        },
        // The gallery's "event" accent: remapped from indigo
        // to Lumi's rose, so events and people (lavender)
        // stay two colours of the same character.
        indigo: {
          50: '#fdf0f3',
          100: '#fbe2e8',
          200: '#f6c7d2',
          300: '#eea5b6',
          400: '#e3879c',
          500: '#d46b85',
          600: '#b9536d',
          700: '#983f57',
        },
        // Neutrals warmed toward plum, so every grey in the app
        // belongs to the same family as Lumi.
        slate: {
          50: '#faf7fb',
          100: '#f3eef6',
          200: '#e6ddec',
          300: '#d2c5dc',
          400: '#a697b5',
          500: '#7d6d8e',
          600: '#5f506f',
          700: '#4a3d58',
          800: '#362b42',
          900: '#251c2f',
          950: '#170f1f',
        },
      },
      fontFamily: {
        sans: ['Nunito', 'ui-rounded', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
        display: ['Fraunces', 'Georgia', 'serif'],
      },
    },
  },
};
