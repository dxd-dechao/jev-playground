/**
 * Tailwind v4 runs as a PostCSS plugin.
 *
 * NOTE: `next dev` / `next build` are pinned to `--webpack` in package.json.
 * On this machine Turbopack's PostCSS transform fails while spawning its
 * worker ("creating new process / binding to a port / Operation not
 * permitted"), even with no sandbox in the way; the same build succeeds under
 * webpack, and succeeds under Turbopack once this file is removed. See README.
 */

/** @type {import('postcss-load-config').Config} */
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
