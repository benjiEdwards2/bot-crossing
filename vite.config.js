import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { apiMiddleware } from './server/api.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

/** Serves /api from inside the Vite dev server, so `npm run dev` is the whole game. */
const api = () => ({
  name: 'bot-crossing-api',
  configureServer(server) {
    server.middlewares.use(apiMiddleware)
  },
})

export default defineConfig({
  plugins: [api()],
  // PORT lets a second copy run alongside the first without a flag on the command line.
  // Session worktrees live under .claude/worktrees/, so without the ignore every edit an
  // agent makes force-reloads whoever is watching the colony. Anchored to this file's own
  // folder rather than '**/.claude/**', so a copy running *inside* a worktree — whose whole
  // root sits under a .claude — still watches its own sources.
  server: {
    port: Number(process.env.PORT) || 5274,
    strictPort: false,
    watch: { ignored: [path.join(here, '.claude', '**').replace(/\\/g, '/')] },
  },
  build: { target: 'esnext' },
})
