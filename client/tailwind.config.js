/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0B0E1A',
        card: '#141829',
        'card-light': '#1B2036',
        border: '#252B44',
        accent: {
          from: '#7C6FF0',
          to: '#5B8DEF',
        },
        positive: '#22C55E',
        negative: '#F04452',
        muted: '#8890AA',
      },
      backgroundImage: {
        'accent-gradient': 'linear-gradient(135deg, #7C6FF0 0%, #5B8DEF 100%)',
        'fear-greed-gradient': 'linear-gradient(90deg, #F04452 0%, #F5C542 50%, #22C55E 100%)',
      },
      boxShadow: {
        glow: '0 0 20px rgba(124, 111, 240, 0.35)',
        'glow-green': '0 0 16px rgba(34, 197, 94, 0.35)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
