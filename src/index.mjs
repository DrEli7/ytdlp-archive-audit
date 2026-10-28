import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_EXTENSIONS = Object.freeze(['mp4', 'mkv', 'webm', 'mov', 'avi', 'flv', 'm4v', 'mp3', 'm4a', 'aac', 'opus', 'ogg', 'flac', 'wav', 'wma']);

/** yt-dlp archive IDs are lower-case extractor keys, one space, then the original video ID. */
export function archiveKey(info) {
  const extractor = info?.extractor_key || info?.ie_key;
  if (typeof extractor !== 'string' || !extractor || /[\s\u0000-\u001f\u007f]/.test(extractor)) return null;
  const id = info?.id;
  if ((typeof id !== 'string' && !(typeof id === 'number' && Number.isSafeInteger(id))) || !String(id) || /[\u0000-\u001f\u007f]/.test(String(id))) return null;
  return `${extractor.toLowerCase()} ${id}`;
}

export function parseArchive(text) {
  if (typeof text !== 'string') throw new TypeError('archive must be text');
  const records = new Map();
  const diagnostics = [];
  text.replace(/^\ufeff/, '').split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    const match = /^(\S+) (.+)$/.exec(line);
    if (!match || /[\u0000-\u001f\u007f]/.test(line)) {
      diagnostics.push({ code: 'invalid-archive-line', line: index + 1, message: 'Expected extractor-key, a space, and video ID' }); return;
    }
    const key = `${match[1].toLowerCase()} ${match[2]}`;
    if (records.has(key)) diagnostics.push({ code: 'duplicate-archive-entry', line: index + 1, key });
    else records.set(key, { key, line: index + 1 });
  });
  return { records: [...records.values()], diagnostics };
}

function safeUrl(raw) {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    // URLs may carry tokens; reports contain no URL by default.
    return url.href;
  } catch { return null; }
}
const displayPath = p => p.split(path.sep).join('/');

/** Scan a stable local directory. Symlink entries are skipped. No metadata paths are followed. */
export async function scanMedia(root, options = {}) {
  const maxSidecarBytes = options.maxSidecarBytes ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(maxSidecarBytes) || maxSidecarBytes < 1) throw new Error('maxSidecarBytes must be a positive integer');
  const extensions = options.extensions ?? DEFAULT_EXTENSIONS;
  if (!Array.isArray(extensions) || !extensions.length || extensions.some(x => typeof x !== 'string' || !/^[a-z0-9]{1,10}$/i.test(x))) throw new Error('extensions must contain plain alphanumeric suffixes');
  const allowed = new Set(extensions.map(x => x.toLowerCase()));
  const absoluteRoot = path.resolve(root);
  const rootStat = await lstat(absoluteRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('--root must be a real directory, not a symlink');
  const canonicalRoot = await realpath(absoluteRoot);
  const files = new Map();
  const diagnostics = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      const relative = displayPath(path.relative(canonicalRoot, full));
      const stat = await lstat(full);
      if (stat.isSymbolicLink()) { diagnostics.push({ code: 'symlink-skipped', path: relative }); continue; }
      if (stat.isDirectory()) await walk(full);
      else if (stat.isFile()) files.set(relative, { full, size: stat.size });
    }
  }
  await walk(canonicalRoot);
  const mediaByStem = new Map();
  for (const [relative, file] of files) {
    const extension = path.posix.extname(relative).slice(1).toLowerCase();
    if (!allowed.has(extension)) continue;
    const stem = relative.slice(0, -(extension.length + 1));
    const candidates = mediaByStem.get(stem) ?? [];
    candidates.push({ path: relative, bytes: file.size });
    mediaByStem.set(stem, candidates);
  }
  const sidecars = [];
  for (const [relative, file] of files) {
    if (!relative.endsWith('.info.json')) continue;
    if (file.size > maxSidecarBytes) { diagnostics.push({ code: 'sidecar-too-large', path: relative }); continue; }
    let info;
    try { info = JSON.parse((await readFile(file.full, 'utf8')).replace(/^\ufeff/, '')); }
    catch { diagnostics.push({ code: 'invalid-sidecar-json', path: relative }); continue; }
    if (!info || typeof info !== 'object' || Array.isArray(info)) { diagnostics.push({ code: 'invalid-sidecar-object', path: relative }); continue; }
    if (info._type && !['video', 'url', 'url_transparent'].includes(info._type)) {
      diagnostics.push({ code: 'non-video-sidecar-skipped', path: relative }); continue;
    }
    const key = archiveKey(info);
    if (!key) { diagnostics.push({ code: 'missing-identity', path: relative }); continue; }
    const stem = relative.slice(0, -'.info.json'.length);
    // Match only sibling files with the exact info-json stem. Ignore untrusted filepath/_filename values.
    const candidates = mediaByStem.get(stem) ?? [];
    const status = candidates.length > 1 ? 'ambiguous' : candidates.length === 0 ? 'missing-media' : candidates[0].bytes === 0 ? 'zero-length' : 'present';
    const aliases = Array.isArray(info._old_archive_ids) ? info._old_archive_ids.filter(x => typeof x === 'string' && /^\S+ .+$/.test(x)).map(x => `${x.slice(0, x.indexOf(' ')).toLowerCase()}${x.slice(x.indexOf(' '))}`) : [];
    sidecars.push({ key, aliases, sidecar: relative, mediaStatus: status, media: candidates, ...(options.includeUrls ? { webpageUrl: safeUrl(info.webpage_url) } : {}) });
  }
  return { sidecars, diagnostics };
}

