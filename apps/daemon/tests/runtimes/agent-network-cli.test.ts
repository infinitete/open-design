import { describe, expect, it, vi } from 'vitest';

import type { AgentNetworkPrefs } from '@open-design/contracts';

import {
  mergeAgentNetworkCliUpdate,
  parseAgentNetworkProxyCommand,
} from '../../src/runtimes/agent-network-cli.js';

describe('parseAgentNetworkProxyCommand', () => {
  const unread = vi.fn(async (_path: string) => 'unused');

  it.each(['get', 'test', 'unset'] as const)('parses %s with exactly one CLI ID', async (verb) => {
    await expect(parseAgentNetworkProxyCommand([verb, 'codex'], unread)).resolves.toEqual({
      verb,
      agentId: 'codex',
    });
  });

  it('parses every set field and removes exactly one trailing newline from a password file', async () => {
    const readPasswordFile = vi.fn(async () => '  p@ss\nword  \r\n');

    await expect(parseAgentNetworkProxyCommand([
      'set', 'codex',
      '--mode', 'custom',
      '--url', 'http://proxy.test:8080',
      '--no-proxy', 'localhost,127.0.0.1',
      '--username', 'alice',
      '--password-file', '/tmp/proxy-secret',
    ], readPasswordFile)).resolves.toEqual({
      verb: 'set',
      agentId: 'codex',
      mode: 'custom',
      proxyUrl: 'http://proxy.test:8080',
      noProxy: 'localhost,127.0.0.1',
      username: 'alice',
      password: '  p@ss\nword  ',
    });
    expect(readPasswordFile).toHaveBeenCalledWith('/tmp/proxy-secret');
  });

  it('preserves a trailing CR that is not part of CRLF', async () => {
    await expect(parseAgentNetworkProxyCommand([
      'set', 'codex', '--mode', 'custom', '--url', 'socks5://proxy.test',
      '--password-file', '-',
    ], async () => 'secret\r')).resolves.toMatchObject({ password: 'secret\r' });
  });

  it('accepts direct and inherit as the other exact set modes', async () => {
    await expect(parseAgentNetworkProxyCommand(
      ['set', 'codex', '--mode', 'direct'], unread,
    )).resolves.toEqual({ verb: 'set', agentId: 'codex', mode: 'direct' });
    await expect(parseAgentNetworkProxyCommand(
      ['set', 'codex', '--mode', 'inherit'], unread,
    )).resolves.toEqual({ verb: 'set', agentId: 'codex', mode: 'inherit' });
  });

  it.each([
    { args: ['get'], message: 'CLI ID' },
    { args: ['get', 'codex', 'extra'], message: 'exactly one CLI ID' },
    { args: ['set', 'codex'], message: '--mode' },
    { args: ['set', 'codex', '--mode', 'system'], message: 'inherit|direct|custom' },
    { args: ['set', 'codex', '--mode', 'direct', '--url', 'http://proxy.test'], message: 'custom proxy options' },
    { args: ['test', 'codex', '--mode', 'direct'], message: 'only valid with set' },
    { args: ['unset', 'codex', '--bogus'], message: 'unknown flag' },
    { args: ['set', 'codex', '--mode', 'custom', '--password', 'secret'], message: 'unknown flag' },
    { args: ['set', 'codex', '--mode', 'custom', '--mode', 'direct'], message: '--mode may be provided only once' },
    { args: ['set', 'codex', '--mode', 'custom', '--password-file', 'a', '--password-file', 'b'], message: 'once' },
    { args: ['set', 'codex', '--mode', 'custom', '--password-file', '-', '--password-file=-'], message: 'once' },
    { args: ['set', 'codex', '--mode', 'custom', '--password-file', '-', '--clear-password'], message: 'cannot be combined' },
  ])('rejects invalid syntax: $message', async ({ args, message }) => {
    await expect(parseAgentNetworkProxyCommand(args, unread)).rejects.toThrow(message);
  });

  it('does not read stdin when password-file conflicts with clear-password', async () => {
    const readPasswordFile = vi.fn(async () => 'secret');
    await expect(parseAgentNetworkProxyCommand([
      'set', 'codex', '--mode', 'custom', '--url', 'http://proxy.test',
      '--password-file', '-', '--clear-password',
    ], readPasswordFile)).rejects.toThrow('cannot be combined');
    expect(readPasswordFile).not.toHaveBeenCalled();
  });
});

describe('mergeAgentNetworkCliUpdate', () => {
  const current: AgentNetworkPrefs = {
    claude: { mode: 'direct' },
    codex: {
      mode: 'custom',
      proxyUrl: 'http://old.test:8080',
      noProxy: 'localhost',
      username: 'alice',
      passwordConfigured: true,
    },
  };

  it('merges omitted custom fields and emits a complete secret-free update map', () => {
    expect(mergeAgentNetworkCliUpdate(current, {
      verb: 'set',
      agentId: 'codex',
      mode: 'custom',
      noProxy: 'localhost,127.0.0.1',
    })).toEqual({
      claude: { mode: 'direct' },
      codex: {
        mode: 'custom',
        proxyUrl: 'http://old.test:8080',
        noProxy: 'localhost,127.0.0.1',
        username: 'alice',
      },
    });
  });

  it('includes a new password action without copying passwordConfigured', () => {
    expect(mergeAgentNetworkCliUpdate(current, {
      verb: 'set',
      agentId: 'codex',
      mode: 'custom',
      password: 'new secret',
    }).codex).toEqual({
      mode: 'custom',
      proxyUrl: 'http://old.test:8080',
      noProxy: 'localhost',
      username: 'alice',
      password: 'new secret',
    });
  });

  it.each([undefined, ''])('requires a non-empty URL when creating a custom entry (%s)', (proxyUrl) => {
    expect(() => mergeAgentNetworkCliUpdate({}, {
      verb: 'set',
      agentId: 'codex',
      mode: 'custom',
      username: 'alice',
      ...(proxyUrl === undefined ? {} : { proxyUrl }),
    })).toThrow('--url is required');
  });

  it('replaces an entry with direct mode', () => {
    expect(mergeAgentNetworkCliUpdate(current, {
      verb: 'set', agentId: 'codex', mode: 'direct',
    })).toEqual({ claude: { mode: 'direct' }, codex: { mode: 'direct' } });
  });

  it.each([
    { verb: 'unset', agentId: 'codex' } as const,
    { verb: 'set', agentId: 'codex', mode: 'inherit' } as const,
  ])('deletes the selected entry for $verb/$mode', (command) => {
    expect(mergeAgentNetworkCliUpdate(current, command)).toEqual({
      claude: { mode: 'direct' },
    });
  });

  it('passes a clear-password action while preserving omitted public fields', () => {
    expect(mergeAgentNetworkCliUpdate(current, {
      verb: 'set', agentId: 'codex', mode: 'custom', clearPassword: true,
    }).codex).toEqual({
      mode: 'custom',
      proxyUrl: 'http://old.test:8080',
      noProxy: 'localhost',
      username: 'alice',
      clearPassword: true,
    });
  });
});
