# Project Git Versioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Open Design 内部用户项目提供完整 Git 检查点、可配置远端、自动双向同步、跨设备打开和保留历史的恢复，并同时交付 Web 与 `od git`。

**Architecture:** 保留项目工作目录和 SQLite，通过项目版本协调器导出可迁移记录、构造 Git 候选树，并以持久操作日志协调文件、数据库、引用和正常索引。Git 服务不依赖 Express；HTTP、CLI、Web、MCP 及内部任务共享修订校验和写入边界。各任务是同一功能的审阅单元，不是允许单独发布的半成品。

**Tech Stack:** TypeScript、Node `~24`、`pnpm@10.33.2`、Express、现有 better-sqlite3、系统 Git、纯 TS contracts、Next.js 16 / React 18、Vitest、Playwright。优先使用现有依赖和 Git plumbing，不新增 Git JS 库。

**Spec:** `docs/superpowers/specs/2026-09-05-project-git-versioning-design.md`，2026-09-05 用户已确认；执行者必须完整阅读。

## Global Constraints

- 计划前置提交：`bdec2630cc29756d15ad8c95ee89200fc546808f`。必须先通过下述 ancestry 检查；失败即停止，不换 checkout 拼凑实现。
- 本计划只管理 Open Design 的用户项目，不改变 Open Design 源码仓库的自动提交或推送方式。
- 每项目一个仓库和一个目标分支；支持其他电脑、其他人和外部编辑器提交。
- 可迁移格式 `schemaVersion: 1`；`.open-design` 必须进入版本，SQLite、凭据、信任与运行授权不得进入版本。
- 手动变更停止 **5 秒**后检查点；后台远端检查 **60 秒**；重试退避 **5 秒、30 秒、2 分钟、5 分钟**，附抖动。
- AI 成功、失败、取消均收敛；等待同项目全部写入任务、消息归并及文件落盘；无语义变化不提交。
- `projectRevision` 是基线代次；`contentRevision` 是日常内容修订。预览绑定二者及本地/远端 OID；不得用新代次重新包装旧请求。
- Git 管理项目修改与任务启动缺失或过期 `expectedProjectRevision` 返回 `409 PROJECT_STATE_CHANGED`；未启用旧项目维持现有行为。
- 恢复创建当前 HEAD 的新子提交，保护未提交内容，保留中间历史；禁止 hard reset、强制推送、清除用户暂存或递归清理工作目录。
- 物化包含准备、保护、文件、数据库、引用及正常索引阶段；不能宣称 Git、SQLite 和文件系统原子提交。
- 同实际 Git common directory 跨进程协调；本机同一分支不得重复可写绑定。外部编辑仍需读前读后及应用前摘要校验。
- 关闭页面不停止 daemon 检测；暂停自动同步不停止本地检查点；立即同步只执行一次；退出后启动先恢复日志再开放写入。
- 只使用 `server.ts` 已解析的 `RUNTIME_DATA_DIR` 派生本地存储/准备目录；导入目录继续走 `metadata.baseDir`。服务接收路径，不能自行猜测数据根。
- 新能力 contracts + daemon + Web + CLI 同一 PR；所有 CLI 支持 `--json`，长输入支持 `--prompt-file <path|->`。
- 系统 Git 缺失或身份缺失不阻止创建和编辑项目；禁止静默安装工具、执行仓库代码、信任历史权限、管理远端账号或自动安装依赖。
- 不自动采用 LFS、不递归管理子模块；必需字节缺失时列明依赖，禁止标注“完整恢复”。
- 新源码/测试为 TS；测试在 `tests/`；不新增 daemon 顶层源码文件，不跨应用导入私有源码，不改变 sidecar/data-root 约定。
- 修改命令入口后运行 `pnpm install`；若实际引入影响打包的锁文件变更，执行 `pnpm nix:update-hash` 并纳入相应检查。
- 不创建远端 issue/PR、不合并、不推送、不清理工作树；功能 PR 前需用户授权并按贡献规范关联 issue、提供 UI 截图。

---

## 执行准备与交付顺序

先在指定 checkout 执行以下只读检查：

```bash
git -C /home/renshan/Projects/HTML/open-design merge-base --is-ancestor bdec2630cc29756d15ad8c95ee89200fc546808f HEAD
git -C /home/renshan/Projects/HTML/open-design status --short
git -C /home/renshan/Projects/HTML/open-design worktree list
```

通过后使用 `using-git-worktrees` 技能建立隔离工作树，建议分支 `feat/project-git-versioning`、目录 `.worktrees/project-git-versioning`；若已存在，先核验归属，不能覆盖。记录实际执行 HEAD 和工作树路径。读取根、`apps/`、`apps/daemon/`、`packages/`、`e2e/` 的 `AGENTS.md`；进入其他有局部指南的目录前同样读取。使用 TDD 与 verification-before-completion；涉及 React 实现时使用 vercel-react-best-practices。每个任务按测试、红灯、最小实现、绿灯、审阅、提交循环推进，不一次性先写完生产代码。

基线检查：`pnpm guard`、`pnpm typecheck`、`pnpm --filter @open-design/daemon test`、`pnpm --filter @open-design/web test`。记录已有失败与 Node 引擎警告，不混入无关修复。源码基线工具实测 Git `2.47.3`；不依赖未经探测的新 Git 选项，运行时检查必要能力并给可操作的错误。

任务 1–11 建立可独立验证的内核，12 接入现有写入，13–17 闭合 API/CLI/Web，18 才开启新项目默认行为，19 完成公开边界验收。中间提交不能作为功能完成或单独发布依据。

## 文件与责任地图

下表目录均相对仓库根；任务中进一步列出精确文件。

| 单元 | 文件 | 责任 |
| --- | --- | --- |
| 共享合同 | `packages/contracts/src/api/project-git.ts`、`project-git-portable.ts` | DTO、格式、验证、状态；不导入 Node |
| Git 边界 | `apps/daemon/src/services/project-git/git-process.ts`、`repository.ts`、`repository-lease.ts`、`errors.ts` | 受控命令、仓库身份、跨进程写权限、安全错误 |
| 内容 | 同目录 `portable.ts`、`portable-db.ts`、`resources.ts`、`merge.ts` | 允许列表、稳定 ID、资源完整性、三方合并 |
| 保存/恢复 | 同目录 `gate.ts`、`checkpoint.ts`、`materialize.ts`、`recovery.ts` | 写入边界、候选树、journal、恢复 |
| 同步/操作 | 同目录 `sync.ts`、`scheduler.ts`、`binding.ts`、`history.ts`、`restore.ts` | 持久队列、远端核对、导入、历史与预览 |
| 组合与接入 | 同目录 `service.ts`、`runtime-adapter.ts`、`mutation-adapter.ts` | 窄服务接口、运行终态及已有入口适配 |
| 本地状态 | `apps/daemon/src/storage/project-git.ts`、`project-git-migrations.ts` | SQLite 绑定、代次、映射、操作、push outbox |
| HTTP / CLI | `apps/daemon/src/routes/project-git.ts`、`src/cli/project-git.ts` | 同一合同的路由与命令 |
| Web 状态 | `apps/web/src/state/project-git.ts`、`src/providers/project-git.ts` | daemon 状态、变更代次、请求与刷新 |
| Web 界面 | `apps/web/src/components/project-git/` | 状态条、设置、导入、历史、恢复和冲突 |
| 测试 | contracts / daemon / web 各自 `tests/`；`e2e/tests/project-git-lifecycle.test.ts`、`e2e/ui/project-git.test.ts` | 从纯函数到实际 Git、HTTP、CLI、浏览器 |

## 公共命名与测试约定

- OID 使用字符串并在 Git 边界验证对象类型，不写死 SHA-1 长度；空分支用 `null`，不用魔法全零公开 DTO。
- `ProjectGitBasis = { projectRevision: number; contentRevision: number; localHead: string | null; remoteHead: string | null; bindingGeneration: number }`。
- `ProjectGitState` 至少包含 `enabled`、`phase`、`localHead`、`observedRemoteHead`、`confirmedRemoteHead`、两种 revision、`dirty`、`pendingPush`、`autoSync`、`operationId`、`error`、脱敏绑定信息和依赖检查结果。
- `ProjectGitPhase` 的字面量：`enable_pending | waiting_idle | dirty | checkpointing | local_saved | pending_push | syncing | synced | paused | conflict | auth_required | external_git_busy | recovering | failed`。`autoSync`、`dirty` 等事实独立存在；暂停不能遮掉错误或谎称已保存。
- `ProjectGitOperation` 有 `id`、`kind`、`status`、`phase`、`projectId: string | null`、`basis`、`result`、结构化 `error`；`status = queued | running | waiting | succeeded | failed`。冲突可保持 waiting；恢复所需材料未收敛不能标成功。
- operation.result 为具名对象，允许 `projectId?: string`、`preview?: ProjectGitPreview`、`head?: string`、`dependencies?: ProjectGitDependency[]`；不是任意运行时对象。`ProjectGitHistoryPage = { commits: ProjectGitCommit[]; nextCursor: string | null }`；`ProjectGitCommit` 有 oid、parents、author、authoredAt、message、source、`snapshotKind: 'complete' | 'files_only'`、变更路径；`ProjectGitFileResponse = { encoding: 'base64'; content: string; mediaType: string }`。
- 异步操作响应 `ProjectGitAccepted = { operationId: string }`；幂等键使用 `Idempotency-Key` 请求头，按调用者/项目/动作/请求摘要判重；同键不同请求返回 `409 CONFLICT`。
- `GitDomainError` 在 daemon `services/project-git/errors.ts` 导出，含 `code: ApiErrorCode`、`status: number`、安全 `details` 和下一步。HTTP 统一交给现有 `sendApiError`；Git 原始 stderr 不作为错误消息透传。
- 以下代码块是相应测试/算法的具体起点；执行者把 imports 放进指定文件，用列出的接口实现其余明确验收分支。不能用仅返回固定结果的测试替身替代实际 Git 或持久化验收。

### Task 1: 冻结可迁移与 API 合同

**Files:**

- Create: `packages/contracts/src/api/project-git.ts`
- Create: `packages/contracts/src/api/project-git-portable.ts`
- Modify: `packages/contracts/src/index.ts`、`packages/contracts/src/errors.ts`、`packages/contracts/src/api/projects.ts`、`packages/contracts/src/api/chat.ts`
- Test: `packages/contracts/tests/project-git.test.ts`

**Interfaces:**

- Consumes: 现有 `ProjectKind`、`ProjectMetadata`、`JsonValue`、`ApiErrorCode`。
- Produces: 上述公共 DTO；`ProjectMutationRevision { expectedProjectRevision?: number }`；`parsePortableManifest(input: unknown): PortableManifest`；`PortableProject`、`PortableConversation`、`PortableMessage`、`PortableResource`、`PortableSnapshot`。
- `PortableSnapshot = { manifest: PortableManifest; project: PortableProject; conversations: PortableConversation[]; messages: PortableMessage[] }`；资源字节不塞入 JSON DTO。
- `PortableManifest = { schemaVersion: 1; repositoryProjectId: string; resources: PortableResource[] }`。
- `PortableResource = { digest: string; path: string; purpose: 'attachment' | 'artifact' | 'design-system' | 'skill' | 'plugin' | 'legacy-history'; references: string[]; sourceLabel?: string }`。
- `PortableProject` 包含 `schemaVersion: 1`、`name`、`createdAt`、`kind`、可选 `entryFile` / `customInstructions` / `pendingPrompt`、`preferences: Record<string, JsonValue>`、`contentRefs: string[]`、`linkedFolderRequirements: { label: string; purpose: string }[]`。preferences 的键由任务 5 允许列表逐项验证，不接受任意 JSON 属性。
- 会话：版本、`id`、`title`、`mode`、`createdAt`；消息：版本、`id`、`conversationId`、`role`、`content`、`createdAt`、`predecessorId: string | null`、`turnId`、`terminal: 'succeeded' | 'failed' | 'cancelled' | 'historical'`、`resourceRefs: string[]`、`displayEvents: JsonValue[]`、`context: Record<string, JsonValue>`。context 同样使用显示内容允许列表。

- [ ] 写首个红测试，验证不支持版本及非法路径不能透传：

```ts
import { describe, expect, it } from 'vitest';
import { parsePortableManifest } from '../src/api/project-git-portable.js';

describe('portable manifest', () => {
  it('accepts v1 and rejects newer schema without rewriting it', () => {
    const value = { schemaVersion: 1, repositoryProjectId: 'repo-one', resources: [] };
    expect(parsePortableManifest(value)).toEqual(value);
    expect(() => parsePortableManifest({ ...value, schemaVersion: 2 })).toThrow();
    expect(() => parsePortableManifest({ ...value, resources: [{
      digest: 'a'.repeat(64), path: '../outside', purpose: 'attachment', references: ['m1'],
    }] })).toThrow();
  });
});
```

- [ ] 运行 `pnpm --filter @open-design/contracts test -- tests/project-git.test.ts`，预期新导出不存在而失败。
- [ ] 实现纯 TS schema，使用 contracts 已有 zod，不另加依赖：