export function reconcile(archive, scan) {
  const diagnostics = [...archive.diagnostics, ...scan.diagnostics];
  const byKey = new Map();
  for (const sidecar of scan.sidecars) for (const key of new Set([sidecar.key, ...sidecar.aliases])) {
    const list = byKey.get(key) ?? []; list.push(sidecar); byKey.set(key, list);
  }
  const matched = new Set();
  const entries = archive.records.map(record => {
    const sidecars = byKey.get(record.key) ?? [];
    sidecars.forEach(x => matched.add(x));
    const status = sidecars.length === 0 ? 'archive-only' : sidecars.length > 1 ? 'ambiguous' : sidecars[0].mediaStatus;
    return { key: record.key, status, archived: true, sidecars };
  });
  for (const sidecar of scan.sidecars) if (!matched.has(sidecar)) entries.push({ key: sidecar.key, status: 'sidecar-only', archived: false, sidecars: [sidecar] });
  const summary = Object.fromEntries(['present', 'archive-only', 'sidecar-only', 'missing-media', 'zero-length', 'ambiguous'].map(x => [x, entries.filter(e => e.status === x).length]));
  const actionable = entries.some(x => x.status !== 'present' || x.sidecars.some(s => s.mediaStatus !== 'present')) || diagnostics.length > 0;
  return { schemaVersion: 1, matching: 'exact adjacent filename stem; no metadata paths followed', summary, actionable, entries, diagnostics };
}

export async function auditArchive(archiveText, root, options = {}) {
  return reconcile(parseArchive(archiveText), await scanMedia(root, options));
}
function md(value) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('|', '\\|').replace(/[\r\n\u0000-\u001f\u007f]/g, ' '); }
export function formatMarkdown(report) {
  const rows = report.entries.map(x => `| ${md(x.key)} | ${x.status} | ${x.sidecars.map(s => `${md(s.sidecar)} (${s.mediaStatus})`).join('; ')} |`);
  return `# yt-dlp archive audit\n\nRead-only inspection. Missing-media means no recognized adjacent file, not proof of deletion. Archive-only entries are unverifiable without sidecars.\n\n| Archive ID | Status | Sidecars |\n| --- | --- | --- |\n${rows.join('\n')}\n\n## Summary\n\n${Object.entries(report.summary).map(([key, value]) => `- ${key}: ${value}`).join('\n')}\n\n## Diagnostics\n\n${report.diagnostics.length ? report.diagnostics.map(d => `- ${md(d.code)}: ${md(d.path ?? d.key ?? `line ${d.line}`)}`).join('\n') : 'None.'}\n`;
}
