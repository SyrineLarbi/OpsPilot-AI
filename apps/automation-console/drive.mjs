// Document storage for processed invoice files.
// DRIVE_MODE=demo (default): a fake "Drive" kept locally in data/drive-demo, served by the console.
// A real Google Drive adapter only needs to implement the same upload(file, name) → { id, url } contract.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function createDrive({ root, mode = 'demo' }) {
  if (mode !== 'demo') throw new Error(`DRIVE_MODE « ${mode} » non pris en charge (seul « demo » est disponible).`);
  const dir = path.join(root, 'data', 'drive-demo');
  fs.mkdirSync(dir, { recursive: true });

  return {
    mode,
    label: 'Drive (démo)',
    /** Copies the file into the demo Drive; returns a Drive-like id and a link served by the console. */
    async upload(file, name) {
      const id = crypto.randomBytes(16).toString('base64url');
      fs.copyFileSync(file, path.join(dir, `${id}__${name}`));
      return { id, url: `/drive/file/${id}` };
    },
    /** Finds a stored file by id (demo mode only). */
    find(id) {
      if (!/^[A-Za-z0-9_-]{22}$/.test(id)) return null;
      const f = fs.readdirSync(dir).find((x) => x.startsWith(`${id}__`));
      return f ? { path: path.join(dir, f), name: f.slice(id.length + 2) } : null;
    },
  };
}
