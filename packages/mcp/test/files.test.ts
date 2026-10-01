import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { decodeUtf8, globToRegExp, imageDimensions, kindOfMime, looksBinary, matchesGlob, mimeOf, naturalCompare } from '../src/files';
import { jpegBytes, pngBytes } from './helpers/images';

describe('mime and kind', () => {
  it.each([
    ['p1.PNG', 'image/png', 'image'],
    ['p2.jpeg', 'image/jpeg', 'image'],
    ['clip.mov', 'video/quicktime', 'video'],
    ['rain.mp3', 'audio/mpeg', 'audio'],
    ['font.woff2', 'font/woff2', 'font'],
    ['script.fountain', 'text/x-fountain', 'text'],
    ['outline.json', 'application/json', 'text'],
    ['notes.md', 'text/markdown', 'text'],
    ['archive.zip', 'application/zip', 'other'],
    ['noext', 'application/octet-stream', 'other'],
  ])('%s → %s / %s', (name, mime, kind) => {
    expect(mimeOf(name)).toBe(mime);
    expect(kindOfMime(mimeOf(name))).toBe(kind);
  });
});

describe('glob', () => {
  it('supports * ? {a,b} and ; separated patterns, case-insensitively', () => {
    expect(matchesGlob('panel-01.PNG', '*.{png,jpg}')).toBe(true);
    expect(matchesGlob('panel-01.webp', '*.{png,jpg}')).toBe(false);
    expect(matchesGlob('p1.png', 'p?.png')).toBe(true);
    expect(matchesGlob('p10.png', 'p?.png')).toBe(false);
    expect(matchesGlob('script.md', '*.png; *.md')).toBe(true);
    expect(matchesGlob('a.b+c(1).png', 'a.b+c(1).png')).toBe(true);
    expect(matchesGlob('anything', undefined)).toBe(true);
    expect(() => globToRegExp('*.{png')).toThrow(/Unbalanced/);
  });
});

describe('naturalCompare', () => {
  it('orders numbered panels naturally', () => {
    expect(['p10.png', 'p2.png', 'P1.png'].sort(naturalCompare)).toEqual(['P1.png', 'p2.png', 'p10.png']);
  });
});

describe('text helpers', () => {
  it('detects binary content by NUL bytes', () => {
    expect(looksBinary(Buffer.from('plain text'))).toBe(false);
    expect(looksBinary(pngBytes(1, 1))).toBe(true);
  });

  it('strips a BOM and drops a cut multi-byte sequence', () => {
    const full = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Grüße 🌊', 'utf8')]);
    expect(decodeUtf8(full, false)).toBe('Grüße 🌊');
    // cut inside the 4-byte emoji
    expect(decodeUtf8(full.subarray(0, full.length - 2), true)).toBe('Grüße ');
    // cut inside ü (2 bytes)
    const g = Buffer.from('Grü', 'utf8');
    expect(decodeUtf8(g.subarray(0, 3), true)).toBe('Gr');
  });
});

describe('imageDimensions', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-img-'));
    fs.writeFileSync(path.join(dir, 'a.png'), pngBytes(1200, 1800));
    fs.writeFileSync(path.join(dir, 'upright.jpg'), jpegBytes(4000, 3000, 1));
    fs.writeFileSync(path.join(dir, 'rotated.jpg'), jpegBytes(4000, 3000, 6));
    fs.writeFileSync(path.join(dir, 'plain.jpg'), jpegBytes(640, 480));
    fs.writeFileSync(path.join(dir, 'broken.png'), 'not an image');
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reads PNG and JPEG sizes', async () => {
    expect(await imageDimensions(path.join(dir, 'a.png'))).toEqual({ width: 1200, height: 1800 });
    expect(await imageDimensions(path.join(dir, 'plain.jpg'))).toEqual({ width: 640, height: 480 });
  });

  it('applies EXIF orientation (5–8 swap width and height)', async () => {
    expect(await imageDimensions(path.join(dir, 'upright.jpg'))).toEqual({ width: 4000, height: 3000, orientation: 1 });
    expect(await imageDimensions(path.join(dir, 'rotated.jpg'))).toEqual({ width: 3000, height: 4000, orientation: 6 });
  });

  it('returns undefined for unreadable images', async () => {
    expect(await imageDimensions(path.join(dir, 'broken.png'))).toBeUndefined();
  });
});
