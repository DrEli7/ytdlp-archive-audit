import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, symlink, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { archiveKey, parseArchive, auditArchive, scanMedia, formatMarkdown } from '../src/index.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
async function fixture(t, files) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ytdlp-audit-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, value] of Object.entries(files)) { await mkdir(path.dirname(path.join(dir, name)), { recursive: true }); await writeFile(path.join(dir, name), value); }
  return dir;
}
const info = (id, other = {}) => JSON.stringify({ id, extractor_key: 'Youtube', ext: 'mp4', ...other });
test('uses extractor_key/ie_key and preserves case of video IDs', () => {
  assert.equal(archiveKey({ extractor_key: 'YouTube', id: 'AbC' }), 'youtube AbC');
  assert.equal(archiveKey({ ie_key: 'Vimeo', id: 12 }), 'vimeo 12');
  assert.equal(archiveKey({ extractor: 'youtube', id: 'a' }), null);
  assert.equal(archiveKey({ extractor_key: 'Youtube', id: NaN }), null);
  assert.equal(archiveKey({ extractor_key: 'Youtube', id: 'a\tb' }), null);
});
test('archive duplicates and malformed records are visible', () => {
  const result = parseArchive('\ufeffyoutube AbC\r\nyoutube AbC\ninvalid\n');
  assert.equal(result.records.length, 1); assert.equal(result.diagnostics.length, 2);
});
test('reconciles present, missing, archive-only, zero-length and unarchived', async t => {
  const dir = await fixture(t, { 'a.info.json': info('a'), 'a.mp4': 'media', 'b.info.json': info('b'), 'c.info.json': info('c'), 'c.mp4': '', 'd.info.json': info('d'), 'd.mp3': 'audio' });
  const report = await auditArchive('youtube a\nyoutube b\nyoutube c\nyoutube unknown\n', dir);
  assert.deepEqual(report.entries.map(x => x.status), ['present', 'missing-media', 'zero-length', 'archive-only', 'sidecar-only']);
  assert.equal(report.entries[3].sidecars.length, 0); assert.equal(report.summary['archive-only'], 1);
});
test('postprocessed extension is found by stem, multiple formats remain ambiguous', async t => {
  const dir = await fixture(t, { 'a.info.json': info('a'), 'a.mp3': 'audio', 'b.info.json': info('b'), 'b.mp4': 'video', 'b.mkv': 'video' });
  const report = await auditArchive('youtube a\nyoutube b', dir);
  assert.equal(report.entries[0].status, 'present'); assert.equal(report.entries[1].status, 'ambiguous');
});
test('multiple sidecars for one archive ID are ambiguous, old aliases match', async t => {
  const dir = await fixture(t, { 'one/a.info.json': info('a'), 'two/a.info.json': info('a'), 'old.info.json': info('new', { _old_archive_ids: ['oldextractor old-id'] }), 'old.mp4': 'media' });
  const r = await auditArchive('youtube a\noldextractor old-id\n', dir);
  assert.equal(r.entries[0].status, 'ambiguous'); assert.equal(r.entries[1].status, 'present'); assert.equal(r.summary['sidecar-only'], 0);
});
test('ignores metadata paths and URLs by default; malformed/playlist JSON diagnosed', async t => {
  const dir = await fixture(t, { 'a.info.json': info('a', { filepath: '../../outside.mp4', _filename: 'C:\\secret.mp4', webpage_url: 'https://example.com/?token=private' }), 'bad.info.json': '{broken', 'list.info.json': JSON.stringify({ _type: 'playlist', id: 'p' }) });
  const r = await auditArchive('youtube a', dir);
  assert.equal(r.entries[0].status, 'missing-media'); assert.equal(r.diagnostics.length, 2);
  assert.ok(!JSON.stringify(r).includes('private')); assert.ok(!JSON.stringify(r).includes('secret'));
});
test('explicit URL output only supports HTTP URLs without embedded credentials', async t => {
  const dir = await fixture(t, { 'a.info.json': info('a', { webpage_url: 'https://user:pass@example.com/a' }) });
  const r = await auditArchive('youtube a', dir, { includeUrls: true });
  assert.equal(r.entries[0].sidecars[0].webpageUrl, null);
});
test('symlink directories are skipped rather than traversed', async t => {
  const dir = await fixture(t, { 'local.info.json': info('a') });
  const outside = await fixture(t, { 'else.info.json': info('else'), 'else.mp4': 'media' });
  try { await symlink(outside, path.join(dir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (e) { if (e.code === 'EPERM') { t.skip('Host disallows symlinks'); return; } throw e; }
  const scan = await scanMedia(dir);
  assert.equal(scan.sidecars.length, 1); assert.equal(scan.diagnostics[0].code, 'symlink-skipped');
});
test('size limits, custom extensions and Markdown escapes work', async t => {
  const dir = await fixture(t, { 'a.info.json': info('a|b'), 'a.custom': 'data' });
  assert.equal((await scanMedia(dir, { maxSidecarBytes: 1 })).diagnostics[0].code, 'sidecar-too-large');
  const r = await auditArchive('youtube a|b', dir, { extensions: ['custom'] });
  assert.equal(r.entries[0].status, 'present'); assert.match(formatMarkdown(r), /a\\\|b/);
  await assert.rejects(scanMedia(dir, { extensions: ['../mp4'] }), /extensions/);
});
test('CLI gives useful output, check status, and leaves inputs unchanged', async () => {
  const archive = path.join(root, 'examples/archive.txt'); const before = await readFile(archive, 'utf8');
  const args = ['src/cli.mjs', '--archive', 'examples/archive.txt', '--root', 'examples/media', '--format', 'json'];
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).summary.present, 1);
  assert.equal(spawnSync(process.execPath, [...args, '--check'], { cwd: root }).status, 1);
  assert.equal(spawnSync(process.execPath, ['src/cli.mjs', '--unknown'], { cwd: root }).status, 2);
  assert.equal(await readFile(archive, 'utf8'), before);
});
