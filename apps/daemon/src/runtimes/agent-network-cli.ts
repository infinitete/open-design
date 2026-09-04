import type {
  AgentNetworkPrefs,
  AgentNetworkPolicyUpdate,
  AgentNetworkUpdatePrefs,
} from '@open-design/contracts';

export type AgentNetworkProxyCommand =
  | { verb: 'get' | 'test' | 'unset'; agentId: string }
  | {
      verb: 'set';
      agentId: string;
      mode: 'inherit' | 'direct' | 'custom';
      proxyUrl?: string;
      noProxy?: string;
      username?: string;
      password?: string;
      clearPassword?: true;
    };

const STRING_FLAGS = new Set([
  'mode',
  'url',
  'no-proxy',
  'username',
  'password-file',
  'daemon-url',
]);
const BOOLEAN_FLAGS = new Set(['clear-password', 'json']);
const SET_ONLY_FLAGS = new Set([
  'mode',
  'url',
  'no-proxy',
  'username',
  'password-file',
  'clear-password',
]);
const MODES = new Set(['inherit', 'direct', 'custom']);

interface ParsedArgs {
  positionals: string[];
  values: Record<string, string | true>;
  counts: Record<string, number>;
}

function parseArgs(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  const values: Record<string, string | true> = {};
  const counts: Record<string, number> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg?.startsWith('--')) {
      if (arg !== undefined) positionals.push(arg);
      continue;
    }
    const equalsIndex = arg.indexOf('=');
    const key = equalsIndex >= 0 ? arg.slice(2, equalsIndex) : arg.slice(2);
    if (!STRING_FLAGS.has(key) && !BOOLEAN_FLAGS.has(key)) {
      throw new Error(`unknown flag: --${key}`);
    }
    counts[key] = (counts[key] ?? 0) + 1;
    if (BOOLEAN_FLAGS.has(key)) {
      if (equalsIndex >= 0) throw new Error(`flag --${key} does not accept a value`);
      values[key] = true;
      continue;
    }
    const value = equalsIndex >= 0 ? arg.slice(equalsIndex + 1) : args[index + 1];
    if (value === undefined || (equalsIndex < 0 && value.startsWith('--'))) {
      throw new Error(`flag --${key} requires a value`);
    }
    values[key] = value;
    if (equalsIndex < 0) index += 1;
  }
  return { positionals, values, counts };
}

export async function parseAgentNetworkProxyCommand(
  args: string[],
  readPasswordFile: (path: string) => Promise<string>,
): Promise<AgentNetworkProxyCommand> {
  const { positionals, values, counts } = parseArgs(args);
  const duplicateFlag = Object.entries(counts)
    .find(([key, count]) => key !== 'json' && count > 1)?.[0];
  if (duplicateFlag) throw new Error(`--${duplicateFlag} may be provided only once`);
  const [verb, agentId, ...extraPositionals] = positionals;
  if (verb !== 'get' && verb !== 'set' && verb !== 'test' && verb !== 'unset') {
    throw new Error('expected proxy verb get|set|test|unset');
  }
  if (!agentId) throw new Error('CLI ID is required');
  if (extraPositionals.length > 0) throw new Error('expected exactly one CLI ID');

  if (verb !== 'set') {
    const invalidFlag = [...SET_ONLY_FLAGS].find((key) => values[key] !== undefined);
    if (invalidFlag) throw new Error(`--${invalidFlag} is only valid with set`);
    return { verb, agentId };
  }

  const mode = values.mode;
  if (typeof mode !== 'string') throw new Error('--mode is required');
  if (!MODES.has(mode)) throw new Error('--mode must be inherit|direct|custom');

  const customFlag = ['url', 'no-proxy', 'username', 'password-file', 'clear-password']
    .find((key) => values[key] !== undefined);
  if (mode !== 'custom' && customFlag) {
    throw new Error(`custom proxy options are not valid with --mode ${mode}`);
  }
  if (values['password-file'] !== undefined && values['clear-password'] === true) {
    throw new Error('--password-file and --clear-password cannot be combined');
  }

  let password: string | undefined;
  if (typeof values['password-file'] === 'string') {
    const contents = await readPasswordFile(values['password-file']);
    password = contents.replace(/\r?\n$/u, '');
  }

  return {
    verb: 'set',
    agentId,
    mode: mode as 'inherit' | 'direct' | 'custom',
    ...(typeof values.url === 'string' ? { proxyUrl: values.url } : {}),
    ...(typeof values['no-proxy'] === 'string' ? { noProxy: values['no-proxy'] } : {}),
    ...(typeof values.username === 'string' ? { username: values.username } : {}),
    ...(password === undefined ? {} : { password }),
    ...(values['clear-password'] === true ? { clearPassword: true as const } : {}),
  };
}

function toUpdatePrefs(current: AgentNetworkPrefs): AgentNetworkUpdatePrefs {
  return Object.fromEntries(Object.entries(current).map(([agentId, policy]) => [
    agentId,
    policy.mode === 'direct'
      ? { mode: 'direct' }
      : {
          mode: 'custom',
          proxyUrl: policy.proxyUrl,
          ...(policy.noProxy === undefined ? {} : { noProxy: policy.noProxy }),
          ...(policy.username === undefined ? {} : { username: policy.username }),
        },
  ])) as AgentNetworkUpdatePrefs;
}

export function mergeAgentNetworkCliUpdate(
  current: AgentNetworkPrefs,
  command:
    | Extract<AgentNetworkProxyCommand, { verb: 'set' }>
    | { verb: 'unset'; agentId: string },
): AgentNetworkUpdatePrefs {
  const next = toUpdatePrefs(current);
  if (command.verb === 'unset' || command.mode === 'inherit') {
    delete next[command.agentId];
    return next;
  }
  if (command.mode === 'direct') {
    next[command.agentId] = { mode: 'direct' };
    return next;
  }

  const existing = current[command.agentId];
  const proxyUrl = command.proxyUrl
    ?? (existing?.mode === 'custom' ? existing.proxyUrl : undefined);
  if (proxyUrl === undefined || proxyUrl.length === 0) {
    throw new Error('--url is required when creating a custom proxy policy');
  }
  const update: AgentNetworkPolicyUpdate = {
    mode: 'custom',
    proxyUrl,
    ...(command.noProxy !== undefined
      ? { noProxy: command.noProxy }
      : existing?.mode === 'custom' && existing.noProxy !== undefined
        ? { noProxy: existing.noProxy }
        : {}),
    ...(command.username !== undefined
      ? { username: command.username }
      : existing?.mode === 'custom' && existing.username !== undefined
        ? { username: existing.username }
        : {}),
    ...(command.password === undefined ? {} : { password: command.password }),
    ...(command.clearPassword === true ? { clearPassword: true } : {}),
  };
  next[command.agentId] = update;
  return next;
}
