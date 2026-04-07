/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/renderer/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        panel: "#141a26",
        accent: "#17b890",
        warning: "#f59e0b",
        danger: "#ef4444"
      }
    }
  },
  plugins: []
};

