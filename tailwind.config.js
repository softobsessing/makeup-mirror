/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Brand accent used for overlay guides + primary controls.
        guide: "#FF3B7F",
        // ---- Candy / kawaii "beauty game" palette ----
        blush: "#FF7EC7", // bubblegum pink (primary)
        rose: "#FF5BA6", // deeper rose for gradients
        berry: "#C21E73", // headings + text accents
        plum: "#6B2A4E", // body text on light panels
        cotton: "#FFD9EC", // pale pink
        candy: "#FFB6DC", // soft pink
        lilac: "#C9A9FF", // lavender accent
        lavender: "#E6D6FF", // pale lavender
        cream: "#FFF7EC", // warm highlight
        mint: "#63D9B9", // "ready/done" success (cuter than emerald)
      },
      fontFamily: {
        display: ['"Fredoka"', '"Baloo 2"', "ui-rounded", "system-ui", "sans-serif"],
        body: ['"Quicksand"', "ui-rounded", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};
