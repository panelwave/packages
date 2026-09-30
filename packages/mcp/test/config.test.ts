import * as path from 'node:path';
import { ConfigError, DEFAULT_URL, loadConfig, version } from '../src/config';

describe('loadConfig', () => {
  const cwd = path.resolve('/work/comics');

  it('refuses to start without PANELWAVE_TOKEN and says where to get one', () => {
    expect(() => loadConfig({}, cwd)).toThrow(ConfigError);
    expect(() => loadConfig({ PANELWAVE_TOKEN: '   ' }, cwd)).toThrow(/PANELWAVE_TOKEN is not set.*personal access token/);
  });

  it('defaults the endpoint to the hosted server and the allowed folder to the working directory', () => {
    const c = loadConfig({ PANELWAVE_TOKEN: 'pw_pat_x' }, cwd);
    expect(c.url).toBe(DEFAULT_URL);
    expect(c.token).toBe('pw_pat_x');
    expect(c.allowedDirs).toEqual([cwd]);
    expect(c.version).toBe(version);
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('splits PANELWAVE_ALLOWED_DIRS on the platform delimiter and resolves relative entries', () => {
    const env = { PANELWAVE_TOKEN: 't', PANELWAVE_ALLOWED_DIRS: ['art', '', path.resolve('/scripts')].join(path.delimiter) };
    expect(loadConfig(env, cwd).allowedDirs).toEqual([path.join(cwd, 'art'), path.resolve('/scripts')]);
  });

  it('accepts https anywhere and plain http only for localhost', () => {
    expect(loadConfig({ PANELWAVE_TOKEN: 't', PANELWAVE_MCP_URL: 'https://mcp.example.org/mcp' }, cwd).url).toBe('https://mcp.example.org/mcp');
    expect(loadConfig({ PANELWAVE_TOKEN: 't', PANELWAVE_MCP_URL: 'http://localhost:3020/mcp' }, cwd).url).toBe('http://localhost:3020/mcp');
    expect(() => loadConfig({ PANELWAVE_TOKEN: 't', PANELWAVE_MCP_URL: 'http://mcp.example.org/mcp' }, cwd)).toThrow(/https/);
    expect(() => loadConfig({ PANELWAVE_TOKEN: 't', PANELWAVE_MCP_URL: 'not a url' }, cwd)).toThrow(/not a URL/);
  });
});
