import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

// Git sends a single remote command argument. Recognize this tiny grammar;
// never execute that argument as a shell command.
const args = process.argv.slice(2);
if (args[0] === '--git-launcher') {
  const gitArgs = args.slice(1);
  const probe = gitArgs.slice(-5);
  const isProbe = probe[0] === 'config' && ['--global', '--system'].includes(probe[1] ?? '')
    && probe.slice(2).join(' ') === '--includes --null --list';
  const registry = JSON.parse(await readFile(process.env.OD_PROJECT_GIT_FIXTURE_REGISTRY!, 'utf8')) as {
    realGit: string; identity: string; https?: { url: string; ca: string };
  };
  const transportAt = gitArgs.indexOf('ls-remote');
  const remoteArgs = transportAt >= 0 ? gitArgs.slice(transportAt + 1).filter(arg => arg !== '--heads') : [];
  const certificate = registry.https && remoteArgs[0] === registry.https.url
    && (remoteArgs.length === 1 || remoteArgs.length === 2 && remoteArgs[1]!.startsWith('refs/heads/'))
    && /^https:\/\/127\.0\.0\.1:\d+\/repo$/u.test(registry.https.url)
    ? ['-c', `http.${registry.https.url}.sslCAInfo=${registry.https.ca}`] : [];
  const forwarded = isProbe
    ? [...gitArgs.slice(0, -5), 'config', '--file', probe[1] === '--global' ? registry.identity : '/dev/null', '--includes', '--null', '--list']
    : [...certificate, ...gitArgs];
  const git = spawn(registry.realGit, forwarded, { shell: false, stdio: 'inherit' });
  git.once('error', () => { process.exitCode = 1; });
  git.once('exit', code => { process.exitCode = code ?? 1; });
  await new Promise<void>(resolve => git.once('close', () => resolve()));
  process.exit(process.exitCode ?? 0);
}
const host = args.findIndex(value => value === 'git@project-git.invalid');
const options = args.slice(0, host);
const allowedOptions = new Set(['BatchMode=yes', 'NumberOfPasswordPrompts=0', 'SendEnv=GIT_PROTOCOL']);
const validOptions = options.length % 2 === 0
  && options.every((value, index) => index % 2 === 0 ? value === '-o' : allowedOptions.has(value));
const command = /^(git-upload-pack|git-receive-pack) '\/([a-z0-9-]+)'$/u.exec(args[host + 1] ?? '');
if (host < 0 || !validOptions || args.length !== host + 2 || !command || !process.env.OD_PROJECT_GIT_FIXTURE_REGISTRY) {
  process.stderr.write('Fixture SSH rejected unknown host, command or options.\n');
  process.exit(2);
}
const registry = JSON.parse(await readFile(process.env.OD_PROJECT_GIT_FIXTURE_REGISTRY, 'utf8')) as { repos: Record<string, string> };
const repo = Object.hasOwn(registry.repos, command[2]!) ? registry.repos[command[2]!] : undefined;
if (!repo) {
  process.stderr.write('Fixture SSH rejected unregistered repository.\n');
  process.exit(2);
}
const child = spawn(command[1]!, [repo], { shell: false, stdio: 'inherit' });
child.once('error', () => { process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