```ts
import { z } from 'zod';

const relativePath = z.string().min(1).refine((value) =>
  !value.startsWith('/') && !value.includes('\\') && !value.includes('\0') &&
  !/^[a-z]:/i.test(value) && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
);
const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  repositoryProjectId: z.string().min(1),
  resources: z.array(z.object({
    digest: z.string().regex(/^[a-f0-9]{64}$/), path: relativePath,
    purpose: z.enum(['attachment', 'artifact', 'design-system', 'skill', 'plugin', 'legacy-history']),
    references: z.array(z.string().min(1)), sourceLabel: z.string().optional(),
  }).strict()),
}).strict();
export type PortableManifest = z.infer<typeof manifestSchema>;
export function parsePortableManifest(input: unknown): PortableManifest {
  return manifestSchema.parse(input);
}
```

- [ ] 增加项目/消息/会话完整 schema 和 DTO。校验资源 path 位于对应 `.open-design/resources/<digest>/` 或旧历史归档区；重复 ID、孤立 predecessor、跨会话 predecessor、循环必须失败。不能用 schema 宽松透传未知权限字段。
- [ ] 在既有 `API_ERROR_CODES` 增加 spec §11.2 的 **12** 个精确错误码；现有修改 DTO 接入可选 revision，条件必填由 daemon 判断。为每项 spec API 定义具名 request/response，不由 Web/CLI 手写响应形状。
- [ ] 运行首个测试及 `pnpm --filter @open-design/contracts typecheck`，预期通过；断言使用字面量 `schemaVersion: 1`，不能只同实现常量比较。
- [ ] 提交：`git add packages/contracts/src/api/project-git.ts packages/contracts/src/api/project-git-portable.ts packages/contracts/src/api/projects.ts packages/contracts/src/api/chat.ts packages/contracts/src/index.ts packages/contracts/src/errors.ts packages/contracts/tests/project-git.test.ts`；`git commit -m "feat(contracts): define portable project git contracts"`。

### Task 2: 系统 Git、安全命令与真实仓库测试夹具

**Files:**

- Create: `apps/daemon/src/services/project-git/git-process.ts`、`repository.ts`、`errors.ts`
- Create: `apps/daemon/tests/helpers/project-git.ts`
- Test: `apps/daemon/tests/services/project-git/git-process.test.ts`

**Interfaces:**

- Produces: `runGit(input: { cwd: string; args: readonly string[]; stdin?: Uint8Array; signal?: AbortSignal; env?: Record<string, string>; timeoutMs?: number }): Promise<{ stdout: Buffer; stderr: Buffer }>`，仅领域内部调用，不把任意 args/env 暴露给 API。
- Produces: `discoverRepository(cwd: string): Promise<{ root: string; commonDir: string; gitDir: string; branch: string | null; head: string | null }>`；`validateRemote(raw: string): string`；`validateBranch(value: string): Promise<string>`；`resolveCommit(root: string, oid: string): Promise<string>`；`redactGitText(value: string): string`。
- Test fixture: `createGitFixture(): Promise<{ root: string; remote: string; a: string; b: string; git(cwd: string, ...args: string[]): Promise<string>; close(): Promise<void> }>`。

- [ ] 添加实际 Git 夹具和测试，不 mock child_process：

```ts
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

export async function createGitFixture() {
  const exec = promisify(execFile);
  const root = await mkdtemp(join(tmpdir(), 'od-git-test-'));
  const git = async (cwd: string, ...args: string[]) => (await exec('git', args, {
    cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'OD Test', GIT_AUTHOR_EMAIL: 'od@example.invalid',
      GIT_COMMITTER_NAME: 'OD Test', GIT_COMMITTER_EMAIL: 'od@example.invalid' },
  })).stdout.trim();
  const remote = join(root, 'remote.git');
  const a = join(root, 'a'); const b = join(root, 'b');
  await git(root, 'init', '--bare', '--initial-branch=main', remote);
  await git(root, 'clone', remote, a); await git(root, 'clone', remote, b);
  for (const clone of [a, b]) {
    await git(clone, 'config', '--local', 'user.name', 'OD Test');
    await git(clone, 'config', '--local', 'user.email', 'od@example.invalid');
  }
  return { root, remote, a, b, git, close: () => rm(root, { recursive: true, force: true }) };
}
```

fixture 仅修改它自己创建的 clone 的 local identity，生产环境不能清空或写入用户 credential/identity 配置。夹具本地 transport 只在测试内使用，公共 API 不因此接受任意 `file://`。

```ts
it('resolves the actual repository and rejects option-shaped remotes', async () => {
  const f = await createGitFixture();
  try {
    expect((await discoverRepository(f.a)).root).toBe(f.a);
    expect(() => validateRemote('--upload-pack=sh')).toThrow();
    expect(() => validateRemote('ext::sh -c anything')).toThrow();
    expect(validateRemote('git@example.invalid:team/design.git')).toBe('git@example.invalid:team/design.git');
  } finally { await f.close(); }
});
```

- [ ] 运行 `pnpm --filter @open-design/daemon test -- tests/services/project-git/git-process.test.ts`，预期模块不存在。
- [ ] 在 errors.ts 建立无 service 依赖的错误边界，后续各任务均从此导入：

```ts
import type { ApiErrorCode, JsonValue } from '@open-design/contracts';
export class GitDomainError extends Error {
  constructor(readonly code: ApiErrorCode, readonly status: number, message: string,
    readonly details?: Record<string, JsonValue>) { super(message); }
}
```

- [ ] 用 `spawn('git', args, { shell: false, cwd, env, signal })` 实现边界，保持 stdout 字节，不用全局 trim 处理文件内容；超时关闭子进程与 SSH 子树并等待退出。拒绝换行/NUL、option-shaped 地址、自定义 transport；支持 HTTPS、SSH URL、scp 风格 SSH。URL 带密码/token 拒绝，SSH username 可保留；日志地址统一脱敏。
- [ ] `discoverRepository` 分别解析 `--show-toplevel`、`--git-common-dir`、`--git-dir` 并 realpath；项目子目录不得隐式管理父仓库。分支交给 `check-ref-format --branch` 且拒绝 `@{-1}` 等切换表达式；提交只接受解析后确为 commit 的 OID，不接受任意 revision 运算或路径。
- [ ] 自动路径禁用 hooks、签名交互和递归子模块；禁止继承任意 `GIT_*` 重定向索引/工作树/命令注入变量。读取用户身份及 credential helper 是明确授权的本机输入，仓库配置不是执行授权。克隆先 `--no-checkout`，Git blob 通过 `cat-file` / stdin `hash-object` 读写，物化自行校验路径，避开 checkout/smudge/clean filter 执行；SSH 以 BatchMode、无 askpass 运行。超大对象/输出采用限额与流式读取，返回明确大小限制，不能截断后当完整内容。
- [ ] 从受信任的本机 system/global 配置及明确 identity 环境输入解析凭据与身份；不能执行仓库 local config 注入的 credential.helper/core.sshCommand/remote helper。为自动命令构造受控配置，禁用仓库 hooks/filter/签名执行；测试允许 fixture 自己的 identity 配置和 PATH 中受控 ssh shim，不新增 API 绕过开关。逐项测试 global helper可用、local恶意helper不执行，避免安全设置误禁正常自建服务认证。
- [ ] 补充 malicious hook/filter、带凭据 stderr、路径穿越/大小写碰撞/Windows 保留名、符号链接、缺 Git、缺身份、超时取消测试；检验 marker 文件未被执行创建。
- [ ] 同命令绿灯后提交：`git add apps/daemon/src/services/project-git/git-process.ts apps/daemon/src/services/project-git/repository.ts apps/daemon/src/services/project-git/errors.ts apps/daemon/tests/helpers/project-git.ts apps/daemon/tests/services/project-git/git-process.test.ts`；`git commit -m "feat(daemon): add controlled project git adapter"`。

### Task 3: 跨进程仓库写权限和项目读写屏障

**Files:**

- Create: `apps/daemon/src/services/project-git/repository-lease.ts`、`gate.ts`
- Test: `apps/daemon/tests/services/project-git/gate.test.ts`、`repository-lease.test.ts`
- Create: `apps/daemon/tests/helpers/project-git-lease-worker.ts`

**Interfaces:**

- Consumes: `runGit`、`discoverRepository`。
- Produces: `acquireRepositoryLease(input: { root: string; instanceId: string; ownerDomain: string; dataRootId: string }): Promise<{ release(): Promise<void> }>`；冲突抛 `EXTERNAL_GIT_BUSY`。
- Produces: `createProjectGate(): { read<T>(work: () => Promise<T>, timeoutMs?: number): Promise<T>; mutate<T>(work: () => Promise<T>): Promise<T>; exclusive<T>(work: () => Promise<T>): Promise<T>; beginRun(): Promise<() => void>; activeRuns(): number }`。所有方法共享同一实例；进程级 registry 按 canonical commonDir + 工作树识别，不按 projectId 隔离。

- [ ] 写读屏障红测试：

```ts
it('does not expose current files before database materialization completes', async () => {
  const gate = createProjectGate();
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const seen: string[] = [];
  const writer = gate.exclusive(async () => {
    seen.push('files'); entered.resolve(); await finish.promise; seen.push('db');
  });
  await entered.promise;
  const reader = gate.read(async () => { seen.push('read'); });
  await Promise.resolve(); expect(seen).toEqual(['files']);
  finish.resolve(); await Promise.all([writer, reader]);
  expect(seen).toEqual(['files', 'db', 'read']);
});
```

- [ ] 运行 `pnpm --filter @open-design/daemon test -- tests/services/project-git/gate.test.ts tests/services/project-git/repository-lease.test.ts`，预期未实现。
- [ ] gate 采用公平排队：exclusive 登记后拒绝新 run 入场，等待已有 run/mutation/read 退出；mutation 与 run 可共享本 daemon 的仓库 lease，exclusive 期间没有新读写。release 放 finally，取消及失败也释放，不依赖浏览器断连。read 超时返回 `PROJECT_BUSY`，状态/历史不进入当前状态 gate。
- [ ] 用本地专用 ref 的 CAS 实现跨进程 lease：

```ts
// ownerOid 是先 hash-object -w 写入的 owner JSON blob；专用 ref 绝不进入 push refspec。
await runGit({ cwd: root, args: ['update-ref', '--no-deref',
  'refs/open-design/locks/repository', ownerOid, ''] });
// 释放只能删除自己仍拥有的值；不能无条件删除另一个实例的 lease。
await runGit({ cwd: root, args: ['update-ref', '--no-deref', '-d',
  'refs/open-design/locks/repository', ownerOid] });
```

owner JSON 持久保存随机 token、pid、instanceId、ownerDomain、dataRootId。ownerDomain 包含主机、用户及能验证的进程命名空间身份；同域且 `process.kill(pid, 0)` 明确 ESRCH 才允许 CAS 接管死持有者。存活 PID、复用 PID、不同/未知域、EPERM 一律不按超时强抢，报告 busy 或 recovery required。lease 不用 TTL 证明进程死亡。接管前读取旧操作归属，不能在另一个 SQLite 数据根中擅自重放。
- [ ] 添加两个独立 Node worker 同时争用、持有者长暂停、kill 后同域恢复、不同数据根阻塞、linked worktree 共用 lease 测试；验证仅一个成功，且 loser 不改 HEAD/index。拒绝同分支重复可写绑定由任务 10 持久绑定检查补齐。
- [ ] 同测试命令绿灯后提交：`git add apps/daemon/src/services/project-git/repository-lease.ts apps/daemon/src/services/project-git/gate.ts apps/daemon/tests/services/project-git/gate.test.ts apps/daemon/tests/services/project-git/repository-lease.test.ts apps/daemon/tests/helpers/project-git-lease-worker.ts`；`git commit -m "feat(daemon): coordinate project git writes across processes"`。

