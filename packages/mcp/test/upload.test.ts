import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sha256File, uploadBatch, uploadFiles, type UploadRow } from '../src/upload';
import type { LocalToolContext } from '../src/tool';
import { FakeGateway, MockS3 } from './helpers/fake-gateway';
import { jpegBytes, pngBytes } from './helpers/images';

const MiB = 1024 * 1024;
const WORK = '11111111-1111-1111-1111-111111111111';

let root: string;
let s3: MockS3;
let gw: FakeGateway;

/** A PNG header followed by filler so every file has distinct bytes of the wanted size. */
function png(w: number, h: number, size = 0, seed = 0): Buffer {
  const head = pngBytes(w, h);
  if (size <= head.length) return Buffer.concat([head, Buffer.from([seed & 0xff])]);
  const fill = Buffer.alloc(size - head.length, seed & 0xff);
  return Buffer.concat([head, fill]);
}

function write(rel: string, bytes: Buffer): string {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
  return abs;
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function ctx(extra: Partial<LocalToolContext> = {}): LocalToolContext & { progressLog: Array<[number, number | undefined, string | undefined]> } {
  const progressLog: Array<[number, number | undefined, string | undefined]> = [];
  return {
    allowedDirs: [root],
    callRemote: gw.call,
    progress: async (p, t, m) => {
      progressLog.push([p, t, m]);
    },
    progressLog,
    ...extra,
  };
}

type Out = { files: UploadRow[]; uploaded: number; existing: number; failed: number; folderId?: string; folderCreated?: boolean; totalBytes: number; skipped: string[] };

async function run(args: Record<string, unknown>, c = ctx()) {
  const r = await uploadFiles.call({ workId: WORK, ...args }, c);
  return { r, out: r.structuredContent as unknown as Out, text: r.content[0].text };
}

beforeAll(async () => {
  s3 = new MockS3();
  await s3.start();
});
afterAll(async () => {
  await s3.stop();
});
beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-upload-')));
  s3.objects.clear();
  s3.requests = [];
  s3.failures.clear();
  s3.drops.clear();
  s3.delayMs = 0;
  s3.maxInFlight = 0;
  s3.discard = false;
  s3.sizes.clear();
  gw = new FakeGateway(s3);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('pw_local_upload_files — single uploads', () => {
  it('hashes, reads EXIF-corrected dimensions, PUTs with the signed headers and registers every file', async () => {
    const files = {
      'panels/panel-10.png': png(1024, 1536, 0, 10),
      'panels/panel-2.png': png(2048, 1024, 0, 2),
      'panels/panel-1.jpg': jpegBytes(4000, 3000, 6),
      'panels/notes.txt': Buffer.from('not media'),
    };
    for (const [rel, b] of Object.entries(files)) write(rel, b);

    const { r, out, text } = await run({ folder: 'panels' });
    expect(r.isError).toBeUndefined();
    // natural order, the text file is not media and is left out
    expect(out.files.map((f) => f.filename)).toEqual(['panel-1.jpg', 'panel-2.png', 'panel-10.png']);
    expect(out.files.every((f) => f.ok && f.status === 'uploaded' && f.mode === 'single' && f.assetId)).toBe(true);
    expect(out).toMatchObject({ uploaded: 3, existing: 0, failed: 0 });

    const begins = gw.called('pw_assets_begin_upload');
    expect(begins.map((c) => [c.args.filename, c.args.sha256, c.args.kind, c.args.mimeType, c.args.sizeBytes])).toEqual([
      ['panel-1.jpg', sha(files['panels/panel-1.jpg']), 'image', 'image/jpeg', files['panels/panel-1.jpg'].length],
      ['panel-2.png', sha(files['panels/panel-2.png']), 'image', 'image/png', files['panels/panel-2.png'].length],
      ['panel-10.png', sha(files['panels/panel-10.png']), 'image', 'image/png', files['panels/panel-10.png'].length],
    ]);

    const completes = gw.called('pw_assets_complete_upload');
    const jpg = completes.find((c) => c.args.filename === 'panel-1.jpg')!.args;
    expect(jpg).toMatchObject({ width: 3000, height: 4000, kind: 'image', mimeType: 'image/jpeg' }); // EXIF 6 → swapped
    expect(completes.find((c) => c.args.filename === 'panel-2.png')!.args).toMatchObject({ width: 2048, height: 1024 });
    expect(jpg.multipart).toBeUndefined();

    const puts = s3.puts('/single/');
    expect(puts).toHaveLength(3);
    const pngPut = puts.find((p) => p.path.endsWith('panel-2.png'))!;
    expect(pngPut.headers['content-type']).toBe('image/png');
    expect(pngPut.headers['x-amz-meta-origin']).toBe('panelwave');
    expect(pngPut.bytes).toBe(files['panels/panel-2.png'].length);
    expect(text).toMatch(/^3 uploaded, 0 already in the library, 0 failed/);
    expect(text).toContain('pw_panels_attach_artwork');
  });

  it('leaves video durationMs (and dimensions) to the server', async () => {
    write('clip.mp4', randomBytes(4096));
    const { out } = await run({ paths: ['clip.mp4'] });
    expect(out.files[0]).toMatchObject({ ok: true, kind: 'video', mimeType: 'video/mp4' });
    const args = gw.called('pw_assets_complete_upload')[0].args;
    expect(args.durationMs).toBeUndefined();
    expect(args.width).toBeUndefined();
    expect(args.height).toBeUndefined();
    expect(args.kind).toBe('video');
  });

  it('reports the asset’s final warnings instead of repeating the provisional ones from begin', async () => {
    write('large.png', png(4000, 4000, 6 * MiB, 1));
    const { out } = await run({ paths: ['large.png'] });
    expect(out.files[0]).toMatchObject({ ok: true, mode: 'single' });
    expect(out.files[0].warnings).toEqual(['Larger than 5 MB without an optimized variant — blocks publishing until the OVERSIZED_ASSET fix runs.']);
  });

  it('asks for a fresh URL when storage refuses the presigned one (403)', async () => {
    write('p.png', png(10, 10));
    s3.failures.set('/single/', [403]);
    const { out } = await run({ paths: ['p.png'] }, ctx());
    expect(out.files[0]).toMatchObject({ ok: true, status: 'uploaded', attempts: 2 });
    expect(gw.called('pw_assets_begin_upload')).toHaveLength(2);
  });
});

describe('pw_local_upload_files — multipart', () => {
  it('uploads ≥ 10 MB files in 5 MiB parts, signing each part, and completes with the part list', async () => {
    const big = randomBytes(12 * MiB);
    write('video/big.mov', big);
    const { out } = await run({ paths: ['video/big.mov'] });
    expect(out.files[0]).toMatchObject({ ok: true, status: 'uploaded', mode: 'multipart', kind: 'video', sizeBytes: 12 * MiB, sha256: sha(big) });

    const signs = gw.called('pw_assets_sign_part');
    expect(signs.map((c) => c.args.partNumber)).toEqual([1, 2, 3]);
    const parts = s3.puts('/part/');
    expect(parts.map((p) => p.bytes)).toEqual([5 * MiB, 5 * MiB, 2 * MiB]);
    for (const [i, p] of parts.entries()) {
      expect(s3.objects.get(p.path)!.equals(big.subarray(i * 5 * MiB, Math.min((i + 1) * 5 * MiB, big.length)))).toBe(true);
    }
    const complete = gw.called('pw_assets_complete_upload')[0].args;
    const mp = complete.multipart as { uploadId: string; parts: Array<{ partNumber: number; etag?: string }> };
    expect(mp.parts.map((p) => p.partNumber)).toEqual([1, 2, 3]);
    expect(mp.parts.every((p) => /^"[a-f0-9]{32}"$/.test(p.etag ?? ''))).toBe(true);
    expect(gw.aborted).toEqual([]);
  });

  it('retries a failing part (3 attempts, re-signed each time) and succeeds', async () => {
    write('big.mp4', randomBytes(11 * MiB));
    s3.failures.set('/part/', [500, 503]); // first two part PUTs fail
    const c = ctx();
    const rows = await uploadBatch({
      workId: WORK,
      files: [{ abs: path.join(root, 'big.mp4'), display: 'big.mp4', size: 11 * MiB }],
      callRemote: gw.call,
      skipDuplicates: true,
      concurrency: 3,
      retryDelayMs: 1,
    });
    expect(rows[0]).toMatchObject({ ok: true, attempts: 3 });
    expect(gw.called('pw_assets_sign_part').filter((s) => s.args.partNumber === 1)).toHaveLength(3);
    void c;
  });

  it('retries dropped connections too', async () => {
    write('big.mp4', randomBytes(11 * MiB));
    s3.drops.set('/part/', 1);
    const rows = await uploadBatch({ workId: WORK, files: [{ abs: path.join(root, 'big.mp4'), display: 'big.mp4', size: 11 * MiB }], callRemote: gw.call, skipDuplicates: true, concurrency: 1, retryDelayMs: 1 });
    expect(rows[0]).toMatchObject({ ok: true, attempts: 2 });
  });

  it('gives up after 3 attempts, aborts the multipart upload and says how to resume', async () => {
    write('big.mp4', randomBytes(11 * MiB));
    s3.failures.set('/part/', [500, 500, 500]);
    const rows = await uploadBatch({ workId: WORK, files: [{ abs: path.join(root, 'big.mp4'), display: 'big.mp4', size: 11 * MiB }], callRemote: gw.call, skipDuplicates: true, concurrency: 1, retryDelayMs: 1 });
    expect(rows[0]).toMatchObject({ ok: false, status: 'failed', error: { code: 'UPSTREAM_UNAVAILABLE' } });
    expect(rows[0].error!.message).toMatch(/HTTP 500.*Gave up after 3 attempts.*run the tool again/);
    expect(gw.aborted).toHaveLength(1);
    expect(gw.called('pw_assets_complete_upload')).toHaveLength(0);
  });

  it('does not retry a storage answer that retrying cannot fix (400)', async () => {
    write('p.png', png(10, 10));
    s3.failures.set('/single/', [400]);
    const rows = await uploadBatch({ workId: WORK, files: [{ abs: path.join(root, 'p.png'), display: 'p.png', size: fs.statSync(path.join(root, 'p.png')).size }], callRemote: gw.call, skipDuplicates: true, concurrency: 1, retryDelayMs: 1 });
    expect(rows[0]).toMatchObject({ ok: false, error: { code: 'UPSTREAM_UNAVAILABLE' } });
    expect(s3.puts('/single/')).toHaveLength(1);
  });
});

describe('pw_local_upload_files — duplicates, folders, errors', () => {
  it('skips content already in the library (mode "exists") and files the reused asset into the folder', async () => {
    const bytes = png(640, 480, 0, 7);
    write('a/known.png', bytes);
    write('a/new.png', png(640, 480, 0, 8));
    const existingId = gw.seedAsset(sha(bytes), 'old-name.png');

    const { out, text } = await run({ folder: 'a', folderName: 'Chapter 1/Panels' });
    const known = out.files.find((f) => f.filename === 'known.png')!;
    expect(known).toMatchObject({ ok: true, status: 'exists', deduplicated: true, assetId: existingId });
    expect(s3.puts().map((p) => path.basename(p.path))).toEqual(['new.png']);
    expect(out).toMatchObject({ uploaded: 1, existing: 1, failed: 0, folderCreated: true });

    // nested folder created segment by segment, new upload filed via complete, reused one via assign
    expect(gw.folders.map((f) => f.path)).toEqual(['Chapter 1', 'Chapter 1/Panels']);
    expect(out.folderId).toBe(gw.folders[1].id);
    expect(gw.called('pw_assets_complete_upload')[0].args.folderId).toBe(out.folderId);
    expect(gw.called('pw_folders_manage').find((c) => c.args.action === 'assign')!.args).toMatchObject({ assetIds: [existingId], folderIds: [out.folderId], mode: 'add' });
    expect(text).toContain('1 already in the library');
  });

  it('re-uses an existing folder with the same path (case-insensitive) instead of creating it', async () => {
    write('p.png', png(10, 10));
    gw.folders.push({ id: 'f-1', name: 'Panels', path: 'Panels' });
    const { out } = await run({ paths: ['p.png'], folderName: 'panels' });
    expect(out).toMatchObject({ folderId: 'f-1', folderCreated: false });
    expect(gw.called('pw_folders_manage').filter((c) => c.args.action === 'create')).toHaveLength(0);
  });

  it('uploads identical files in one batch only once', async () => {
    const same = png(100, 100, 0, 3);
    write('twins/a.png', same);
    write('twins/b.png', same);
    const { out } = await run({ folder: 'twins' });
    expect(out.files.map((f) => [f.filename, f.status])).toEqual([
      ['a.png', 'uploaded'],
      ['b.png', 'exists'],
    ]);
    expect(out.files[1].assetId).toBe(out.files[0].assetId);
    expect(s3.puts()).toHaveLength(1);
  });

  it('skipDuplicates: false reports existing content as CONFLICT instead of reusing it', async () => {
    const bytes = png(10, 10, 0, 9);
    write('k.png', bytes);
    gw.seedAsset(sha(bytes), 'k.png');
    const { out } = await run({ paths: ['k.png'], skipDuplicates: false });
    expect(out.files[0]).toMatchObject({ ok: false, status: 'failed', error: { code: 'CONFLICT' } });
    expect(out.failed).toBe(1);
  });

  it('a re-run resumes: finished files are recognised, only the rest is uploaded', async () => {
    write('r/1.png', png(10, 10, 0, 1));
    write('r/2.png', png(10, 10, 0, 2));
    gw.failOnce.set('pw_assets_complete_upload', { code: 'UPSTREAM_UNAVAILABLE', message: 'CMS API unavailable' });
    const first = await run({ folder: 'r', concurrency: 1 });
    expect(first.out.files.map((f) => f.status)).toEqual(['failed', 'uploaded']);
    expect(first.text).toContain('Run the tool again');
    const second = await run({ folder: 'r', concurrency: 1 });
    expect(second.out.files.map((f) => f.status)).toEqual(['uploaded', 'exists']);
  });

  it('passes remote tool errors through with their code (e.g. QUOTA_EXCEEDED)', async () => {
    write('q.png', png(10, 10));
    gw.failOnce.set('pw_assets_begin_upload', { code: 'QUOTA_EXCEEDED', message: 'Storage quota of the Free plan reached.' });
    const { out } = await run({ paths: ['q.png'] });
    expect(out.files[0]).toMatchObject({ ok: false, error: { code: 'QUOTA_EXCEEDED', message: 'Storage quota of the Free plan reached.' } });
  });

  it('explicit non-media paths fail per row; paths outside the sandbox fail the call', async () => {
    write('script.md', Buffer.from('# hi'));
    write('p.png', png(10, 10));
    const { out } = await run({ paths: ['script.md', 'p.png'] });
    expect(out.files.map((f) => [f.filename, f.ok, f.error?.code])).toEqual([
      ['script.md', false, 'INVALID_INPUT'],
      ['p.png', true, undefined],
    ]);
    const outside = await uploadFiles.call({ workId: WORK, paths: [path.join(os.tmpdir(), 'elsewhere.png')] }, ctx());
    expect(outside.structuredContent).toMatchObject({ code: 'INVALID_INPUT' });
    const none = await uploadFiles.call({ workId: WORK }, ctx());
    expect(none.structuredContent).toMatchObject({ code: 'INVALID_INPUT' });
    fs.mkdirSync(path.join(root, 'empty'));
    const empty = await uploadFiles.call({ workId: WORK, folder: 'empty' }, ctx());
    expect(empty.structuredContent).toMatchObject({ code: 'NOT_FOUND' });
    const offline = await uploadFiles.call({ workId: WORK, paths: ['p.png'] }, { allowedDirs: [root] });
    expect(offline.structuredContent).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
  });
});

describe('pw_local_upload_files — concurrency and progress', () => {
  it('keeps at most `concurrency` files in flight', async () => {
    for (let i = 1; i <= 6; i++) write(`c/p${i}.png`, png(10, 10, 0, i));
    s3.delayMs = 60;
    await run({ folder: 'c' });
    expect(s3.maxInFlight).toBe(3);
    s3.maxInFlight = 0;
    for (let i = 7; i <= 9; i++) write(`d/p${i}.png`, png(10, 10, 0, i));
    await run({ folder: 'd', concurrency: 1 });
    expect(s3.maxInFlight).toBe(1);
  });

  it('reports monotonic byte progress ending at the total', async () => {
    write('m/big.mp4', randomBytes(11 * MiB));
    for (let i = 1; i <= 3; i++) write(`m/p${i}.png`, png(10, 10, 12 * 1024, i));
    const c = ctx();
    const { out } = await run({ folder: 'm' }, c);
    const values = c.progressLog.map(([p]) => p);
    expect(values.length).toBeGreaterThan(2);
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThan(values[i - 1]);
    expect(values[values.length - 1]).toBe(out.totalBytes);
    expect(c.progressLog.every(([, t]) => t === out.totalBytes)).toBe(true);
    expect(c.progressLog.some(([, , m]) => /part 2\/3/.test(m ?? ''))).toBe(true);
  });
});

describe('sha256File', () => {
  it('streams the file hash', async () => {
    const b = randomBytes(3 * MiB + 17);
    const f = write('h.bin', b);
    expect(await sha256File(f)).toBe(sha(b));
  });
});

(process.env.MCP_BIG_UPLOAD === '1' ? describe : describe.skip)('pw_local_upload_files — 100 MB video (opt-in: MCP_BIG_UPLOAD=1)', () => {
  it('streams a 100 MB file part by part without buffering it whole', async () => {
    const size = 100 * MiB;
    const file = path.join(root, 'huge.mp4');
    const fd = fs.openSync(file, 'w');
    const block = randomBytes(MiB);
    for (let i = 0; i < 100; i++) fs.writeSync(fd, block);
    fs.closeSync(fd);
    s3.discard = true; // keep only sizes in the mock storage
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fsp = require('node:fs/promises') as typeof import('node:fs/promises');
    const readFile = jest.spyOn(fsp, 'readFile');
    const before = process.memoryUsage().rss;
    let peak = before;
    const timer = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 5);
    const t0 = Date.now();
    try {
      const { out } = await run({ paths: ['huge.mp4'] });
      expect(out.files[0]).toMatchObject({ ok: true, mode: 'multipart', sizeBytes: size });
      expect(gw.called('pw_assets_sign_part')).toHaveLength(20);
      expect(s3.puts('/part/').every((p) => p.bytes <= 5 * MiB)).toBe(true);
      expect([...s3.sizes.values()].reduce((a, b) => a + b, 0)).toBe(size);
      // never read whole — parts are read one at a time right before their PUT
      expect(readFile.mock.calls.filter((c) => String(c[0]).endsWith('huge.mp4'))).toHaveLength(0);
    } finally {
      clearInterval(timer);
      readFile.mockRestore();
    }
    // informational only: RSS depends on when V8 collects the part buffers
    process.stdout.write(`100 MB upload: ${Date.now() - t0} ms, peak RSS growth ${((peak - before) / MiB).toFixed(0)} MB\n`);
  }, 120_000);
});
