import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync, realpathSync } from 'fs';
import { resolve, join, relative, basename } from 'path';
import type { ToolDefinition } from '../utils.js';

const WORKSPACE_ROOT = process.env.QOOPIA_WORKSPACE_ROOT || resolve(process.cwd(), 'workspace');
const MAX_FILE_SIZE = 100 * 1024;

const DENIED_PATTERNS = [
  /^\.env$/,
  /^credentials/i,
  /^token.*\.json$/i,
  /\.key$/,
  /\.pem$/,
  /secret/i,
];

function isDeniedPath(filePath: string): boolean {
  const name = basename(filePath);
  if (filePath.split('/').includes('node_modules')) return true;
  return DENIED_PATTERNS.some(re => re.test(name));
}

function resolveWorkspacePath(inputPath: string): { resolved: string; error?: string } {
  const rel = String(inputPath || '/').replace(/^\/+/, '');
  const resolved = resolve(join(WORKSPACE_ROOT, rel));
  if (!resolved.startsWith(WORKSPACE_ROOT)) {
    return { resolved: '', error: 'Access denied: path traversal detected' };
  }
  if (isDeniedPath(resolved)) {
    return { resolved: '', error: 'Access denied: file matches security filter' };
  }
  // Resolve symlinks to prevent escape
  try {
    const real = realpathSync(resolved);
    if (!real.startsWith(realpathSync(WORKSPACE_ROOT))) {
      return { resolved: '', error: 'Access denied: symlink escape detected' };
    }
    return { resolved: real };
  } catch {
    // Path doesn't exist yet (write case) — verify parent
    const parent = resolve(resolved, '..');
    try {
      const realParent = realpathSync(parent);
      if (!realParent.startsWith(realpathSync(WORKSPACE_ROOT))) {
        return { resolved: '', error: 'Access denied: symlink escape detected' };
      }
    } catch {
      // Parent doesn't exist — prefix check already passed
    }
    return { resolved };
  }
}

function listFilesRecursive(dir: string): Array<{ name: string; type: 'file' | 'directory'; size: number; modified: string }> {
  const entries: Array<{ name: string; type: 'file' | 'directory'; size: number; modified: string }> = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (isDeniedPath(full)) continue;
    const stat = statSync(full);
    const rel = relative(WORKSPACE_ROOT, full);
    if (stat.isDirectory()) {
      entries.push({ name: rel, type: 'directory', size: 0, modified: stat.mtime.toISOString() });
      entries.push(...listFilesRecursive(full));
    } else {
      entries.push({ name: rel, type: 'file', size: stat.size, modified: stat.mtime.toISOString() });
    }
  }
  return entries;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'read_file',
    description: 'Read a file from the workspace',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path from workspace root' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_files',
    description: 'List files/directories in a workspace path',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path from workspace root (default "/")' },
        recursive: { type: 'boolean', description: 'List recursively (default false)' },
      },
    },
  },
  {
    name: 'write_file',
    description: 'Write/update a file in the workspace',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path from workspace root' },
        content: { type: 'string', description: 'File content to write' },
      },
      required: ['path', 'content'],
    },
  },
];

export async function handleTool(name: string, args: Record<string, unknown>, workspaceId: string, actorId: string): Promise<unknown | null> {
  switch (name) {
    case 'read_file': {
      const { resolved, error } = resolveWorkspacePath(String(args.path || ''));
      if (error) return { content: [{ type: 'text', text: error }], isError: true };
      if (!existsSync(resolved)) return { content: [{ type: 'text', text: 'File not found' }], isError: true };
      const stat = statSync(resolved);
      if (stat.isDirectory()) return { content: [{ type: 'text', text: 'Path is a directory' }], isError: true };
      if (stat.size > MAX_FILE_SIZE) return { content: [{ type: 'text', text: `File too large (${stat.size} bytes, max 100KB)` }], isError: true };
      return { content: [{ type: 'text', text: readFileSync(resolved, 'utf-8') }] };
    }

    case 'list_files': {
      const inputPath = args.path ? String(args.path) : '/';
      const { resolved, error } = resolveWorkspacePath(inputPath);
      if (error) return { content: [{ type: 'text', text: error }], isError: true };
      const targetDir = existsSync(resolved) ? resolved : WORKSPACE_ROOT;
      const recursive = Boolean(args.recursive);
      const entries = recursive
        ? listFilesRecursive(targetDir)
        : readdirSync(targetDir).filter(e => !isDeniedPath(join(targetDir, e))).map(entry => {
            const full = join(targetDir, entry);
            const s = statSync(full);
            return { name: relative(WORKSPACE_ROOT, full), type: (s.isDirectory() ? 'directory' : 'file') as 'file' | 'directory', size: s.isDirectory() ? 0 : s.size, modified: s.mtime.toISOString() };
          });
      return { content: [{ type: 'text', text: JSON.stringify(entries) }] };
    }

    case 'write_file': {
      const { resolved, error } = resolveWorkspacePath(String(args.path || ''));
      if (error) return { content: [{ type: 'text', text: error }], isError: true };
      const dir = resolve(join(resolved, '..'));
      if (!dir.startsWith(WORKSPACE_ROOT)) return { content: [{ type: 'text', text: 'Access denied' }], isError: true };
      mkdirSync(dir, { recursive: true });
      writeFileSync(resolved, String(args.content ?? ''), 'utf-8');
      return { content: [{ type: 'text', text: `Written: ${relative(WORKSPACE_ROOT, resolved)}` }] };
    }

    default:
      return null;
  }
}
