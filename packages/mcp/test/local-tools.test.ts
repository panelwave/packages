import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { listFiles, readText, type LocalFile, type LocalToolContext } from '../src/local-tools';
import { jpegBytes, pngBytes } from './helpers/images';

let root: string;
let allowed: string;
let ctx: LocalToolContext;

beforeAll(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-local-')));
  allowed = path.join(root, 'comic');
  fs.mkdirSync(path.join(allowed, 'art', 'ch2'), { recursive: true });
  fs.mkdirSync(path.join(allowed, 'node_modules', 'x'), { recursive: true });
  fs.mkdirSync(path.join(allowed, '.cache'), { recursive: true });
  fs.mkdirSync(path.join(root, 'private'), { recursive: true });
  fs.writeFileSync(path.join(allowed, 'art', 'panel-10.png'), pngBytes(1024, 1536));
  fs.writeFileSync(path.join(allowed, 'art', 'panel-2.png'), pngBytes(2048, 1024));
  fs.writeFileSync(path.join(allowed, 'art', 'panel-1.jpg'), jpegBytes(4000, 3000, 6));
  fs.writeFileSync(path.join(allowed, 'art', 'ch2', 'panel-3.webp'), 'RIFF....WEBP'); // unreadable header → no dimensions
  fs.writeFileSync(path.join(allowed, 'art', '.DS_Store'), 'x');
  fs.writeFileSync(path.join(allowed, 'node_modules', 'x', 'skip.png'), pngBytes(1, 1));
  fs.writeFileSync(path.join(allowed, '.cache', 'hidden.png'), pngBytes(1, 1));
  fs.writeFileSync(path.join(allowed, 'script.fountain'), 'INT. ROOFTOP - NIGHT\n\nMIRA\nThe city never sleeps.\n');
  fs.writeFileSync(path.join(allowed, 'bom.md'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# Titel — Grüße', 'utf8')]));
  fs.writeFileSync(path.join(allowed, 'long.txt'), 'ä'.repeat(1000)); // 2000 bytes
  fs.writeFileSync(path.join(root, 'private', 'diary.txt'), 'secret');
  ctx = { allowedDirs: [allowed] };
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

type ListData = { folder: string; files: LocalFile[]; count: number; truncated: boolean; totalSizeBytes: number; byKind: Record<string, number>; skipped: string[] };

describe('pw_local_list_files', () => {
  it('lists files with mime, kind and EXIF-corrected image dimensions, sorted naturally', async () => {
    const r = await listFiles.call({ folder: 'art' }, ctx);
    expect(r.isError).toBeUndefined();
    const data = r.structuredContent as unknown as ListData;
    expect(data.folder).toBe(path.join(allowed, 'art'));
    expect(data.files.map((f) => f.name)).toEqual(['panel-1.jpg', 'panel-2.png', 'panel-10.png']);
    const [p1, p2] = data.files;
    expect(p1).toMatchObject({ path: path.join(allowed, 'art', 'panel-1.jpg'), relativePath: 'panel-1.jpg', mime: 'image/jpeg', kind: 'image', width: 3000, height: 4000, orientation: 6 });
    expect(p2).toMatchObject({ mime: 'image/png', kind: 'image', width: 2048, height: 1024, sizeBytes: fs.statSync(path.join(allowed, 'art', 'panel-2.png')).size });
    expect(p2.orientation).toBeUndefined();
    expect(Date.parse(p2.modifiedAt)).not.toBeNaN();
    expect(data).toMatchObject({ count: 3, truncated: false, byKind: { image: 3 } });
    expect(r.content[0].text).toContain('3 files in');
    expect(r.content[0].text).toContain('panel-2.png (');
    expect(r.content[0].text).toContain('2048×1024');
  });

  it('recurses into subfolders but skips node_modules and hidden entries', async () => {
    const r = await listFiles.call({ folder: allowed, recursive: true, glob: '*.{png,jpg,webp}' }, ctx);
    const data = r.structuredContent as unknown as ListData;
    expect(data.files.map((f) => f.relativePath)).toEqual(['art/panel-1.jpg', 'art/panel-2.png', 'art/panel-10.png', 'art/ch2/panel-3.webp']);
    const webp = data.files[3];
    expect(webp).toMatchObject({ mime: 'image/webp', kind: 'image' });
    expect(webp.width).toBeUndefined();

    const hidden = await listFiles.call({ folder: allowed, recursive: true, includeHidden: true, glob: '*.png' }, ctx);
    expect((hidden.structuredContent as unknown as ListData).files.map((f) => f.relativePath)).toContain('.cache/hidden.png');
    expect((hidden.structuredContent as unknown as ListData).files.map((f) => f.relativePath)).not.toContain('node_modules/x/skip.png');
  });

  it('filters by glob, flags truncation at the limit and can skip dimension probing', async () => {
    const r = await listFiles.call({ folder: 'art', glob: '*.png', limit: 1, dimensions: false }, ctx);
    const data = r.structuredContent as unknown as ListData;
    expect(data.files).toHaveLength(1);
    expect(data.files[0].name).toBe('panel-2.png');
    expect(data.files[0].width).toBeUndefined();
    expect(data.truncated).toBe(true);
    expect(r.content[0].text).toContain('truncated at 1');
  });

  it('text files get kind "text"', async () => {
    const r = await listFiles.call({ folder: '.', glob: '*.fountain;*.md' }, ctx);
    const data = r.structuredContent as unknown as ListData;
    expect(data.files.map((f) => [f.name, f.mime, f.kind])).toEqual([
      ['bom.md', 'text/markdown', 'text'],
      ['script.fountain', 'text/x-fountain', 'text'],
    ]);
  });

  it('a folder outside the allowed folders is INVALID_INPUT', async () => {
    for (const folder of [path.join(root, 'private'), '../private', root]) {
      const r = await listFiles.call({ folder }, ctx);
      expect(r.isError).toBe(true);
      expect(r.structuredContent).toMatchObject({ code: 'INVALID_INPUT' });
      expect(r.content[0].text).toMatch(/^INVALID_INPUT: .*PANELWAVE_ALLOWED_DIRS/);
    }
  });

  it('missing folder → NOT_FOUND, a file → INVALID_INPUT, bad args → INVALID_INPUT', async () => {
    expect((await listFiles.call({ folder: 'nope' }, ctx)).structuredContent).toMatchObject({ code: 'NOT_FOUND' });
    expect((await listFiles.call({ folder: 'script.fountain' }, ctx)).structuredContent).toMatchObject({ code: 'INVALID_INPUT' });
    const bad = await listFiles.call({ folder: 'art', limit: 0 }, ctx);
    expect(bad.structuredContent).toMatchObject({ code: 'INVALID_INPUT' });
    expect(bad.content[0].text).toContain('limit');
  });

  it('declares JSON input/output schemas and read-only annotations', () => {
    expect(listFiles.inputSchema).toMatchObject({ type: 'object', required: ['folder'] });
    expect(listFiles.outputSchema).toMatchObject({ type: 'object' });
    expect(listFiles.inputSchema.$schema).toBeUndefined();
    expect(listFiles.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
  });
});

describe('pw_local_read_text', () => {
  it('reads a whole file', async () => {
    const r = await readText.call({ path: 'script.fountain' }, ctx);
    expect(r.structuredContent).toMatchObject({ name: 'script.fountain', mime: 'text/x-fountain', truncated: false, text: 'INT. ROOFTOP - NIGHT\n\nMIRA\nThe city never sleeps.\n' });
    expect(r.content[0].text).toContain('MIRA');
  });

  it('strips a UTF-8 BOM', async () => {
    const r = await readText.call({ path: path.join(allowed, 'bom.md') }, ctx);
    expect((r.structuredContent as { text: string }).text).toBe('# Titel — Grüße');
  });

  it('truncates at maxBytes on a character boundary and says so', async () => {
    const r = await readText.call({ path: 'long.txt', maxBytes: 101 }, ctx);
    const d = r.structuredContent as { text: string; truncated: boolean; sizeBytes: number; returnedBytes: number };
    expect(d.truncated).toBe(true);
    expect(d.sizeBytes).toBe(2000);
    expect(d.text).toBe('ä'.repeat(50)); // 101 bytes would split the 51st "ä"
    expect(d.returnedBytes).toBe(100);
    expect(r.content[0].text).toMatch(/truncated/);
  });

  it('refuses binary files, folders and paths outside the sandbox', async () => {
    expect((await readText.call({ path: 'art/panel-2.png' }, ctx)).structuredContent).toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect((await readText.call({ path: 'art' }, ctx)).structuredContent).toMatchObject({ code: 'INVALID_INPUT' });
    expect((await readText.call({ path: '../private/diary.txt' }, ctx)).structuredContent).toMatchObject({ code: 'INVALID_INPUT' });
    expect((await readText.call({ path: 'missing.txt' }, ctx)).structuredContent).toMatchObject({ code: 'NOT_FOUND' });
    expect((await readText.call({ path: 'long.txt', maxBytes: 6 * 1024 * 1024 }, ctx)).structuredContent).toMatchObject({ code: 'INVALID_INPUT' });
  });
});
