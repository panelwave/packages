import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BridgeError } from '../src/errors';
import { resolveAllowed } from '../src/sandbox';

describe('resolveAllowed', () => {
  let root: string;
  let allowed: string;
  let outside: string;

  beforeAll(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-sandbox-')));
    allowed = path.join(root, 'allowed');
    outside = path.join(root, 'outside');
    fs.mkdirSync(path.join(allowed, 'art'), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(allowed, 'art', 'p1.png'), 'x');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  const code = (fn: () => unknown): string | undefined => {
    try {
      fn();
      return undefined;
    } catch (e) {
      return (e as BridgeError).code;
    }
  };

  it('accepts absolute and relative paths inside an allowed folder', () => {
    expect(resolveAllowed(path.join(allowed, 'art', 'p1.png'), [allowed])).toBe(path.join(allowed, 'art', 'p1.png'));
    expect(resolveAllowed('art/p1.png', [allowed])).toBe(path.join(allowed, 'art', 'p1.png'));
    expect(resolveAllowed(allowed, [allowed])).toBe(allowed);
    // not existing yet is fine as long as it stays inside
    expect(resolveAllowed('art/new.png', [allowed])).toBe(path.join(allowed, 'art', 'new.png'));
  });

  it('rejects paths outside every allowed folder with INVALID_INPUT', () => {
    expect(code(() => resolveAllowed(path.join(outside, 'secret.txt'), [allowed]))).toBe('INVALID_INPUT');
    expect(code(() => resolveAllowed('../outside/secret.txt', [allowed]))).toBe('INVALID_INPUT');
    expect(code(() => resolveAllowed('art/../../outside', [allowed]))).toBe('INVALID_INPUT');
    // a sibling that only shares the prefix
    fs.mkdirSync(allowed + '-evil', { recursive: true });
    expect(code(() => resolveAllowed(allowed + '-evil', [allowed]))).toBe('INVALID_INPUT');
    expect(code(() => resolveAllowed('', [allowed]))).toBe('INVALID_INPUT');
    expect(code(() => resolveAllowed('a\0b', [allowed]))).toBe('INVALID_INPUT');
  });

  it('refuses hidden files and folders when asked (pw_local_read_text)', () => {
    fs.mkdirSync(path.join(allowed, '.ssh'), { recursive: true });
    fs.writeFileSync(path.join(allowed, '.ssh', 'id_ed25519'), 'key');
    fs.writeFileSync(path.join(allowed, '.env'), 'SECRET=1');
    expect(code(() => resolveAllowed('.ssh/id_ed25519', [allowed], { allowHidden: false }))).toBe('INVALID_INPUT');
    expect(code(() => resolveAllowed('.env', [allowed], { allowHidden: false }))).toBe('INVALID_INPUT');
    expect(resolveAllowed('art/p1.png', [allowed], { allowHidden: false })).toBe(path.join(allowed, 'art', 'p1.png'));
    // the default (listing, uploads) still resolves them
    expect(resolveAllowed('.env', [allowed])).toBe(path.join(allowed, '.env'));
  });

  it('refuses without any allowed folder', () => {
    expect(code(() => resolveAllowed('art/p1.png', []))).toBe('PRECONDITION_FAILED');
  });

  (process.platform === 'win32' ? it : it.skip)('refuses UNC and device paths before touching the filesystem (no SMB connection)', () => {
    const spy = jest.spyOn(fs.realpathSync, 'native');
    try {
      for (const p of ['//attacker.example/share/x', '\\\\attacker.example\\share\\x', '\\\\?\\C:\\Windows\\win.ini', '\\\\.\\pipe\\x']) {
        expect(code(() => resolveAllowed(p, [allowed]))).toBe('INVALID_INPUT');
      }
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('the error names the allowed folders and the env variable', () => {
    expect(() => resolveAllowed(outside, [allowed])).toThrow(/PANELWAVE_ALLOWED_DIRS/);
  });

  it('checks every allowed folder', () => {
    expect(resolveAllowed(path.join(outside, 'secret.txt'), [allowed, outside])).toBe(path.join(outside, 'secret.txt'));
  });

  it('follows symlinks before checking (a link inside pointing outside is rejected)', () => {
    const link = path.join(allowed, 'escape');
    try {
      fs.symlinkSync(outside, link, 'junction');
    } catch {
      return; // no symlink permission on this machine
    }
    expect(code(() => resolveAllowed('escape/secret.txt', [allowed]))).toBe('INVALID_INPUT');
    expect(code(() => resolveAllowed('escape/not-there-yet.txt', [allowed]))).toBe('INVALID_INPUT');
  });

  (process.platform === 'win32' ? it : it.skip)('compares case-insensitively on Windows', () => {
    expect(resolveAllowed(path.join(allowed.toUpperCase(), 'ART', 'P1.PNG'), [allowed]).toLowerCase()).toBe(path.join(allowed, 'art', 'p1.png').toLowerCase());
  });
});
