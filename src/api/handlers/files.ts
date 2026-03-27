import { Hono } from 'hono';
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync, realpathSync } from 'fs';
import { resolve, join, relative, basename } from 'path';
import type { AuthContext } from '../../types/index.js';

const app = new Hono<{ Variables: { auth: AuthContext } }>();

const WORKSPACE_ROOT = process.env.QOOPIA_WORKSPACE_ROOT || resolve(process.cwd(), 'workspace');
const MAX_FILE_SIZE = 100 * 1024; // 100KB

const DENIED_PATTERNS = [
  /\.env$/i,
  /credentials/i,
  /token.*\.json$/i,
  /\.key$/i,
  /\.pem$/i,
  /secret/i,
  /node_modules/i,
];

function isDenied(p: string): boolean {
  return DENIED_PATTERNS.some(re => re.test(p));
}

function safePath(reqPath: string): string | null {
  const resolved = resolve(WORKSPACE_ROOT, reqPath.replace(/^\/+/, ''));
  if (!resolved.startsWith(WORKSPACE_ROOT)) return null;
  if (isDenied(resolved)) return null;
  // Resolve symlinks to prevent escape
  try {
    const real = realpathSync(resolved);
    if (!real.startsWith(realpathSync(WORKSPACE_ROOT))) return null;
    return real;
  } catch {
    // Path doesn't exist yet (write case) — verify parent is inside workspace
    const parent = resolve(resolved, '..');
    try {
      const realParent = realpathSync(parent);
      if (!realParent.startsWith(realpathSync(WORKSPACE_ROOT))) return null;
    } catch {
      // Parent doesn't exist either — allow if prefix check passed
    }
    return resolved;
  }
}

// GET /list?path=/
app.get('/list', (c) => {
  const reqPath = c.req.query('path') || '/';
  const recursive = c.req.query('recursive') === 'true';
  const resolved = safePath(reqPath);
  if (!resolved) return c.json({ error: 'Access denied' }, 403);
  
  try {
    const entries = readdirSync(resolved, { withFileTypes: true });
    const result = entries
      .filter(e => !isDenied(e.name))
      .map(e => {
        const fullPath = join(resolved, e.name);
        const relPath = '/' + relative(WORKSPACE_ROOT, fullPath);
        try {
          const stat = statSync(fullPath);
          return {
            name: e.name,
            path: relPath,
            type: e.isDirectory() ? 'directory' : 'file',
            size: stat.size,
            modified: stat.mtime.toISOString(),
          };
        } catch {
          return { name: e.name, path: relPath, type: e.isDirectory() ? 'directory' : 'file', size: 0, modified: '' };
        }
      })
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    return c.json({ path: reqPath, entries: result });
  } catch {
    return c.json({ error: 'Directory not found' }, 404);
  }
});

// GET /read?path=/file.md
app.get('/read', (c) => {
  const reqPath = c.req.query('path') || '';
  const resolved = safePath(reqPath);
  if (!resolved) return c.json({ error: 'Access denied' }, 403);
  
  try {
    const stat = statSync(resolved);
    if (stat.size > MAX_FILE_SIZE) return c.json({ error: 'File too large (max 100KB)' }, 413);
    const content = readFileSync(resolved, 'utf-8');
    return c.json({ path: reqPath, size: stat.size, content });
  } catch {
    return c.json({ error: 'File not found' }, 404);
  }
});

// POST /write { path, content }
app.post('/write', async (c) => {
  const { path: reqPath, content } = await c.req.json();
  const resolved = safePath(reqPath);
  if (!resolved) return c.json({ error: 'Access denied' }, 403);
  
  const dir = resolve(resolved, '..');
  if (!dir.startsWith(WORKSPACE_ROOT)) return c.json({ error: 'Access denied' }, 403);
  
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(resolved, content, 'utf-8');
  return c.json({ success: true, path: reqPath });
});

export default app;
