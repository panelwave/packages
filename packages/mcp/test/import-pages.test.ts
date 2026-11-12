import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { importPages, sniffImportKind } from '../src/import-pages';
import type { LocalToolContext, RemoteCaller, RemoteResult } from '../src/tool';
import { MockS3 } from './helpers/fake-gateway';
import { pngBytes } from './helpers/images';

const MiB = 1024 * 1024;
const SID = '6698f158-da44-456d-9c19-072680dddbf8';

let root: string;
let s3: MockS3;

/**
 * Stand-in for the hosted page-import tools: answers create with presigned
 * targets on MockS3 (multipart from 16 MiB, 8 MiB parts), confirm/status with
 * a session that "unpacks" its sources after `expandPolls` status calls.
 */
class FakeImportGateway {
  calls: Array<{ name: string; args: Record<string, any> }> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  expandPolls = 1;
  private polls = 0;
  private sources: Array<Record<string, unknown>> = [];
  private pageCount = 0;

  constructor(private readonly s3: MockS3) {}

  private ok(data: Record<string, unknown>): RemoteResult {
    return { content: [{ type: 'text', text: 'ok' }], structuredContent: data };
  }

  private session(): Record<string, unknown> {
    const expanding = this.sources.some((s) => s.status === 'expanding');
    return { sessionId: SID, status: expanding ? 'expanding' : 'uploading', pageCount: this.pageCount, sources: this.sources, next: '' };
  }

  call: RemoteCaller = async (name, args) => {
    this.calls.push({ name, args });
    if (name === 'pw_import_pages_create') {
      let pageIndex = 0;
      const uploads = (args.files as Array<Record<string, any>>).map((f, i) => { // eslint-disable-line @typescript-eslint/no-explicit-any
        if (f.kind === 'page') return { fileName: f.fileName, kind: f.kind, pageIndex: pageIndex++, method: 'PUT', uploadUrl: `${this.s3.base}/page/${i}`, headers: { 'Content-Type': f.mimeType } };
        const sourceId = `src${i}`;
        this.sources.push({ sourceId, name: f.fileName, kind: f.kind, status: 'awaiting_upload', pageCount: 0 });
        if (f.sizeBytes >= 16 * MiB) {
          const partCount = Math.ceil(f.sizeBytes / (8 * MiB));
          return { fileName: f.fileName, kind: f.kind, sourceId, method: 'PUT', partSize: 8 * MiB, parts: Array.from({ length: partCount }, (_, n) => ({ partNumber: n + 1, url: `${this.s3.base}/src/${sourceId}/${n + 1}` })) };
        }
        return { fileName: f.fileName, kind: f.kind, sourceId, method: 'PUT', uploadUrl: `${this.s3.base}/src/${sourceId}`, headers: { 'Content-Type': 'application/zip' } };
      });
      this.pageCount = pageIndex;
      return this.ok({ sessionId: SID, uploads });
    }
    if (name === 'pw_import_pages_confirm') {
      for (const id of (args.sourceIds as string[]) ?? []) {
        const s = this.sources.find((x) => x.sourceId === id)!;
        s.status = 'expanding';
      }
      return this.ok(this.session());
    }
    if (name === 'pw_import_pages_status') {
      if (++this.polls >= this.expandPolls) {
        for (const s of this.sources) {
          if (s.status === 'expanding') {
            s.status = 'done';
            s.pageCount = 3;
            this.pageCount += 3;
          }
        }
      }
      return this.ok(this.session());
    }
    if (name === 'pw_import_pages_detect') return this.ok({ jobId: `import-pages:${SID}`, status: 'detect_queued' });
    return { isError: true, content: [{ type: 'text', text: 'unknown' }], structuredContent: { code: 'NOT_FOUND', message: name } };
  };
}

function write(rel: string, bytes: Buffer): string {
  const abs = path.join(root, rel);
  fs.writeFileSync(abs, bytes);
  return abs;
}

function ctx(gw: FakeImportGateway): LocalToolContext {
  return { allowedDirs: [root], callRemote: gw.call };
}

beforeAll(async () => {
  s3 = new MockS3();
  await s3.start();
});
afterAll(async () => {
  await s3.stop();
});
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-import-pages-'));
  s3.requests = [];
  s3.objects.clear();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('sniffImportKind', () => {
  it('reads the kind from the bytes', () => {
    expect(sniffImportKind(pngBytes(10, 10))).toBe('png');
    expect(sniffImportKind(Buffer.from('PK\x03\x04rest'))).toBe('zip');
    expect(sniffImportKind(Buffer.from('%PDF-1.7'))).toBe('pdf');
    expect(sniffImportKind(Buffer.from('Rar!\x1a\x07\x00'))).toBe('rar');
    expect(sniffImportKind(Buffer.from('hello'))).toBe('unknown');
  });
});

