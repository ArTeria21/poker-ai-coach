import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { app } from './app';

// The built SPA (npm run build); in dev Vite serves the web app and proxies /api here.
app.use('/*', serveStatic({ root: './dist' }));
app.get('*', serveStatic({ path: './dist/index.html' }));

const port = Number(process.env.PORT) || 8787;
// Loopback by default: /api/chat spends the OpenRouter key. Docker sets HOST=0.0.0.0.
const hostname = process.env.HOST ?? '127.0.0.1';
serve({ fetch: app.fetch, port, hostname }, () => console.log(`poker coach server on ${hostname}:${port}`));