实现依据：[Git update-ref 的条件更新与引用事务](https://git-scm.com/docs/git-update-ref)。该锁只协调本应用，不能取代正常 index.lock 和 HEAD CAS，也不能阻止外部编辑器写文件。

### Task 4: 持久绑定、修订、journal 与推送 outbox

**Files:**

- Create: `apps/daemon/src/storage/project-git.ts`、`project-git-migrations.ts`
- Modify: `apps/daemon/src/db.ts`（只接入迁移）
- Test: `apps/daemon/tests/storage/project-git.test.ts`

**Interfaces:**

- Produces: `migrateProjectGit(db: Database.Database): void`；`createProjectGitStore(db: Database.Database): ProjectGitStore`。
- Store methods：`getBinding(projectId)`、`saveBinding(binding)`、`assertRevision(projectId, expected)`、`bumpContent(projectId)`、`bumpProject(projectId)`、`mapId(repositoryProjectId, cloneId, kind, portableId)`、`enqueueOperation(input)`、`getOperation(id)`、`setPhase(id, phase, recoveryData)`、`listRecoverable()`、`queuePush(projectId, generation, oid)`、`listDuePushes(now)`、`ackPush(projectId, generation, oid)`、`invalidateBinding(projectId)`。读取返回具名记录或 null；ID/操作写入返回持久结果，revision 更新返回 number；具体记录保存在本文件导出的 TS interfaces。
- Binding 必备字段：projectId、cloneId、repositoryProjectId、canonicalRoot/commonDir、branch、generation、autoSync、localHead/observedRemoteHead/confirmedRemoteHead、projectRevision/contentRevision/exportedContentRevision、materializedHead。连接地址只存本地，不存入 portable 或日志。

- [ ] 用临时 SQLite 文件写幂等与重启 outbox 红测试：

```ts
it('keeps one operation for a retried request across database reopen', async () => {
  const f = await createGitFixture();
  try {
    const file = join(f.root, 'state.sqlite');
    let db = new Database(file); migrateProjectGit(db);
    const request = { projectId: null, actorId: 'local', kind: 'open' as const,
      idempotencyKey: 'request-1', requestDigest: 'digest-1', payload: { branch: 'main' } };
    const first = createProjectGitStore(db).enqueueOperation(request); db.close();
    db = new Database(file); migrateProjectGit(db);
    expect(createProjectGitStore(db).enqueueOperation(request).id).toBe(first.id);
    expect(() => createProjectGitStore(db).enqueueOperation({ ...request, requestDigest: 'different' })).toThrow();
    db.close();
  } finally { await f.close(); }
});
```

- [ ] 运行 `pnpm --filter @open-design/daemon test -- tests/storage/project-git.test.ts`，预期模块不存在。
- [ ] 创建 `project_git_bindings`、`project_git_id_map`、`project_git_operations`、`project_git_push_queue`；迁移使用 `CREATE TABLE IF NOT EXISTS`，不能重写旧表或推导伪历史。独立 cloneId 保证同 portable ID 的不同副本本地记录不冲突。
- [ ] 核心 SQL 使用参数绑定与 SQLite transaction：

```sql
UPDATE project_git_bindings
SET content_revision = content_revision + 1
WHERE project_id = ?;

DELETE FROM project_git_push_queue
WHERE project_id = ? AND binding_generation = ? AND target_oid = ?;
```

`ackPush` 不删除较新的目标；绑定 generation 在变更目标和解绑时推进，旧请求不能更新新绑定。operation 唯一键包含 actor、项目作用域（无项目也要确定 scope）、kind、幂等键，另验 requestDigest。
- [ ] journal 使用单调 phase 并保存每个路径 old/candidate digest、备份位置、base/publish HEAD、候选 OID、index 摘要、DB 导入 marker；写入 phase 不能在副作用之后补记。资源备份路径必须来自 server 注入，不能把准备路径硬编码成新数据根。
- [ ] 添加并发幂等、失败迁移再执行、旧 generation ack、稳定 ID 重开、内容修订不推进 projectRevision 测试；绿灯后提交：`git add apps/daemon/src/storage/project-git.ts apps/daemon/src/storage/project-git-migrations.ts apps/daemon/src/db.ts apps/daemon/tests/storage/project-git.test.ts`；`git commit -m "feat(daemon): persist project git operations and revisions"`。

### Task 5: 可迁移快照、资源与本地 ID 映射

**Files:**

- Create: `apps/daemon/src/services/project-git/portable.ts`、`portable-db.ts`、`resources.ts`
- Test: `apps/daemon/tests/services/project-git/portable.test.ts`、`resources.test.ts`

**Interfaces:**

- Consumes: portable types、`ProjectGitStore.mapId`、现有 SQLite 项目/会话/消息查询。
- Produces: `canonicalJson(value: JsonValue): string`；`exportProjectPreferences(metadata: ProjectMetadata): Record<string, JsonValue>`；`exportPortableProject(input: { db: Database.Database; projectId: string; repositoryProjectId: string; cloneId: string; root: string; store: ProjectGitStore }): Promise<{ snapshot: PortableSnapshot; entries: Map<string, Uint8Array> }>`。
- Produces: `importPortableRecords(input: { db: Database.Database; projectId: string; cloneId: string; snapshot: PortableSnapshot; store: ProjectGitStore; operationId: string }): void`，调用者已持有 gate，内部事务可幂等重入。
- Produces: `collectReferencedResources(input: { snapshot: PortableSnapshot; root: string; readOwnedResource: (reference: string) => Promise<Uint8Array | null> }): Promise<Map<string, Uint8Array>>`；只解析所属项目引用，不遍历全局数据目录。

- [ ] 写稳定输出与禁止字段红测试：

```ts
it('serializes deterministically and never migrates local authority', () => {
  expect(canonicalJson({ z: 2, a: { y: 1, x: 0 } })).toBe('{"a":{"x":0,"y":1},"z":2}\n');
  const result = exportProjectPreferences({ kind: 'prototype', imageModel: 'chosen-model',
    baseDir: '/private/local', fromTrustedPicker: true, linkedDirs: ['/private/source'] });
  expect(result).toEqual({ imageModel: 'chosen-model' });
});
```

- [ ] 运行 `pnpm --filter @open-design/daemon test -- tests/services/project-git/portable.test.ts tests/services/project-git/resources.test.ts`，预期缺实现。
- [ ] 实现排序 JSON（对象按键排序、数组保留语义顺序、末尾 LF），禁止 `undefined`/非有限数偷偷改变字节。导出字段采用显式赋值，不 spread 数据库 project/metadata/message：

```ts
export function canonicalJson(value: JsonValue): string {
  const normalize = (item: JsonValue): JsonValue => {
    if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('Invalid JSON number');
    if (Array.isArray(item)) return item.map(normalize);
    if (item !== null && typeof item === 'object') {
      return Object.fromEntries(Object.keys(item).sort().map((key) => {
        const child = item[key];
        if (child === undefined) throw new Error('Invalid JSON value');
        return [key, normalize(child)];
      }));
    }
    return item;
  };
  return JSON.stringify(normalize(value)) + '\n';
}

const preferenceKeys = [
  'intent', 'fidelity', 'speakerNotes', 'slideCount', 'animations', 'includeLandingPage',
  'includeOsWidgets', 'templateId', 'templateLabel', 'platform', 'platformTargets',
  'imageModel', 'imageAspect', 'imageStyle', 'videoModel', 'videoLength', 'videoAspect',
  'audioKind', 'audioModel', 'audioDuration', 'voice', 'skipDiscoveryBrief',
  'examplePrompt', 'examplePromptTitle', 'examplePromptBrief',
] as const satisfies readonly (keyof ProjectMetadata)[];
```

`promptTemplate`、设计 review 的可展示意见、项目和会话的 agent/model 偏好分别用具名允许 schema 投影；review 的 queued/sent task 不恢复为任务。skill/designSystem/plugin/scenario 内容变成 digest contentRefs，原 provenance 只作来源说明，不恢复信任。linkedDirs 变为需重新定位的用途标签，不保留可执行绝对路径。待处理用户 pendingPrompt 保留，但不能自动提交运行。
- [ ] 消息适配保留文字、终态、展示事件、附件、上下文快照；丢弃 native session/run handle、工具执行授权、队列/遥测。持久事件先归并再导出。历史表单仅展示，旧运行转历史终态，本地 runId 重新生成或空，不能重连旧进程。
- [ ] 将项目内外允许的附件读成真实字节并按 SHA-256 索引；已从工作区删除但聊天还引用的字节从既有资源副本保留。缺必需附件抛 `PORTABLE_RESOURCE_MISSING` 并列安全路径；不可转换的诊断引用标 unavailable。导入生成当前 daemon 文件 API URL，不复用旧 URL/端口/projectId。
- [ ] 增加两独立 SQLite 数据根的 roundtrip：全部会话/顺序/内容相同、本地 ID 不同、二次导出字节相同、插件不可执行、关联目录未授权；包含旧 HTML manifest 和原始字节，单独资源类型，不伪装完整旧快照。保持原 `.file-versions` 不删。
- [ ] 测试绿灯后提交：`git add apps/daemon/src/services/project-git/portable.ts apps/daemon/src/services/project-git/portable-db.ts apps/daemon/src/services/project-git/resources.ts apps/daemon/tests/services/project-git/portable.test.ts apps/daemon/tests/services/project-git/resources.test.ts`；`git commit -m "feat(daemon): serialize portable projects and referenced resources"`。

### Task 6: 文件、字段、消息与轮次三方合并

**Files:**

- Create: `apps/daemon/src/services/project-git/merge.ts`
- Test: `apps/daemon/tests/services/project-git/merge.test.ts`

**Interfaces:**

- Consumes: `PortableSnapshot`、`canonicalJson`、`runGit`。
- Produces: `mergeValue<T>(base: T | undefined, local: T | undefined, remote: T | undefined): { kind: 'merged'; value: T | undefined } | { kind: 'conflict'; base: T | undefined; local: T | undefined; remote: T | undefined }`。
- Produces: `mergePortableSnapshots(base: PortableSnapshot, local: PortableSnapshot, remote: PortableSnapshot): { snapshot: PortableSnapshot | null; conflicts: ProjectGitConflict[] }`；`mergeFileTrees(input: { root: string; base: string; local: string; remote: string; stagingDir: string }): Promise<{ tree: string | null; conflicts: ProjectGitConflict[] }>`。
- `ProjectGitConflict` 在合同定义：`id`、`kind: file | field | message | conversation_order | resource`、`path` 或稳定 recordId、base/local/remote 可查看内容引用。解决 DTO 提供逐项 selected side / edited value / ordered turn IDs，不能只有“全部本地覆盖”按钮。

- [ ] 写删除与编辑红测试：

```ts
it('does not silently choose deletion over an edited message', () => {
  expect(mergeValue('old', undefined, 'edited')).toEqual({
    kind: 'conflict', base: 'old', local: undefined, remote: 'edited',
  });
  expect(mergeValue('old', undefined, 'old')).toEqual({ kind: 'merged', value: undefined });
  expect(mergeValue('old', 'new', 'new')).toEqual({ kind: 'merged', value: 'new' });
});
```

- [ ] 运行 `pnpm --filter @open-design/daemon test -- tests/services/project-git/merge.test.ts`，预期模块不存在。
- [ ] 实现基本比较后组合到字段/稳定 ID，不使用整对象最后写入时间：

```ts
const same = <T>(a: T | undefined, b: T | undefined) =>
  a === undefined || b === undefined ? a === b : canonicalJson(a as JsonValue) === canonicalJson(b as JsonValue);
export function mergeValue<T>(base: T | undefined, local: T | undefined, remote: T | undefined) {
  if (same(local, remote)) return { kind: 'merged' as const, value: local };
  if (same(local, base)) return { kind: 'merged' as const, value: remote };
  if (same(remote, base)) return { kind: 'merged' as const, value: local };
  return { kind: 'conflict' as const, base, local, remote };
}
```

- [ ] 消息内容及 displayEvents 作为不可拆的消息值三方比较；不同消息可合并。合并后校验 predecessor 图：同前驱两个不同后继、循环、跨会话引用或拆散 user/reply 轮次必须产生 conversation_order 冲突，保留双方完整 turn，不按 timestamp 排序猜测。
- [ ] 文件使用 Git 的三方对象/文本合并能力，候选放操作目录，禁止向当前工作区写冲突 marker；二进制双改、delete/modify、rename collision 明确冲突。普通文件与 `.open-design` 记录分层：JSON 不能被 Git 文本自动合并后直接视为有效项目。不同 repositoryProjectId 返回拒绝绑定，不进入自动合并。
- [ ] 补充独立会话、相同追加去重、并行追加顺序歧义、资源缺失、重命名碰撞、非重叠文本修改、二进制冲突测试。所有 merged 候选再过任务 1/5 全量有效性检查。
- [ ] 绿灯后提交：`git add apps/daemon/src/services/project-git/merge.ts apps/daemon/tests/services/project-git/merge.test.ts`；`git commit -m "feat(daemon): merge portable project history without data loss"`。

### Task 7: 一致检查点与正常索引发布

**Files:**

- Create: `apps/daemon/src/services/project-git/checkpoint.ts`
- Test: `apps/daemon/tests/services/project-git/checkpoint.test.ts`

**Interfaces:**

- Consumes: lease、gate、store、portable export、Git adapter。
- Produces: `prepareCheckpoint(input: { root: string; operationDir: string; head: string | null; portableEntries: Map<string, Uint8Array>; reason?: CheckpointReason }): Promise<CheckpointCandidate>`；省略 reason 为 manual，runs 为空。
- `CheckpointCandidate` 含 `treeOid`、`commitOid: string | null`、`baseHead`、`baseIndexDigest`、`sourceDigests: Record<string,string>`、`privateIndexPath`；Git 提交身份在构造前检查。
- Produces: `publishCheckpoint(input: { root: string; branch: string; candidate: CheckpointCandidate; operationId: string; store: ProjectGitStore }): Promise<string | null>`；`CheckpointReason = { source: 'initialize' | 'manual' | 'ai' | 'merge' | 'restore'; runs: { id: string; terminal: 'succeeded' | 'failed' | 'cancelled' }[]; restoreTarget?: string }`。

- [ ] 用真实 Git 写红测试，保护用户索引：

```ts
it('does not consume the user staged index', async () => {
  const f = await createGitFixture();
  try {
    await writeFile(join(f.a, 'index.html'), 'first');
    await f.git(f.a, 'add', '--', 'index.html'); await f.git(f.a, 'commit', '-m', 'first');
    await writeFile(join(f.a, 'index.html'), 'staged-user-work');
    await f.git(f.a, 'add', '--', 'index.html');
    const before = await f.git(f.a, 'diff', '--cached', '--binary');
    await expect(prepareCheckpoint({ root: f.a, operationDir: join(f.root, 'op'),
      head: await f.git(f.a, 'rev-parse', 'HEAD'), portableEntries: new Map() })).rejects.toMatchObject({ code: 'EXTERNAL_GIT_BUSY' });
    expect(await f.git(f.a, 'diff', '--cached', '--binary')).toBe(before);
  } finally { await f.close(); }
});
```

- [ ] 运行 `pnpm --filter @open-design/daemon test -- tests/services/project-git/checkpoint.test.ts`，预期失败。
- [ ] 收集候选前检查 HEAD、merge/rebase/cherry-pick/revert/bisect 写入状态、index.lock、未合并项、用户 staged diff；staged 内容非空即 EXTERNAL_GIT_BUSY。枚举 `ls-files` tracked + 未忽略 untracked，不复用 preview/watch 忽略名单。对默认私有配置、SQLite、密钥/令牌配置路径做拒绝自动跟踪检查，只报告路径不输出内容；已跟踪私密路径要求用户处理，不改写历史。
- [ ] 私有索引从当前树开始，逐 blob 读字节并 hash，更新候选索引；使用 NUL 路径格式避免空格/换行被重新解释：

```ts
await runGit({ cwd: root, args: ['read-tree', baseHead ?? '--empty'],
  env: { GIT_INDEX_FILE: privateIndexPath } });
await runGit({ cwd: root, args: ['update-index', '-z', '--index-info'],
  env: { GIT_INDEX_FILE: privateIndexPath }, stdin: encodedEntries });
const { stdout } = await runGit({ cwd: root, args: ['write-tree'],
  env: { GIT_INDEX_FILE: privateIndexPath } });
const treeOid = stdout.toString('ascii').trim();
```

`encodedEntries` 由本任务内部 encoder 定义为 UTF-8/NUL 的 `<mode> <oid>\t<path>\0`，删除项 mode=0。若包含不能安全往返的路径字节，拒绝而非改名。新初始化用 read-tree --empty。候选树与基准树相同返回 commitOid=null；同树没有空提交、没有重复 outbox。
- [ ] 读取前后重新枚举路径及 digest，核对 contentRevision，发生外部变化重试；不能只依赖 mtime。通过 `commit-tree` 创建对象，parent 为检查时 HEAD，来源与终态写提交 message metadata，不写回 portable JSON 内的当前 commit SHA，不加 co-author trailer。
- [ ] 发布持有 repository lease + gate，独占创建正常 index.lock（存在即退出）；再次比较 HEAD、原索引和文件摘要。先 journal，再把完整候选 index 写入已拥有的 index.lock 并 flush；`update-ref branch candidate baseHead` CAS 后 rename 到正常 index，记录完成。CAS 失败保留材料并不覆写外部索引；只删除自己创建且确认未接管的临时锁。HEAD 已发布/index 未替换的崩溃由任务 8 收敛，不能事后把旧 index 当用户暂存。
- [ ] 增加 no-op、聊天/设置单独变化、tracked 被 UI 忽略仍保留、外部修改中途发生、HEAD CAS 竞争、发布后 `git diff --cached --exit-code` 干净测试。大二进制测试读取实际 SHA-256，不仅断言 Git 调用次数。
- [ ] 绿灯提交：`git add apps/daemon/src/services/project-git/checkpoint.ts apps/daemon/tests/services/project-git/checkpoint.test.ts`；`git commit -m "feat(daemon): publish consistent project checkpoints"`。

命令格式依据：[Git update-index](https://git-scm.com/docs/git-update-index)、[Git commit-tree](https://git-scm.com/docs/git-commit-tree)。这些是候选对象构造手段，不是文件与 SQLite 的事务保证。

### Task 8: 可恢复物化与逐阶段崩溃收敛

**Files:**

- Create: `apps/daemon/src/services/project-git/materialize.ts`、`recovery.ts`
- Test: `apps/daemon/tests/services/project-git/materialize.test.ts`、`recovery.test.ts`
- Create: `apps/daemon/tests/helpers/project-git-crash-worker.ts`

**Interfaces:**

- Consumes: `CheckpointCandidate`、store、`importPortableRecords`、repository lease/gate。
- Produces: `MaterializePhase = 'prepared' | 'protected' | 'files_applied' | 'records_applied' | 'ref_published' | 'index_published' | 'complete'`；`materializeProject(input: MaterializeInput): Promise<string>`；`recoverProjectOperations(input: { db: Database.Database; store: ProjectGitStore; operationRoot: string }): Promise<void>`。
- `MaterializeInput` 明确定义于 materialize.ts：projectId、root、branch、operationId、operationDir、basis、candidateOid、snapshot、store、db、gate，以及测试可选 `afterDurablePhase?: (phase: MaterializePhase) => Promise<void>`。此回调仅构造注入，不能从 HTTP/环境公开触发退出。

- [ ] 写操作顺序红测试，测试中构造实际 SQLite 与真实仓库；对每一阶段用子进程实际退出，然后重新打开同数据根。测试核心断言：

```ts
expect(afterRestart.operation.status).toBe('succeeded');
expect(afterRestart.fileBytes).toEqual(targetFileBytes);
expect(afterRestart.portableBytes).toEqual(targetPortableBytes);
expect(afterRestart.databaseImportCount).toBe(1);
expect(await f.git(f.a, 'diff', '--cached', '--name-only')).toBe('');
expect(await f.git(f.a, 'rev-list', '--count', publishBase + '..HEAD')).toBe('1');
```

本测试的 `afterRestart` 由本文件局部 `runCrashCase(phase): Promise<{ operation: ProjectGitOperation; fileBytes: Uint8Array; portableBytes: Uint8Array; databaseImportCount: number }>` 返回；helper 启动 `project-git-crash-worker.ts`，worker 使用任务 2/4/5 实际组件调用 materialize，回调中 `process.exit(73)`，父进程重开同 DB、调用 recover 并读取真实文件/导入 marker。不是伪造状态常量的 mock。
- [ ] 运行 `pnpm --filter @open-design/daemon test -- tests/services/project-git/materialize.test.ts tests/services/project-git/recovery.test.ts`，预期失败。
- [ ] 实现副作用前 journal 规则：

```ts
store.setPhase(operationId, 'prepared', preparedData);
await afterDurablePhase?.('prepared');
// preparedData 已记录计划覆盖的每个路径、旧/新摘要、候选和数据库导入标识。
// 每个后续阶段先追加可重放的 intent，再应用副作用，最后写阶段完成标识。
```

`setPhase` 所存 recoveryData 包含 intent/completed marker；阶段标签只是状态，不足以证明副作用发生。文件备份与 candidate 字节落盘后 fsync 必需文件和可用平台上的父目录，再标 protected。仅按照受控清单替换/删除，忽略文件和未纳入目标范围文件不删。
- [ ] 物化前 lstat 校验每一级目录，防止 symlink 跟随；链接作为条目处理，链接目标写入仓库外一律拒绝。禁止 Git 控制路径、大小写碰撞和候选覆盖操作准备区。再验当前路径 digest，不用“持有 gate”代替外部写入检测。
- [ ] DB 事务内记录 operation import marker、导入快照及 ID 映射、projectRevision +1；崩溃重放不能再次递增或重复消息。文件/DB 未收敛时当前读取屏障保持；状态和历史仍可查。
- [ ] reference 与正常 index 分别有持久 intent、actual digest 和完成判断。重启若 ref 已是 candidate 只补 index/收尾，不再 commit；若仍等于 publishBase 可继续；若外部 HEAD/index/待覆盖内容不符合预期，保留旧/新材料，置 RECOVERY_REQUIRED，不自动猜测回滚。保护 checkpoint 推进 HEAD 必须更新 journal publishBase 并保持预览内容校验。
- [ ] 添加文件应用一半、DB commit 前后、ref 更新前后、index rename 前后退出；同项目读取等待/超时、不相关项目可读；恢复后旧 epoch 写拒绝。至少一次用真实进程 kill，不把抛异常当成全部崩溃证据。
- [ ] 绿灯提交：`git add apps/daemon/src/services/project-git/materialize.ts apps/daemon/src/services/project-git/recovery.ts apps/daemon/tests/services/project-git/materialize.test.ts apps/daemon/tests/services/project-git/recovery.test.ts apps/daemon/tests/helpers/project-git-crash-worker.ts`；`git commit -m "feat(daemon): recover interrupted project materialization"`。

### Task 9: 双向同步、持久重试与后台变更检测

**Files:**

- Create: `apps/daemon/src/services/project-git/sync.ts`、`scheduler.ts`
- Test: `apps/daemon/tests/services/project-git/sync.test.ts`、`scheduler.test.ts`

**Interfaces:**

- Produces: `chooseSyncAction(input: { local: string; remote: string | null; localIsAncestor: boolean; remoteIsAncestor: boolean; remoteWasRewritten: boolean }): 'equal' | 'push' | 'fast_forward' | 'merge' | 'remote_rewritten'`。
- Produces: `retryDelayMs(attempt: number, random: () => number): number`；`createProjectGitScheduler(input: { store: ProjectGitStore; now: () => number; random: () => number; detect(projectId: string): Promise<void>; sync(projectId: string, oneShot: boolean): Promise<void> }): { start(): void; notify(projectId: string): void; requestSync(projectId: string, oneShot: boolean): void; stop(): Promise<void> }`。
- `syncProject(input: { projectId: string; oneShot: boolean; deps: ProjectGitSyncDeps }): Promise<void>`；`ProjectGitSyncDeps` 在 sync.ts 定义，包含 store、`checkpoint(projectId): Promise<string | null>`、`fetchTarget(projectId): Promise<string | null>`、`mergeAndMaterialize(projectId, local, remote): Promise<string>`、`pushTarget(projectId, oid, generation): Promise<void>`、`confirmTarget(projectId): Promise<string | null>`。这些适配器均在本任务用已实现的 Git/merge/materialize 编写并通过真实Git测试，不依赖尚未组合的 service。

- [ ] 写状态及退避红测试：

```ts
it('distinguishes divergence and remote rewrites', () => {
  expect(chooseSyncAction({ local: 'a', remote: 'b', localIsAncestor: false,
    remoteIsAncestor: false, remoteWasRewritten: false })).toBe('merge');
  expect(chooseSyncAction({ local: 'a', remote: 'b', localIsAncestor: false,
    remoteIsAncestor: false, remoteWasRewritten: true })).toBe('remote_rewritten');
  expect([0, 1, 2, 3, 4].map((n) => retryDelayMs(n, () => 0.5)))
    .toEqual([5000, 30000, 120000, 300000, 300000]);
});
```

- [ ] 运行 `pnpm --filter @open-design/daemon test -- tests/services/project-git/sync.test.ts tests/services/project-git/scheduler.test.ts`，预期失败。
- [ ] 实现纯决策和退避：

```ts
export function retryDelayMs(attempt: number, random: () => number): number {
  const base = [5_000, 30_000, 120_000, 300_000][Math.min(Math.max(0, attempt), 3)]!;
  return Math.round(base * (0.8 + random() * 0.4));
}
```

本地/远端相同→equal；远端空或是本地祖先→push；本地是远端祖先→fast_forward；其余有共同祖先→merge。已观察远端不再是新远端祖先或远端分支被删除→remote_rewritten，保留双方并要求确认，不自动 force push。
- [ ] fetch 只更新操作私有引用/对象，可在 run 中完成；工作区物化等待 idle。同步先 checkpoint，再 fetch/merge/materialize，再以显式 `<localOid>:refs/heads/<branch>` 推送，绝不 `--mirror`/`--all`/force。non-fast-forward 再获取并比较，不靠重试相同 push 莽撞覆盖。
- [ ] push 后重新 ls-remote 核对精确分支；远端 HEAD 与目标一致才 ack 对应 generation/OID。确认期间远端前进→重新调度，不显示 synced；进程在成功 push/ack 前退出→重启查询远端后幂等 ack。auth/permission 错误停自动网络重试并显示操作建议，不循环提示凭据。
- [ ] scheduler 为所有 managed 项目维护 daemon 生命周期检测，不依赖项目 SSE 订阅：portable contentRevision + Git 工作树/外部 HEAD 检测；本地可用 watcher 加启动/周期核对兜底，用户范围与 UI ignore 无关。手动静默 5s 后保存；自身物化写入关联 operationId 并以最终树去重。remote 60s 附抖动，重复开页去重；自动暂停只停网络，oneShot 不改变 autoSync。
- [ ] 测试两个真实 clone 交替推送、无冲突分叉生成双亲 merge、同条消息冲突不改当前工作区、离线重开恢复 outbox、暂停/oneShot、页面零订阅仍保存、远端改写。时间测试用 fake timers，Git 进程测试用实际轮询条件，不用固定长 sleep。
- [ ] 绿灯提交：`git add apps/daemon/src/services/project-git/sync.ts apps/daemon/src/services/project-git/scheduler.ts apps/daemon/tests/services/project-git/sync.test.ts apps/daemon/tests/services/project-git/scheduler.test.ts`；`git commit -m "feat(daemon): synchronize project repositories with durable retries"`。

### Task 10: 启用、非空绑定预览和从仓库打开

**Files:**

- Create: `apps/daemon/src/services/project-git/binding.ts`
- Test: `apps/daemon/tests/services/project-git/binding.test.ts`
- Modify: `packages/contracts/src/api/project-git.ts`（补齐绑定与依赖结果的具名 schema）

**Interfaces:**

- Produces: `classifyBinding(input: { localProjectId: string | null; remoteProjectId: string | null; hasCommonAncestor: boolean; remoteHead: string | null }): 'empty' | 'shared_history' | 'independent_history' | 'different_project'`。
- `ProjectGitPreview = { id: string; kind: 'enable' | 'bind' | 'restore' | 'resolve'; basis: ProjectGitBasis; targetOid: string | null; expiresAt: number; changes: ProjectGitChangeSummary; dependencies: ProjectGitDependency[] }`；summary 有新增/修改/删除文件与设置/会话计数、ignored/private/missing 路径、历史模式及需用户确认的碰撞项。
- `ProjectGitDependency`：`kind: git | identity | agent | model | plugin | linked_folder | lfs | submodule | resource`、label、requiredForContent、可执行下一步；缺执行授权与缺内容分别报告。
- Service operations：`previewEnable(projectId)`、`enable(projectId, previewId)`、`previewBinding(projectId, url, branch)`、`bind(projectId, previewId)`、`unbind(projectId)`、`openRepository({ url, branch, idempotencyKey })`，统一返回持久 operation，result 可带 preview/projectId。

- [ ] 写不同产品身份红测试：

```ts
it('does not combine two independent Open Design projects', () => {
  expect(classifyBinding({ localProjectId: 'product-a', remoteProjectId: 'product-b',
    hasCommonAncestor: true, remoteHead: 'abc' })).toBe('different_project');
  expect(classifyBinding({ localProjectId: 'product-a', remoteProjectId: null,
    hasCommonAncestor: false, remoteHead: 'abc' })).toBe('independent_history');
});
```

- [ ] 运行 `pnpm --filter @open-design/daemon test -- tests/services/project-git/binding.test.ts`，预期失败。
- [ ] 分类顺序固定：先拒不同身份，再判断空远端/共同祖先/独立历史：

```ts
if (input.localProjectId && input.remoteProjectId && input.localProjectId !== input.remoteProjectId) {
  return 'different_project';
}
if (input.remoteHead === null) return 'empty';
return input.hasCommonAncestor ? 'shared_history' : 'independent_history';
```

- [ ] enable 先 preview 再 confirm；`POST /git/enable` body 使用 `{ mode: 'preview' | 'confirm', previewId?: string }`。预览包含忽略/私有路径和已有 Git 状态；未知 `.open-design` 不覆盖，子目录不初始化嵌套 Git，不自动填作者；已有历史接当前 HEAD。新项目默认 enable 由任务 18 的创建流程展示默认范围后调用，不给旧项目批量启用。
- [ ] 预览保存精确 local/remote OID、两种 revision、generation、请求摘要及变更候选。confirm 重新验证远端和未提交编辑；不使用同一个空祖先自动吞并独立历史。独立历史明确逐路径确认，生成保留两个父提交的 merge；不同项目引导单独打开，不提供强行覆盖。
- [ ] 同实际工作目录重复打开返回已有 projectId；同 repositoryProjectId 的其他 clone 显示已有副本并使用独立 cloneId/local ID。持久检查 commonDir +目标分支唯一性并与 lease 配合，两个 daemon 注册竞争不能都成功。
- [ ] 跨数据根的注册不能只靠各自 SQLite UNIQUE：取得commonDir lease后，通过专用本地 ref `refs/open-design/bindings/<branch-digest>` CAS保存binding owner blob，包含dataRootId/projectId/canonicalRoot/generation；branch-digest是完整目标ref的SHA-256。不同owner拒绝第二个可写绑定，同owner重复打开复用记录。普通解绑仅解除远端，保留本地管理归属；切换分支或明确删除项目注册时条件更新/释放归属，不删除仓库历史。这些ref不推送，崩溃后与SQLite注册journal一起核对。
- [ ] open 用 server 注入准备目录 clone --no-checkout，安全读取/校验后物化并登记；项目列表只在文件+DB完成后可见。失败只保留 operation，不留正常列表孤儿；同幂等键不重复项目。普通仓库识别入口、保持旧历史并加首个完整提交。正式绑定后按已告知行为 autoSync=true；导入不安装运行依赖。
- [ ] rebind 要求先暂停，保存当前状态并预览；解绑取消尚未开始的网络任务，对已发出的 push 等结果明确再推进 generation。Git remote 配置修改若必要只改本应用所有的专用 remote，不覆盖用户 origin；实际 URL/branch 可保存在本地 binding，Git 按显式参数执行。
- [ ] 添加空远端、只读远端、独立历史同名碰撞、已有文件版仓库、LFS/submodule 依赖、未知 schema、缺附件、重复导入、进程退出后重试、失效预览测试。只读连接检测不能声明写权限保证。
- [ ] 绿灯提交：`git add apps/daemon/src/services/project-git/binding.ts apps/daemon/tests/services/project-git/binding.test.ts packages/contracts/src/api/project-git.ts`；`git commit -m "feat(daemon): open and bind portable project repositories"`。

### Task 11: 历史预览、完整恢复与旧单文件历史兼容

**Files:**

- Create: `apps/daemon/src/services/project-git/history.ts`、`restore.ts`
- Modify: `apps/daemon/src/project-file-versions.ts`（来源区分与 legacy reader，不删旧资料）
- Test: `apps/daemon/tests/services/project-git/restore.test.ts`、`history.test.ts`
- Test: `apps/daemon/tests/project-file-versions.test.ts`

**Interfaces:**

- Produces: `readHistory(root, cursor, path?): Promise<ProjectGitHistoryPage>`；`readCommit(root, oid): Promise<ProjectGitCommit>`；`readCommitFile(root, oid, path): Promise<{ encoding: 'base64'; content: string; mediaType: string }>`；`readCommitConversations(root, oid): Promise<PortableSnapshot | null>`。
- Produces: `makeRestoreParents(currentHead: string): string[]`；`previewRestore(projectId, targetOid): Promise<ProjectGitPreview>`；`restoreProject(projectId, previewId): Promise<ProjectGitAccepted>`，由 service 注入仓库/db/gate。
- History ID 按来源判别：`{ source: 'git'; oid: string } | { source: 'legacy'; path: string; legacyId: string }`；兼容旧单文件 API 继续接受原 legacyId，不能把字符串强制当 SHA。

- [ ] 写恢复 ancestry 红测试的最小核心：

```ts
it('makes restoration a child of the current head, not the historical target', () => {
  expect(makeRestoreParents('current-v3')).toEqual(['current-v3']);
});
```

同时建立真实 V1→V2→V3 fixture；恢复 V1 后读取 HEAD 树和 DB 与 V1 比较，`git merge-base --is-ancestor V3 HEAD` 必须成功，目标不是 detached HEAD。
- [ ] 运行 `pnpm --filter @open-design/daemon test -- tests/services/project-git/restore.test.ts tests/services/project-git/history.test.ts tests/project-file-versions.test.ts`，预期新增函数缺失。
- [ ] 实现明确的 parent 构造：

```ts
export function makeRestoreParents(currentHead: string): string[] { return [currentHead]; }
```

恢复候选树来自 target，父亲来自保护后的当前 HEAD；提交说明记录 restoreTarget。若 dirty 内容与预览一致，先保护 checkpoint 并在同一个 journal 更新 publishBase；新增编辑/远端变化使 preview stale。active run、冲突或未完成物化返回 PROJECT_BUSY/GIT_CONFLICT，不取消任务。
- [ ] 普通旧提交无 manifest→只应用普通版本化文件，保留当前 `.open-design`、设置、会话及聊天资源，再生成完整新提交。完整目标→files/settings/chat 全替换，current binding/local IDs/授权保持本机语义。资源完整性检查在破坏性写入前完成。
- [ ] 历史读取使用 cat-file/object tree，不 checkout；分页游标包含 commit identity 与请求的历史起点，真实 parent 列表保留 merge 图。历史文件返回明确 base64 编码；inline 预览使用现有沙箱响应策略且禁写，不执行旧表单。
- [ ] 旧 `.file-versions` 首次 enable 做原始 manifest/字节归档并有完成 marker；原路径读取仍有效，另一 clone 通过 portable legacy reader 读取。managed 项目的单文件 restore 只改该文件，再做完整 checkpoint；legacy 未启用路径仍走原逻辑，不伪造旧 Git 提交。
- [ ] 补充 dirty 保护、保护提交后恢复 parent、文件版不丢聊天附件、旧历史跨数据根恢复、分页并发新提交、未知/不可达提交、历史预览越界、失败恢复重启测试。
- [ ] 绿灯提交：`git add apps/daemon/src/services/project-git/history.ts apps/daemon/src/services/project-git/restore.ts apps/daemon/src/project-file-versions.ts apps/daemon/tests/services/project-git/restore.test.ts apps/daemon/tests/services/project-git/history.test.ts apps/daemon/tests/project-file-versions.test.ts`；`git commit -m "feat(daemon): restore project history as new commits"`。

### Task 12: 封闭现有写入、读取和运行终态入口

**Files:**

- Create: `apps/daemon/src/services/project-git/mutation-adapter.ts`、`runtime-adapter.ts`
- Modify: `apps/daemon/src/projects.ts`、`src/routes/project/index.ts`、`src/routes/project/conversations.ts`、`src/routes/runs.ts`
- Modify: `apps/daemon/src/runtimes/runs.ts`、`src/runtimes/chat-run-messages.ts`、`src/services/internal-run-service.ts`
- Modify: `apps/daemon/src/mcp.ts`、`src/artifacts/create.ts`、`src/import-export-routes.ts`、`src/routes/library.ts`、`src/plugins/share-helpers.ts`、`src/design-systems/server-services.ts`
- Modify: `apps/daemon/src/server.ts`（上传/运行/读写入口薄接入）、`src/server-context.ts`
- Test: `apps/daemon/tests/services/project-git/mutation-adapter.test.ts`、`runtime-adapter.test.ts`
- Test: `apps/daemon/tests/services/internal-run-service.test.ts`、`tests/runtimes/run-terminal-reconciliation.test.ts`、`tests/chat-run-messages-pin.test.ts`

**Interfaces:**

- Produces: `assertProjectRevision(managed: boolean, actual: number, expected: number | undefined): void`；`withProjectMutation<T>(input: { projectId: string; expectedProjectRevision?: number; source: string }, work: () => Promise<T>): Promise<T>`；`withProjectRead<T>(projectId: string, work: () => Promise<T>): Promise<T>`；adapter 构造时注入 store/gates，不能定义全局新数据根。
- Produces: `createProjectGitRuntimeAdapter(deps): { admit(projectId: string, expectedProjectRevision?: number): Promise<{ projectRevision: number; release(): void }>; onTerminal(runId: string, projectId: string, terminal: string): void; onSettled(runId: string): void }`。deps 具名含 store、gate lookup、scheduler notify、runId→permit 注册。
- `runtimes/runs.ts` 新增可选本地 `onSettled` hook，在 terminal persist + run.onFinalize + 最终 persist 完成后调用；不改变现有 onTerminal 的时机。beforeFinish 归并消息，onTerminal 同步持久标 dirty，onSettled 才 release permit。异常终态也以 finally 保证收敛，不在 synchronous terminal hook 内 await 网络 Git。

- [ ] 写 epoch 红测试：

```ts
it('allows ordinary edits in one epoch but rejects old or missing epochs after restore', () => {
  expect(() => assertProjectRevision(true, 7, 7)).not.toThrow();
  expect(() => assertProjectRevision(true, 8, 7)).toThrow();
  expect(() => assertProjectRevision(true, 8, undefined)).toThrow();
  expect(() => assertProjectRevision(false, 0, undefined)).not.toThrow();
});
```

- [ ] 运行 `pnpm --filter @open-design/daemon test -- tests/services/project-git/mutation-adapter.test.ts tests/services/project-git/runtime-adapter.test.ts`，预期缺实现。
- [ ] 实现 revision guard，比较放在 gate 获得后及实际 DB/FS 修改前，不在长 await 前比较一次就信任：

```ts
export function assertProjectRevision(managed: boolean, actual: number, expected: number | undefined): void {
  if (managed && expected !== actual) {
    throw new GitDomainError('PROJECT_STATE_CHANGED', 409, 'Reload the project before editing.');
  }
}
```

成功内容写入递增 contentRevision 并标 dirty；部分文件写入后报错仍检测并标 dirty，不能因为 HTTP 失败就漏保存部分成果。非内容 tab/本机绑定/遥测变化不触发 portable 版本。
- [ ] 根据下表逐入口接入；复用低层门禁时避免同一请求重复取得非重入锁。传递显式 mutation/run permit，内部嵌套不靠“当前有活跃 run”全局豁免权限：

| 入口 | 修改/读取边界 |
| --- | --- |
| `projects.ts` + project routes | 写/上传/删除/重命名文件及目录、项目设置、旧历史 restore；当前文件/详情读取走 read gate |
| `routes/project/conversations.ts` | 会话创建/改名/删除、消息 upsert/删除/排序；当前聊天读取走 read gate |
| `server.ts` + `routes/runs.ts` | 普通前台任务、上传、重试/继续任务；创建任务时绑定 epoch，开跑前检查远端 |
| `services/internal-run-service.ts` | 后台/自动化/内部启动同样取得 run permit；原同步 prepare 可保留，异步 admission 在实际 starter 前 |
| `mcp.ts` | 工具读到的项目 epoch 随写请求/会话上下文携带；旧排队工具请求不能自动 fetch 新 epoch 后强行重放 |
| artifacts / library / imports / plugin share / design-system services | 只有目标属于项目工作目录的写入进入相同协调；全局品牌/模板产物不误绑定用户项目 |
| runtime message finalizers | 只写所属 run 的记录；持久终态和最终消息收敛后释放 run permit |

- [ ] JSON修改在body携带expectedProjectRevision；multipart上传使用同名form字段；DELETE等无JSON body的现有入口统一接收 `X-OD-Project-Revision`，HTTP adapter归一化成同一字段，header/body同时出现且不同返回400。同步更新Web/CLI/CORS允许头及接口测试，不能让一种上传或删除绕过校验。
- [ ] 当前文件的raw/下载/preview资源响应若流式发送，read permit持有到响应finish/close，不能在建立stream后立刻释放；状态/历史及长连接SSE本身不持有永久read permit。恢复后的多资源页面按epoch刷新，不能拿旧响应覆盖新epoch缓存。
- [ ] 用 `rg -n 'writeProjectFile|createProjectFolder|deleteProjectFile|deleteProjectFolder|renameProjectFile|upsertMessage\(' apps/daemon/src` 建立带文件/函数的覆盖清单，核验 `runtimes/plain-stream.ts`、`brands/index.ts`、`brands/kit-render.ts` 是否写项目；若是，补入本任务 exact diff；若不是，记录理由。不能只凭上述 grep 自称覆盖所有 fs，继续追踪 raw writeFile/rename/copy 的项目路径来源。
- [ ] 增加两运行重叠、成功/失败/取消、finalizer 延迟/失败、启动时 orphan terminal 回补、同 epoch 两次保存不互相拒绝、旧请求拒绝、物化读屏障、MCP 和内部任务不可绕过测试。Git 失败不能改变原模型终态或撤销已成功文件保存。
- [ ] 执行新增测试和列出的三个现有 runtime 回归测试；记录每个接入点红/绿证据。按实际修改 exact paths 暂存（上面清单只暂存确实接入的文件），`git commit -m "feat(daemon): coordinate project mutations and run checkpoints"`。暂不启用新项目默认 Git。

### Task 13: 服务组合、全量 HTTP 合同和事件

**Files:**

- Create: `apps/daemon/src/services/project-git/service.ts`、`apps/daemon/src/routes/project-git.ts`
- Modify: `apps/daemon/src/server.ts`、`src/server-context.ts`、`src/route-context-contract.ts`
- Modify: `packages/contracts/src/api/project-git.ts`、`packages/contracts/src/index.ts`
- Test: `apps/daemon/tests/project-git-routes.test.ts`

**Interfaces:**

- Produces: `createProjectGitService(input: { db: Database.Database; store: ProjectGitStore; operationRoot: string; resolveProjectRoot(projectId: string): Promise<string>; emit(projectId: string, event: ProjectGitEvent): void }): ProjectGitService`。
- `ProjectGitService` 公开 `getState(projectId): Promise<ProjectGitState>`、`execute(action: ProjectGitAction, context: ProjectGitRequestContext): Promise<ProjectGitAccepted>`、`getOperation(id): Promise<ProjectGitOperation>`、`history(projectId, cursor?, path?): Promise<ProjectGitHistoryPage>`、`commit(projectId, oid): Promise<ProjectGitCommit>`、`file(projectId, oid, path): Promise<ProjectGitFileResponse>`、`conversations(projectId, oid): Promise<PortableSnapshot | null>`、`conflicts(projectId): Promise<ProjectGitConflict[]>`、`start(): Promise<void>`、`stop(): Promise<void>`。
- `ProjectGitAction` 为判别 union，kind 为 enable_preview/enable/binding_preview/bind/unbind/pause/resume/sync/open/restore_preview/restore/resolve/retry；每个变体定义前述必需参数。`ProjectGitRequestContext` 含 actorId、projectId、idempotencyKey、expectedProjectRevision。鉴权后的 context 由路由产生，不能让请求 body 自选 actor。
- `ProjectGitEvent = { type: 'project-git-state'; projectId: string; state: ProjectGitState } | { type: 'project-git-operation'; projectId: string; operation: ProjectGitOperation }`；既有 SSE 通道注册这两个事件，断线后重新 GET 状态，不依赖事件必达。
- Produces: `registerProjectGitRoutes(app: Express, ctx: RegisterProjectGitRoutesDeps): void`；deps 依现有 RouteDeps 选最小 http/权限上下文及 projectGit service。

- [ ] 基于 `tests/project-file-version-routes.test.ts` 的 startServer/HTTP 模式写红测试，使用 `tests/setup.ts` 已隔离的 OD_DATA_DIR，不自行发明数据根。首个断言：

```ts
const response = await fetch(`${baseUrl}/api/projects/${projectId}/git`);
expect(response.status).toBe(200);
const state = await response.json() as ProjectGitState;
expect(state.enabled).toBe(false);
expect(state.phase).toBe('enable_pending');
```

projectId 由每个 case 自己 POST 创建；本阶段默认启用尚未激活。激活后旧项目测试从未启用的迁移 fixture 创建，不靠修改新项目默认行为维持测试。
- [ ] 运行 `pnpm --filter @open-design/daemon test -- tests/project-git-routes.test.ts`，预期 404。
- [ ] 组合现有内核，错误从任务 2 的无环模块导入，不附未脱敏 stderr：

```ts
import { GitDomainError } from './errors.js';
```

内核依赖自身窄 ports，不 import service 工厂形成运行时循环。
- [ ] 按下表一次闭合路由；每个 mutation 验 caller 权限、revision/preview、幂等键，返回 202 operationId。状态开关也作为短异步 operation，统一轮询结果。读取维持 200；不存在对象 404、非法输入 400、revision/conflict 409、缺依赖按结构化错误处理。

| HTTP | Service action / read | CLI |
| --- | --- | --- |
| `GET /api/projects/:id/git` | getState | status |
| `POST /api/projects/:id/git/enable` | enable_preview / enable | enable |
| `POST /api/projects/:id/git/binding-preview` | binding_preview | bind-preview |
| `POST /api/projects/:id/git/bind` | bind | bind |
| `POST /api/projects/:id/git/unbind` | unbind | unbind |
| `PATCH /api/projects/:id/git` | pause / resume | pause / resume |
| `POST /api/projects/:id/git/sync` | sync | sync |
| `POST /api/import/git` | open | open |
| `GET /api/projects/:id/git/history` | history | log |
| `GET /api/projects/:id/git/commits/:oid` | commit | show |
| `GET /api/projects/:id/git/commits/:oid/files/*path` | file | show --path |
| `GET /api/projects/:id/git/commits/:oid/conversations` | conversations | show --conversations |
| `POST /api/projects/:id/git/restore-preview` | restore_preview | restore-preview |
| `POST /api/projects/:id/git/restore` | restore | restore |
| `GET /api/projects/:id/git/conflicts` | conflicts | conflicts |
| `POST /api/projects/:id/git/conflicts/resolve` | resolve | resolve |
| `GET /api/project-git-operations/:id` | getOperation | operation |
| `POST /api/project-git-operations/:id/retry` | retry | retry |

- [ ] 操作 GET/retry 依据 operation 关联项目/actor 鉴权，不能凭随机 ID 越权读取或重试别的导入。预览 result 无凭据，历史可读不等于允许继续执行旧任务。所有错误使用 `sendApiError` 的现有 envelope，响应包含安全 next action。
- [ ] resolve 输入除逐项结果，还带 operationId、本地/远端 basis、两种 revision；应用前重新 fetch 核对，远端前进或本地新编辑即 PREVIEW_STALE。继续本地编辑可 checkpoint，但 conflict 未解禁止 remote apply/push/restore。
- [ ] 服务在恢复日志完成后启动调度，shutdown 等运行收敛后停止；状态/operation 变更通过既有项目 SSE 发送，Web 未订阅不影响工作。`server.ts` 只组装路径和服务；新字段在 server-context 与 route-context-contract 同步验证。
- [ ] 每条路由补成功/输入无效/项目越权测试；多次幂等确认同 operation；current read 屏障但 history/status 可读；git failure 不改原写文件 200 结果。绿灯并跑 contracts typecheck。
- [ ] 提交：`git add apps/daemon/src/services/project-git/service.ts apps/daemon/src/routes/project-git.ts apps/daemon/src/server.ts apps/daemon/src/server-context.ts apps/daemon/src/route-context-contract.ts apps/daemon/tests/project-git-routes.test.ts packages/contracts/src/api/project-git.ts packages/contracts/src/index.ts`；`git commit -m "feat(api): expose project git operations and history"`。

### Task 14: od git 与既有 CLI 修改的代次协议

**Files:**

- Create: `apps/daemon/src/cli/project-git.ts`
- Modify: `apps/daemon/src/cli.ts`（SUBCOMMAND_MAP、help、既有项目/文件/会话/任务写命令）
- Test: `apps/daemon/tests/project-git-cli.test.ts`、`apps/daemon/tests/project-cli.test.ts`

**Interfaces:**

- Produces: `runProjectGit(args: string[]): Promise<void>`，模块不 import 执行中的 cli.ts。
- Produces: `parseProjectGitCommand(args: string[]): ProjectGitCliRequest`；`ProjectGitCliRequest` 有 `method: 'GET' | 'POST' | 'PATCH'`、`path`、`body?: Record<string, JsonValue>`、`json`、`promptFile?: string`、`outputPath?: string`。解析不做网络/文件副作用。
- `readProjectGitPromptFile(path: string): Promise<string>`：`-` 读取 stdin，否则 fs.readFile UTF-8；请求 body JSON 由 contracts schema 校验，文件内容不拼 shell。

- [ ] 写 parser 与真实 CLI child process 的红测试：

```ts
it('maps a restore confirmation to the same HTTP contract', () => {
  expect(parseProjectGitCommand(['restore', '--project', 'p 1', '--preview', 'v1', '--json']))
    .toMatchObject({ method: 'POST', path: '/api/projects/p%201/git/restore',
      body: { previewId: 'v1' }, json: true });
});
```

child process fixture 复用 `tests/project-cli.test.ts` 的本地 http.createServer、CapturedRequest 和 node+tsx 调用模式，核对实际 method/url/body，而非只测 parser。
- [ ] 运行 `pnpm --filter @open-design/daemon test -- tests/project-git-cli.test.ts tests/project-cli.test.ts`，预期新命令失败。
- [ ] 用具名顶层 import 注册，不引入模块 TDZ：

```ts
import { runProjectGit } from './cli/project-git.js';
// SUBCOMMAND_MAP 增加：
// git: runProjectGit,
```

service 地址和授权解析复用 cli.ts 已有约定，必要时将真正共享的窄 HTTP helper 提取至新 `src/cli/http.ts` 并把精确路径纳入本提交；不要 import cli.ts 来获取 helper。help 包含所有表中命令及 daemon 侧 Git/凭据语义。
- [ ] 每个命令支持 --json；所有 mutation 接受 --prompt-file JSON body，flags 与文件重复字段冲突报错。enable 默认只做 preview，`--preview <id>` 确认；bind/restore 必须提供 preview；resolve 必须 operation + prompt-file。open 明确说明成功后开启自动同步。`show --json --path` 返回 encoding/content；二进制写磁盘必须显式 `--output`，已存在输出文件默认拒绝覆盖，用户显式选择才可覆盖。
- [ ] 为现有 files/project/conversation/chat/run 修改命令增加 epoch：交互工作流在首次读取内容时保存 revision，新独立命令可先读取一次状态后提交；同次操作失败不自动刷新 epoch重试。预览确认用原 basis，不因 CLI 执行时读取新状态绕过 stale。MCP 不通过 CLI 隐式补最新 revision。
- [ ] 覆盖表中全部命令；stdin、路径空格、无效 JSON、长合并文本、401/403/409、脱敏 stderr、202 operation polling、非零退出码。不得给成功 JSON 混入进度文本；进度走 stderr 且同样脱敏。
- [ ] 运行 `pnpm install`、上述 tests、`pnpm --filter @open-design/daemon build`；以构建后的 `dist/cli.js git --help` 验证真实入口。无新依赖时 lockfile 应无无关漂移。
- [ ] 提交 exact files：`git add apps/daemon/src/cli/project-git.ts apps/daemon/src/cli.ts apps/daemon/tests/project-git-cli.test.ts apps/daemon/tests/project-cli.test.ts`；如确实新增 http.ts 另精确暂存；`git commit -m "feat(cli): add project git commands and revision checks"`。

### Task 15: Web 请求、共享状态与旧请求失效

**Files:**

- Create: `apps/web/src/state/project-git.ts`、`apps/web/src/providers/project-git.ts`
- Modify: `apps/web/src/state/projects.ts`、`src/providers/registry.ts`、`src/providers/daemon.ts`、`src/providers/project-events.ts`
- Modify: `apps/web/src/components/ProjectView.tsx`
- Test: `apps/web/tests/state/project-git.test.ts`

**Interfaces:**

- Produces: `createProjectRevisionTracker(initial: number): { current(): number; accept(next: number): boolean; capture(): { expectedProjectRevision: number }; isCurrent(captured: number): boolean }`。
- `ProjectGitClient`：`state(projectId)`、`execute(action, basis)`、`operation(id)`、`history(projectId,cursor?,path?)`、`commit(projectId,oid)`、`file(projectId,oid,path)`、`conversations(projectId,oid)`、`conflicts(projectId)`；完全使用任务 1/13 DTO 和 HTTP，不自行实现 Git。
- `useProjectGit(projectId)` 返回 state、loading、error、refresh、execute；同 projectId 共享一份订阅/请求去重，卸载只取消浏览器请求，不停 daemon scheduler。

- [ ] 写旧保存不能冒充新代次的红测试：

```ts
it('keeps a queued save bound to the epoch in which its content was edited', () => {
  const tracker = createProjectRevisionTracker(4);
  const queuedSave = { content: 'old draft', ...tracker.capture() };
  expect(tracker.accept(5)).toBe(true);
  expect(queuedSave.expectedProjectRevision).toBe(4);
  expect(tracker.isCurrent(queuedSave.expectedProjectRevision)).toBe(false);
  expect(tracker.capture()).toEqual({ expectedProjectRevision: 5 });
});
```

- [ ] 运行 `pnpm --filter @open-design/web test -- tests/state/project-git.test.ts`，预期失败。
- [ ] 实现代次跟踪，处理乱序事件：

```ts
export function createProjectRevisionTracker(initial: number) {
  let revision = initial;
  return {
    current: () => revision,
    accept(next: number) { if (next <= revision) return false; revision = next; return true; },
    capture: () => ({ expectedProjectRevision: revision }),
    isCurrent: (captured: number) => captured === revision,
  };
}
```

- [ ] 在文件编辑动作、settings draft、message/conversation 编辑及 run 创建时 capture，不在 debounce 到期/HTTP retry 时重新读当前值。恢复事件推进 epoch 后 cancel timer、abort pending request、清理旧 form/run 提交状态；已发到 daemon 的请求依赖后端拒绝，不宣称 abort 等于撤销。
- [ ] 拉取新文件树/预览/chat/settings/dependencies 后才允许继续编辑；不要只更新文件面板。409 PROJECT_STATE_CHANGED 给用户重新加载说明，保留可复制的旧草稿供手动处理，不自动覆盖新版本。普通 contentRevision 变更不取消同代次编辑/运行。
- [ ] SSE 初连/重连先 GET state，事件按 epoch 处理；operation 采用可取消轮询直到 terminal，页面关闭不改变 autoSync。状态完全由 daemon DTO 展示，不以 fetch 200 或文件保存成功推导 synced。
- [ ] 覆盖 rename/delete/upload、消息 edit/delete、settings、tasks 与 registry/provider 的已有函数；测试过期响应晚到不会覆盖较新 state、StrictMode 不创建多份后台调度、Git错误与模型终态分别显示。
- [ ] 绿灯提交：`git add apps/web/src/state/project-git.ts apps/web/src/providers/project-git.ts apps/web/src/state/projects.ts apps/web/src/providers/registry.ts apps/web/src/providers/daemon.ts apps/web/src/providers/project-events.ts apps/web/src/components/ProjectView.tsx apps/web/tests/state/project-git.test.ts`；`git commit -m "feat(web): track project git state and invalidate stale writes"`。

### Task 16: 状态条、项目设置、仓库打开与文案

**Files:**

- Create: `apps/web/src/components/project-git/ProjectGitStatus.tsx`、`ProjectGitSettings.tsx`、`OpenGitProjectDialog.tsx`、`ProjectGit.module.css`
- Modify: `apps/web/src/components/ProjectActionsToolbar.tsx`、`ProjectView.tsx`、`HomeView.tsx`、`ChatComposer.tsx`、`NewProjectPanel.tsx`、`NewProjectModal.tsx`
- Modify: `apps/web/src/i18n/types.ts`
- Modify: `apps/web/src/i18n/locales/en.ts`、`zh-CN.ts`、`zh-TW.ts`、`ar.ts`、`de.ts`、`es-ES.ts`、`fa.ts`、`fr.ts`、`hu.ts`、`id.ts`、`it.ts`、`ja.ts`、`ko.ts`、`pl.ts`、`pt-BR.ts`、`ru.ts`、`th.ts`、`tr.ts`、`uk.ts`
- Test: `apps/web/tests/components/project-git-settings.test.tsx`

**Interfaces:**

- `ProjectGitStatus({ state, onHistory, onSync, onToggleAutoSync })`；`ProjectGitSettings({ projectId, client, onClose })`；`OpenGitProjectDialog({ client, onOpened, onClose })`，props 使用任务 1/15 类型，onOpened 接收 projectId。
- CSS 使用项目现有语义 token、焦点/disabled/loading 模式，不新增硬编码主题色。

- [ ] 写待推送不能显示已同步的组件红测试，文件用 jsdom 与现有 i18n provider：

```tsx
render(<ProjectGitStatus state={{ ...baseState, phase: 'pending_push', pendingPush: true }}
  onHistory={vi.fn()} onSync={vi.fn()} onToggleAutoSync={vi.fn()} />);
expect(screen.getByRole('status')).toHaveTextContent('待推送');
expect(screen.queryByText('已同步')).not.toBeInTheDocument();
```

本文件 `baseState` 使用 `satisfies ProjectGitState` 完整字面量，HEAD=null、revision=0、enabled=true、autoSync=true、dirty=false、pendingPush=false、operationId/error=null，其他可空字段显式 null；用本地 fixture 包装真实 i18n provider，不 mock 状态推断逻辑。
- [ ] 运行 `pnpm --filter @open-design/web test -- tests/components/project-git-settings.test.tsx`，预期缺组件。
- [ ] 状态条消费合同，提供 live region 与可访问名称：

```tsx
<div role="status" aria-live="polite" data-testid="project-git-status">
  {t(`projectGit.phase.${state.phase}`)}
</div>
```

模板 key 使用 Dict 对应联合类型；未知 phase 在合同解析时失败，不用不安全 cast 绕过。具体状态文案：

| phase | 简体中文 | English |
| --- | --- | --- |
| enable_pending | 版本管理待启用 | Versioning needs setup |
| waiting_idle | 等待项目空闲 | Waiting for project to be idle |
| dirty | 未保存为版本 | Changes not versioned |
| checkpointing | 正在保存版本 | Saving version |
| local_saved | 已保存本地版本 | Saved locally |
| pending_push | 待推送 | Waiting to push |
| syncing | 正在同步 | Syncing |
| synced | 已同步 | Synced |
| paused | 自动同步已暂停 | Automatic sync paused |
| conflict | 存在冲突 | Conflicts need resolution |
| auth_required | 需要认证 | Authentication required |
| external_git_busy | 外部 Git 操作中 | External Git operation in progress |
| recovering | 正在恢复 | Recovering |
| failed | 版本操作失败 | Version operation failed |

- [ ] 添加平铺 i18n keys `projectGit.open`、`history`、`settings`、`url`、`branch`、`testConnection`、`preview`、`confirm`、`unbind`、`syncNow`、`pause`、`resume`、`restore`、`conflicts`、`localSide`、`remoteSide`、`ancestor`、`stalePreview`、`fileOnlyWarning`、`daemonAuthNotice`、`autoSyncNotice`、`externalEditorNotice` 及各 phase。英文/简中按本计划表和 spec 行为写入，其余 17 种语言提供同义完整翻译，保持 Dict 全字段编译通过，不删除旧键或使用机器内部错误 message 作 UI 主文案。
- [ ] 设置流程：启用范围预览→确认；地址/分支→连接检测与 binding preview→确认；更换绑定先暂停并展示影响；解绑显示在途任务并等待。只读检测文案不能说“拥有推送权限”。认证说明“使用运行 Open Design 服务的电脑上的 Git 凭据”。
- [ ] 首页导入：URL/branch、自动同步告知、操作进度、缺资源与缺运行依赖区分；只有 operation 成功且有 projectId 才进入项目。现有文件夹导入和普通新建按钮不变，失败导入不出现在最近项目。
- [ ] 新项目创建面板展示默认本地版本管理及纳入/忽略范围说明，不把“默认本地Git”说成“默认已推送”；CLI新建help对应说明。已有项目启用仍要求具体路径预览，不能只复用新项目的通用说明。
- [ ] 组件测试覆盖14种 phase、键盘操作/焦点回收、两步确认、preview stale、请求 pending 防重复、解绑在途 push、身份缺失仍可编辑。状态条接 ProjectActionsToolbar，设置沿现有 composer 项目设置入口打开，HomeView 接仓库打开，不另造不可达页面。
- [ ] 测试与 Web typecheck 绿灯后，精确暂存本任务列出的新组件、六个接入文件、types、19个 locale 与测试，`git commit -m "feat(web): add project git setup and sync controls"`。

### Task 17: 项目历史、冲突解决与恢复后刷新

**Files:**

- Create: `apps/web/src/components/project-git/ProjectGitHistory.tsx`、`ProjectGitRestoreDialog.tsx`、`ProjectGitConflicts.tsx`
- Modify: `apps/web/src/components/FileViewer.tsx`、`ProjectView.tsx`、`src/components/project-git/ProjectGit.module.css`
- Test: `apps/web/tests/components/project-git-history.test.tsx`、`project-git-conflicts.test.tsx`

**Interfaces:**

- `ProjectGitHistory({ projectId, client, onRestore })`；`ProjectGitRestoreDialog({ projectId, targetOid, client, onCompleted, onClose })`；`ProjectGitConflicts({ projectId, operationId, client, onCompleted })`。
- restore onCompleted 接新的 `ProjectGitState`，由任务 15 统一 invalidation，不在组件里逐个拼接数据库镜像。

- [ ] 写未预览不得确认恢复的红测试：

```tsx
expect(screen.getByRole('button', { name: '确认恢复' })).toBeDisabled();
await screen.findByText('文件版本');
expect(screen.getByText('仅恢复文件，保留当前设置和聊天')).toBeVisible();
```

测试 client 注入可控 Promise 返回实际 ProjectGitPreview；先 pending 再 resolve，确认按钮只在 preview成功且 basis 未失效时可用；不以 setTimeout 人工猜测 ready。
- [ ] 运行 `pnpm --filter @open-design/web test -- tests/components/project-git-history.test.tsx tests/components/project-git-conflicts.test.tsx`，预期失败。
- [ ] 实现两步恢复请求，携带原 previewId：

```ts
const accepted = await client.execute({ kind: 'restore', projectId, previewId: preview.id }, preview.basis);
// 保存 operationId 并订阅/轮询；只在 succeeded 后通知统一刷新。
```

历史条目展示短 SHA、作者/时间、source、真实 parents、full/files-only 标签；Git path 过滤与 legacy入口分开，现有单文件版本 ID 链接继续可用。历史读取不改当前工作目录。
- [ ] 提供 files/settings/messages/turn-order 冲突编辑：祖先、本地、远端三方都可查看；二进制选边；字段/消息允许编辑；turn-order 必须给出完整保留轮次次序，漏项/重复项拒绝。解决仅提交 proposal，服务校验并物化，UI 不直接覆盖文件。
- [ ] preview stale 清除确认能力、展示需重新预览，不静默重发；冲突期间继续本地编辑但恢复禁用。完整恢复要求明确影响摘要与外部编辑暂停提示，不能仅“确定吗”。
- [ ] 历史 iframe 采用现有受限预览方案；历史消息表单只读、不触发工具/运行。测试请求不会命中 `/api/runs`，历史 HTML 无顶层导航或任意父窗口能力。
- [ ] FileViewer 切换 Git路径历史/独立旧HTML历史；恢复后统一刷新文件树、preview、chat/settings/dependency状态，旧保存仍被取消/服务拒绝。新增需要的 Dict keys 同步19 locales，沿任务16规则精确暂存实际键变更。
- [ ] 测试绿灯后提交精确新组件、FileViewer/ProjectView/CSS、对应测试及 locale 实际改动，`git commit -m "feat(web): browse and restore complete project history"`。

### Task 18: 启用默认行为、迁移和 daemon 生命周期闭合

**Files:**

- Modify: `apps/daemon/src/server.ts`、`src/projects.ts`、`src/import-export-routes.ts`、`src/routes/project/index.ts`
- Modify: `apps/daemon/src/services/project-git/service.ts`、`scheduler.ts`、`runtime-adapter.ts`
- Modify: `apps/daemon/src/run-html-version-snapshots.ts`（managed 新历史委托，旧路径保留）
- Test: `apps/daemon/tests/project-git-lifecycle.test.ts`
- Test: `apps/daemon/tests/folder-import-projects.test.ts`、`run-html-version-snapshots.test.ts`、`project-file-version-routes.test.ts`、`project-file-rename.test.ts`、`project-file-range.test.ts`

**Interfaces:**

- Produces: `initializeNewProjectGit(projectId: string): Promise<void>`；只在新的用户项目创建落盘完成后调用；失败记录 enable_pending 而非删除项目。
- Existing service.start/stop：start先恢复再重建dirty/queue；stop在 active run 最终落库之后完成本地持久收尾，不承诺退出时离线 push成功。

- [ ] 先写默认创建能力失败降级的红测试：

```ts
expect(createResponse.status).toBe(200);
expect(await readFile(createdFile, 'utf8')).toBe('editable content');
expect(gitState.phase).toBe('enable_pending');
expect(gitState.error?.code).toBe('GIT_UNAVAILABLE');
```

fixture 通过构造注入 Git executable resolver 返回不存在路径，不修改用户 PATH/全局 Git；HTTP status 沿用实际现有创建契约。另一个 case 配置 fixture本地身份，断言真实首个完整提交。
- [ ] 运行 `pnpm --filter @open-design/daemon test -- tests/project-git-lifecycle.test.ts`，预期尚未自动启用而失败。
- [ ] 所有第一方接入齐全后激活创建 hook：

```ts
try { await initializeNewProjectGit(projectId); }
catch (error) {
  // 将安全的 enable_pending 原因持久化；已创建项目不回滚，不改变文件保存结果。
  await projectGit.recordEnablePending(projectId, error);
}
```

在 `ProjectGitService` 补 `recordEnablePending(projectId: string, error: unknown): Promise<void>`，只使用统一错误分类。首次初始化异步 operation 可先显示 pending；“已版本化”只能在实际提交后显示。
- [ ] 项目创建入口逐个核对：空白/模板/复制/导入文件/导入目录/派生设计系统/CLI/内部创建；重复 hook 幂等。不批量启用现有 DB 行；旧项目显式预览后启用。外部 orchestrator workspace 若其已有契约禁止本地 Git writeback，不强行默认管理，显示原因和需独立副本，不扩张该入口授权。
- [ ] 新 managed 项目跳过旧成功路径的重复 HTML 新快照；旧 legacy读取/恢复继续。统一终态收敛负责 failed/cancelled部分成果。shutdown 顺序核验：停止新 admission→结束活动运行→消息/terminal持久化→释放permit→保存dirty markers→停scheduler→关闭db；重启 recovery未完不能开放写入。
- [ ] 既有测试将新项目 first-party writes 带正确 epoch；旧非Git兼容 case用旧DB fixture，不通过默认禁用功能把测试变绿。排查服务器内“火并忘”的写入 Promise，必须计入在途 permit。
- [ ] 运行本任务全部列出测试以及完整 daemon tests；断言页面关闭仍 checkpoint，退出重启恢复 outbox，重复启动不重复基线/legacy归档，Git错误不把正常AI run变failed。
- [ ] 精确暂存本任务列出且实际修改的文件，`git commit -m "feat(daemon): enable project git lifecycle and legacy migration"`。

### Task 19: 双克隆公开边界验收、浏览器证据与文档

**Files:**

- Create: `e2e/tests/project-git-lifecycle.test.ts`、`e2e/ui/project-git.test.ts`
- Create: `e2e/lib/project-git-fixture.ts`、`e2e/lib/project-git-ssh.ts`（仅中性 Node Git/HTTP/CLI helper，无 app 私有 import）
- Create: `docs/project-git.md`
- Modify: `docs/architecture.md`、`QUICKSTART.md`（入口与文档链接，避免复制数据根规则）

**Interfaces:**

- `createProjectGitE2eFixture(root: string)` 产生隔离 bare remote、两个 clone及 `git`/`close`、`sshBinDir`、`remoteUrl`；root来自suite.scratchDir，禁止写用户Git配置。`project-git-ssh.ts` 实现测试 PATH 中的 ssh shim，只接受固定测试host和 fixture 已注册 repoId，映射到该bare repo，仅以参数数组调用 `git-upload-pack` / `git-receive-pack`，其他命令拒绝，不 eval SSH命令字符串。测试给daemon注入此PATH和fixture身份，公共 API使用 `ssh://git@project-git.invalid/<repoId>`；不新增生产 file transport/安全绕过开关。HTTPS认证错误另用本地受控HTTP服务测试。
- `requestJson<T>(baseUrl: string, path: string, init?: RequestInit): Promise<{ status: number; body: T }>`、`waitOperation(baseUrl: string, id: string): Promise<ProjectGitOperation>`、`runOd(baseUrl: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }>` 定义于此 helper，通过构建的 daemon CLI 和公开 API验证。
- `seedGitHistory(baseUrl: string): Promise<{ projectId: string; conversationId: string; targetOid: string; projectRevision: number; targetContent: string }>` 也定义于helper：POST创建项目/会话，写入 `version-one` 和一条消息，用git sync + waitOperation完成首个检查点并保存targetOid；写入 `version-two` 和新消息，再sync并等待，返回第二次状态的epoch。所有mutation带从该步骤状态读取的epoch和唯一幂等键；fixture身份保证初始化可用。该helper只做真实HTTP，不读取app私有DB。
- 非UI e2e 用 `createSmokeSuite(...).with.toolsDev`，两个独立 suite/dataDir；UI用已有 worker `toolsDev`，测试内不手动 spawn生命周期。

- [ ] 首先写 HTTP+CLI 红 spec：A enable/bind→文件/设置/chat/附件提交→B从repo open→B修改push→A同步→A恢复早期版本→B再次同步；每步读真实 Git/文件/DB公开查询。

```ts
const suite = await createSmokeSuite('project-git-lifecycle');
await suite.with.toolsDev(async ({ webUrl }) => {
  const { projectId } = await seedGitHistory(webUrl);
  const response = await requestJson<ProjectGitState>(webUrl, `/api/projects/${projectId}/git`);
  expect(response.status).toBe(200);
  expect(response.body.phase).toBe('local_saved');
  const cli = await runOd(webUrl, ['git', 'status', '--project', projectId, '--json']);
  expect(cli.code).toBe(0);
  expect(JSON.parse(cli.stdout).localHead).toBe(response.body.localHead);
});
```

这是无远端的本地seed/CLI一致性起点；之后在同一文件增加两个suite的bind/open链路，远端经真实引用核对后phase才断言synced。fixture建立与finalize放try/finally，采用现有suite报告保留失败证据。聊天/设置经现有HTTP查询验证；daemon层的DB事务证明留任务8。
- [ ] 从 `e2e/` 运行 `pnpm test tests/project-git-lifecycle.test.ts`；预期本任务新增helper/transport尚未实现而失败，记录真实原因，再实现公开边界fixture并验证整条链路。若已有组件使部分断言直接通过，不人为破坏它们凑红灯，不以仅mock全绿替代真实链路。
- [ ] 浏览器添加独立case，真实Git功能不route mock；可控 agent 用 `createFakeAgentRuntimes` + `agentCliEnv`，不耗模型额度：

```ts
import { expect, test } from '@/playwright/suite';
import { seedGitHistory } from '@/project-git-fixture';

test('[P1] project git history restores content and rejects an old editor save', async ({ page, toolsDev }) => {
  const seed = await seedGitHistory(toolsDev.url.web());
  const fileApi = `/api/projects/${seed.projectId}/files`;
  await page.goto(`/projects/${seed.projectId}/conversations/${seed.conversationId}`);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await page.route(`**${fileApi}`, async (route) => {
    entered.resolve(); await release.promise; await route.continue();
  }, { times: 1 });
  const delayedSave = page.evaluate(async ({ fileApi, revision }) => {
    const response = await fetch(fileApi, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'index.html', content: 'old queued draft', expectedProjectRevision: revision }) });
    return response.status;
  }, { fileApi, revision: seed.projectRevision });
  try {
    await entered.promise;
    await page.getByRole('button', { name: '版本历史', exact: true }).click();
    await page.getByTestId(`git-commit-${seed.targetOid}`).getByRole('button', { name: '恢复此版本' }).click();
    await page.getByRole('dialog').getByRole('button', { name: '确认恢复', exact: true }).click();
    await expect.poll(async () => {
      const response = await page.request.get(`/api/projects/${seed.projectId}/git`);
      return (await response.json()).projectRevision as number;
    }).toBeGreaterThan(seed.projectRevision);
    release.resolve(); expect(await delayedSave).toBe(409);
    const current = await page.request.get(`/api/projects/${seed.projectId}/raw/index.html`);
    expect(await current.text()).toBe(seed.targetContent);
  } finally { release.resolve(); }
});
```

通过既有配置fixture固定该case语言为zh-CN；任务17历史条目添加上述commit testid。用 `T` 常量为entered与poll设置可诊断超时，finally中收回延迟请求。另加GET当前messages与目标快照比较，证明聊天同步恢复；另一个case独立测试设置绑定预览→冲突三方查看→明确解决，不依赖前一case。
- [ ] 从 `e2e/` 运行 `pnpm exec playwright test -c playwright.config.ts ui/project-git.test.ts --workers=1`，使用 `T` 超时常量、观测ready信号、无 describe.serial/force click。独立运行任一case和完整文件都一次通过；记录状态条、绑定预览、历史恢复、冲突的入口截图。
- [ ] 增加失败见证：无网络认证→local_saved/pending不伪装synced；两clone同消息冲突→当前文件无marker；远端重写→保留旧refs；两daemon同repo→仅一方有写权限；journal各阶段退出→重启收敛；push成功/ack前退出→无重复提交。daemon层已经充分证明的phase矩阵不在每个UIcase重复。
- [ ] 写用户文档的具体命令流程：

```bash
od git enable --project <id> --json
od git operation <operation-id> --json
od git enable --project <id> --preview <preview-id> --json
od git bind-preview --project <id> --url <ssh-or-https-url> --branch main --json
od git bind --project <id> --preview <preview-id> --json
od git open --url <ssh-or-https-url> --branch main --json
od git log --project <id> --json
od git restore-preview --project <id> --commit <oid> --json
od git restore --project <id> --preview <preview-id> --json
od git resolve --project <id> --operation <id> --prompt-file resolution.json --json
```

每个202先查询operation获得preview/result再进入下一步；补写完整恢复范围、普通文件版本、旧HTML历史、daemon凭据、离线/冲突、退出期间暂停、外部编辑暂停、LFS/子模块依赖、未跟踪凭据和恢复不重写历史。docs/architecture只添加组件指针，不复制另一份数据根约定。
- [ ] 最终验证（仓库根，e2e步骤按前文切目录）：

```bash
pnpm guard
pnpm typecheck
pnpm --filter @open-design/contracts test
pnpm --filter @open-design/daemon test
pnpm --filter @open-design/web test
pnpm --filter @open-design/contracts build
pnpm --filter @open-design/daemon build
pnpm --filter @open-design/web build
git diff --check
git status --short
```

真实CLI检查必须在daemon build之后；e2e报告记录两端local/remote HEAD、祖先关系、附件摘要和恢复后chat/settings。不得只记录“测试通过”不留命令、退出码和关键断言。
- [ ] 精确提交：`git add e2e/tests/project-git-lifecycle.test.ts e2e/ui/project-git.test.ts e2e/lib/project-git-fixture.ts e2e/lib/project-git-ssh.ts docs/project-git.md docs/architecture.md QUICKSTART.md`；`git commit -m "test(projects): verify git synchronization and recovery end to end"`。用 requesting-code-review / verification-before-completion 做最终门槛；提交不是授权合并或推送。

## 自查与执行交接门槛

| Spec 章节 | 任务 | 必须保留的证据 |
| --- | --- | --- |
| 1–4 目标/边界/组件 | 1、12–19 | 单一功能UI+CLI闭合，未改sidecar/数据根 |
| 5 格式/资源/允许列表 | 1、5、6、10 | 两数据根roundtrip、缺资源拒绝、权限不迁移 |
| 6 journal/代次/读取 | 3、4、7、8、12、15 | 跨进程、逐阶段退出、旧请求409、读屏障 |
| 7 检查点 | 7、9、12、18 | 全部终态/重叠run、5秒、无空提交、索引干净 |
| 8 双向同步与冲突 | 6、9、13、17、19 | 两clone分叉、聊天顺序冲突、远端确认、重写保护 |
| 9 启用/绑定/打开 | 10、13、14、16、18 | 非空预览、不同项目拒绝、重复导入、缺Git降级 |
| 10 历史/恢复/legacy | 5、8、11、17、19 | 恢复新子提交、文件版保留聊天、旧HTML可迁移 |
| 11 UI/CLI/API | 1、13–17、19 | 路由命令一一对应、状态和错误一致、入口截图 |
| 12 权限与执行 | 2、3、5、7、10、13 | hook/filter不执行、脱敏、路径与历史权限 |
| 13–14 验收/迁移 | 18、19 | 新默认旧显式、幂等迁移、全部检查与review记录 |

- [ ] 每个任务交接携带：任务号、实际文件、公开接口、red/green命令与退出码、提交SHA、剩余已知限制。不得把未完成的UI/CLI/崩溃检查标为“后续优化”。
- [ ] 自查 API 表完整覆盖 spec；检查方法、请求字段、错误码、ProjectGitBasis/Revision 命名一致，contentRevision不被错当epoch。
- [ ] 自查没有无定义 helper、没有隐式授权新依赖/全局配置/远端写入；范围变动先报告，不用临时fallback绕过受限Git配置。
- [ ] 启动执行前由用户选择子代理逐任务审阅或当前会话批次执行；此计划完成不启动产品开发，不创建远端 issue/PR，不推送。
