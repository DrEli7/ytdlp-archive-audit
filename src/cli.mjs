#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { auditArchive, formatMarkdown } from './index.mjs';
const help = `ytdlp-archive-audit --archive archive.txt --root media-directory [options]
  --format markdown|json    Output format (markdown), written to stdout
  --extensions mp4,mkv,...  Replace recognized adjacent media extensions
  --include-urls            Include webpage_url in JSON (may contain private tokens)
  --check                   Exit 1 when review is needed
  --help                    Print help
Exit 2: bad arguments or failed filesystem read. No files are changed.\n`;
try {
  const { values } = parseArgs({ options: {
    archive: { type: 'string' }, root: { type: 'string' }, format: { type: 'string', default: 'markdown' },
    extensions: { type: 'string' }, 'include-urls': { type: 'boolean', default: false },
    check: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h', default: false },
  }, strict: true, allowPositionals: false });
  if (values.help) process.stdout.write(help);
  else {
    if (!values.archive || !values.root) throw new Error('--archive and --root are required');
    if (!['markdown', 'json'].includes(values.format)) throw new Error('Unsupported --format');
    if (values['include-urls'] && values.format !== 'json') throw new Error('--include-urls requires --format json');
    const report = await auditArchive(await readFile(values.archive, 'utf8'), values.root, { extensions: values.extensions?.split(','), includeUrls: values['include-urls'] });
    process.stdout.write(values.format === 'json' ? JSON.stringify(report, null, 2) + '\n' : formatMarkdown(report));
    process.exitCode = values.check && report.actionable ? 1 : 0;
  }
} catch (error) { process.stderr.write(`ytdlp-archive-audit: ${error.message}\n`); process.exitCode = 2; }