describe('pw_local_import_pages', () => {
  it('uploads pages and archives, waits for unpacking and starts detection', async () => {
    const gw = new FakeImportGateway(s3);
    gw.expandPolls = 2;
    const page = write('p1.png', Buffer.concat([pngBytes(1000, 1500), Buffer.alloc(100, 1)]));
    const strip = write('ep1.png', Buffer.concat([pngBytes(800, 6000), Buffer.alloc(50, 2)]));
    const cbz = write('chapter-01.cbz', Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(2000, 3)]));
    const r = await importPages.call({ paths: [page, cbz, strip], lettering: 'editable', sourceLocale: 'ja-JP', workTitle: 'Lantern' }, ctx(gw));
    expect(r.isError).toBeUndefined();
    const out = r.structuredContent as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

    const create = gw.calls.find((c) => c.name === 'pw_import_pages_create')!.args;
    expect(create.files.map((f: Record<string, unknown>) => [f.fileName, f.kind])).toEqual([
      ['p1.png', 'page'],
      ['chapter-01.cbz', 'cbz'],
      ['ep1.png', 'strip'],
    ]);
    expect(create).toMatchObject({ lettering: 'editable', sourceLocale: 'ja-JP', target: { workTitle: 'Lantern' } });

    // Bytes reached storage with the server's headers.
    expect(s3.objects.get('/page/0')?.length).toBe(fs.statSync(page).size);
    expect(s3.objects.get('/src/src1')?.length).toBe(fs.statSync(cbz).size);
    expect(s3.puts('/page/')[0].headers['content-type']).toBe('image/png');

    const confirm = gw.calls.find((c) => c.name === 'pw_import_pages_confirm')!.args;
    expect(confirm).toEqual({ sessionId: SID, pages: [{ pageIndex: 0, width: 1000, height: 1500 }], sourceIds: ['src1', 'src2'] });
    expect(gw.calls.filter((c) => c.name === 'pw_import_pages_status').length).toBe(2);
    expect(out).toMatchObject({ sessionId: SID, detectionStarted: true, jobId: `import-pages:${SID}`, pageCount: 7, status: 'detect_queued' });
    expect(r.content[0].text).toContain('chapter-01.cbz: done, 3 page(s)');
  });

  it('uploads a big PDF in its pre-signed parts', async () => {
    const gw = new FakeImportGateway(s3);
    const pdf = write('volume.pdf', Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(17 * MiB, 4)]));
    const r = await importPages.call({ paths: [pdf], detect: false }, ctx(gw));
    expect(r.isError).toBeUndefined();
    const parts = s3.puts('/src/src0/');
    expect(parts.map((p) => p.bytes)).toEqual([8 * MiB, 8 * MiB, fs.statSync(pdf).size - 16 * MiB]);
    expect(parts[0].headers['content-type']).toBeUndefined();
    expect(gw.calls.some((c) => c.name === 'pw_import_pages_detect')).toBe(false);
    expect((r.structuredContent as Record<string, unknown>).detectionStarted).toBe(false);
  });

  it('returns before detection when unpacking takes longer than waitSeconds', async () => {
    const gw = new FakeImportGateway(s3);
    gw.expandPolls = 1000;
    const cbz = write('c.cbz', Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(10, 1)]));
    const r = await importPages.call({ paths: [cbz], waitSeconds: 0 }, ctx(gw));
    const out = r.structuredContent as Record<string, unknown>;
    expect(out.status).toBe('expanding');
    expect(out.detectionStarted).toBe(false);
    expect(String(out.next)).toMatch(/pw_import_pages_detect/);
  });

  it('refuses CBR, unknown files, folders and files outside the allowed folders', async () => {
    const gw = new FakeImportGateway(s3);
    const cbr = write('old.cbr', Buffer.from('Rar!\x1a\x07\x00 old'));
    expect((await importPages.call({ paths: [cbr] }, ctx(gw))).content[0].text).toMatch(/convert it to CBZ/);
    const txt = write('notes.txt', Buffer.from('plain text'));
    expect((await importPages.call({ paths: [txt] }, ctx(gw))).content[0].text).toMatch(/not a PNG/);
    expect((await importPages.call({ paths: [root] }, ctx(gw))).content[0].text).toMatch(/is a folder/);
    const outside = path.join(os.tmpdir(), 'outside-the-sandbox.png');
    expect((await importPages.call({ paths: [outside] }, ctx(gw))).isError).toBe(true);
    expect(gw.calls).toHaveLength(0);
  });

  it('needs the server connection', async () => {
    const page = write('p.png', pngBytes(10, 10));
    const r = await importPages.call({ paths: [page] }, { allowedDirs: [root] });
    expect(r.content[0].text).toMatch(/UPSTREAM_UNAVAILABLE/);
  });
});
