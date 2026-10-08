/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.ts', './src/**/*.{ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors: {
        ink: { DEFAULT: '#1B1A1F', soft: '#4A4852', mute: '#8C8994' },
        paper: { DEFAULT: '#FBF8F3', raised: '#FFFFFF', sunk: '#F1ECE3' },
        rose: { DEFAULT: '#C8475B', soft: '#F6DCE0' },
        sage: { DEFAULT: '#4F7A5B', soft: '#DCEADF' },
        amber: { DEFAULT: '#C98A1E', soft: '#F7E7C6' },
        court: { DEFAULT: '#2E3A59', soft: '#DDE2EE' },
        danger: { DEFAULT: '#B3261E', soft: '#F9DEDC' },
      },
      borderRadius: { xl2: '20px' },
    },
  },
  plugins: [],
};
