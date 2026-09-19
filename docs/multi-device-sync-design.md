# lookingfor 多设备数据共享设计

设计日期：2026-09-19

## 结论

**不要把当前 `memories/`、`memory-revisions/revisions.json` 或 `lookingfor.sqlite` 直接放进 Dropbox、iCloud、OneDrive 等同步目录。** 推荐的正式方案是：每台设备保留完整的本地副本，通过一个端到端加密的不可变变更流同步，云端只保存密文事件和密文快照。

这保持了 lookingfor 的本地优先属性：断网时仍可搜索和写入；网络恢复后由客户端合并；同步提供方既拿不到 Source 原文、Credential、Memory 内容，也拿不到模型 API Key。现有 SQLCipher 和 Markdown 仍分别承担本地关系数据与用户可读文件的存储，不把远端服务变成应用运行所必需的数据库。

建议分两步交付：

1. 先提供**加密导出/导入与单设备接力**，解决换机、备份和偶尔在另一台设备继续使用；
2. 再实现**多写者增量同步**，支持多台设备离线修改、恢复联网和显式冲突处理。

第一步不能宣传为实时同步，但能尽早验证密钥、数据完整性、版本迁移和恢复流程。第二步建立在同一种加密包格式之上，不浪费前期工作。

## 当前存储为什么不能直接共享

当前事实数据分成三部分：

| 数据 | 当前位置 | 当前写入语义 | 直接文件同步的风险 |
| --- | --- | --- | --- |
| Source、Credential、来源关系、模型连接 | SQLCipher `lookingfor.sqlite` | SQLite 事务、WAL、单个本地进程写入 | 同步工具可能分别上传数据库、`-wal`、`-shm`；两台设备写入时不能按行合并，容易丢事务或产生不可打开的组合 |
| Memory | `memories/**/*.md` | 原子文件替换、按路径更新 | 两台设备修改同一路径时通常只保留一份或生成提供方特有的“冲突副本”，应用无法解释其因果关系 |
| Memory Revision | `memory-revisions/revisions.json` | 设备本地递增 `sequence`，整份 JSON 重写 | 不同设备会产生相同序号并互相覆盖，Memory 内容与 Revision 账本可能不一致 |

此外，当前数据库密码只解决一份本地 SQLCipher 文件的解锁。让用户在每台设备输入相同密码并共享数据库文件，并不能解决设备撤销、配对、远端事件认证或同步密钥恢复。

因此，配置页可以允许用户把普通 Markdown 目录放在自己选择的位置，但应用应明确提示：**文件夹同步只适合单写者备份，不是受支持的多设备数据库同步方式。** 数据库目录和 `memory-revisions` 目录不应位于通用同步盘中。

## 目标与非目标

### 目标

- 每台设备离线时可继续读写自己的本地副本；
- 重新联网后重复拉取、乱序到达或进程崩溃都不会重复创建或静默丢失数据；
- 远端存储和传输提供方只能看到最少的同步元数据与密文；
- Source/Credential 引用跨设备后仍然稳定；
- 同一路径 Memory 并发修改时不使用静默的“最后写入者获胜”；
- 用户可以查看同步状态、冲突、最近成功时间和已授权设备，并撤销某台设备；
- 同步协议支持未来替换远端提供方，不让业务 Store 依赖某个云厂商 SDK。

### 第一版非目标

- 多人协作或逐字段权限；
- 实时共同编辑同一份 Markdown；
- 在服务端搜索、解析或执行用户数据；
- 跨用户凭据去重；
- 同步对话中的瞬态 UI 状态、缓存、搜索索引或日志；
- 自动在设备间复制模型 API Key。

模型连接属于设备设置。默认只同步 `provider`、`baseUrl`、`modelId` 这类非秘密偏好，API Key 由每台设备单独配置。用户以后若明确需要同步 API Key，应把它作为 Credential 处理，而不是继续同步 `settings.model.connection` 的整段 JSON。

## 推荐架构

```text
                   不可信同步提供方
              ┌────────────────────────┐
              │ 密文事件 / 密文快照 / 游标 │
              └───────────┬────────────┘
                          │ push / pull
                    SyncTransport
                          │
                  ┌───────▼────────┐
                  │ SyncCoordinator │
                  │ 加密、验签、去重、合并 │
                  └───┬─────────┬──┘
                      │         │
             本地变更事件     远端已验证事件
                      │         │
        ┌─────────────▼─┐     ┌─▼──────────────┐
        │ SQLCipher Store│     │ FileMemoryStore │
        │ + 同步 outbox   │     │ + Revision      │
        └────────────────┘     └─────────────────┘
```

`SyncCoordinator` 是外部 seam。调用方只需要知道：

```ts
interface SyncCoordinator {
  status(): SyncStatus;
  syncNow(): Promise<SyncResult>;
  pause(): void;
}
```

配对、注销和恢复可以放在独立的 `VaultMembership` interface；不要把云端分页、重试、加密 nonce、事件类型和冲突算法暴露给 UI 或 `LocalBackend`。`SyncTransport` 是内部 seam，第一版只需满足上传不可变对象、按游标拉取和读取/写入快照。只有在确实实现第二个远端适配器时，才需要承诺它是长期公共 interface。

一次 `syncNow()` 的固定顺序是：

1. 扫描并封装尚未发布的本地变更；
2. 上传本地密文事件，服务端按 `eventId` 幂等接受；
3. 从本地游标之后拉取密文事件；
4. 在客户端解密、验签、检查设备权限并按依赖排序；
5. 在本地事务或可恢复 Revision 流程中应用；
6. 持久化已应用 `eventId` 和新游标；
7. 再次上传合并生成的事件或冲突标记。

上传优先可避免一台设备在拉取远端变更后，把尚未记录的本地状态误判为远端覆盖。

## 身份与端到端加密

每个同步空间称为一个 **Vault**，具有随机 `vaultId` 和随机生成的 256-bit Vault Data Key。每台设备具有随机 `deviceId` 和自己的签名密钥对。

- 事件正文使用 Vault Data Key 进行带认证加密；每个事件使用唯一 nonce，并把 `vaultId`、`eventId`、协议版本作为 associated data；
- 设备对事件头与密文签名，客户端只接受已加入且未被撤销设备的签名；
- 新设备通过已授权设备展示的 QR/短期配对码加入，配对通道传递被新设备公钥包裹的 Vault Data Key；
- Vault Data Key 在每台设备本地使用独立的设备保护密钥封装。它不等于 SQLCipher 密码，也不直接由相同密码派生；
- 用户应获得一次性的恢复密钥或恢复短语。服务端不能代替用户恢复端到端密钥；
- 撤销设备只阻止其发布和读取后续数据，无法让它忘记已解密的数据。若设备疑似泄露，应轮换 Vault Data Key，后续事件使用新 key epoch。

远端仍可观察 vault/device 标识、事件数量、大小和传输时间。第一版应在隐私说明中如实列出这些元数据，不承诺流量不可分析。

本地 SQLCipher 密码继续保护单台设备落盘数据。不同设备可使用不同本地密码；同步的是解密后重新封装的领域变更，而不是 SQLCipher 页或数据库密码。

## 变更模型

事件使用全局唯一的 `(deviceId, deviceSequence)` 作为 `eventId`，并包含 `createdAt`、`keyEpoch`、`schemaVersion`、父事件/基础版本和加密载荷。设备序号必须在本地持久化后才能发布；服务端只做幂等保存，不能给事件赋予业务上的“最终顺序”。

建议的领域事件如下：

| 领域 | 事件 | 合并规则 |
| --- | --- | --- |
| Source | `source.created` | Source ID 已是随机稳定 ID；同 ID 同内容幂等，不同内容视为完整性错误 |
| Credential | `credential.created` | ID 相同且秘密相同则幂等；ID 相同但秘密不同必须拒绝。不同设备独立保存同一秘密时，第一版允许出现两个 ID |
| 来源关系 | `credential_source.linked` | 集合并集；必须等 Source 和 Credential 都存在后应用 |
| Memory | `memory.revised` | 载荷包含 path、base revision、before/after hash、内容或补丁；按下节规则合并 |
| Memory 删除 | `memory.deleted` | 使用带基础版本的 tombstone，不能把“文件不存在”当成删除事件 |
| Vault 删除 | `vault.wipe_requested` | 独立的高风险操作，需要再次认证和明确确认，不复用当前本地 reset |
| 非秘密偏好 | `preference.changed` | 逐 key 合并；仅允许白名单字段 |

数据库 `reset()` 和 Memory `reset()` 当前是测试/本地清空语义。接入同步后，普通“清除此设备数据”应该先断开 Vault，再删除本地副本；“从所有设备删除”必须生成可同步 tombstone，并给仍离线的旧设备设置重新加入门槛，避免旧数据复活。

所有本地变更必须在产生时进入 outbox：

- Source/Credential/link 的事件与现有行写入同一个 SQLCipher 事务；
- Memory 使用现有 prepared → file replace → applied 恢复流程，并在 Revision 上记录 `eventId`、base revision 与同步状态；
- 应用远端事件时先把 `eventId` 写入 inbox 去重表，再写领域数据；数据库数据在同一事务完成，Memory 则通过可恢复的 prepared Revision 完成；
- 启动和每次同步前执行修复扫描，补发已经成功落盘但未进入 outbox 的变更，并恢复中断的远端 Memory 投影。

这样不需要让远端事件日志取代本地 Store，也不需要跨 SQLite 与文件系统伪造一个无法真正原子的事务。

## Memory 冲突规则

Memory 是唯一允许用户和 Agent 修改的可变共享数据，不能简单套用 Source 的集合并集。

1. 远端 revision 的 base 是本地当前 revision：直接应用。
2. 本地内容尚未变化：直接快进到远端 revision。
3. 两个 revision 有共同祖先且修改不同文本区域：执行确定性的三方合并，保存一个引用两个父 revision 的 merge revision。
4. 同一区域冲突、无共同祖先或删除与编辑并发：不覆盖任一版本，生成 `MemoryConflict`。

冲突界面应展示 base、本地、远端三个版本，让用户选择一方或编辑合并结果。解决后产生新的 `memory.revised` 事件。冲突期间，Agent 默认读取最后一个无冲突版本，并收到“该路径有待解决冲突”的状态；不要把 Git 风格冲突标记直接写进 AI 可读 Memory。

若用户绕过应用直接编辑 Markdown，启动/聚焦/同步前的扫描用“上次投影 hash”和当前内容 hash 判断变化，并为它生成 `external-edit` Revision。文件 mtime 只用于扫描优化，不能作为版本或冲突依据。重命名第一版按旧路径删除 + 新路径创建处理；以后确有保留历史的需求再增加 `memory.renamed`。

## 本地 Schema 增量

不需要改变公开的 SQLCipher 4 文件格式，但需要把 `PRAGMA user_version` 从 1 升级并新增内部同步表。最小集合为：

- `sync_vault`：Vault、key epoch、本设备身份和加密后的本地密钥材料；
- `sync_devices`：授权设备公钥、加入时间、撤销位置；
- `sync_outbox`：待上传领域事件、重试次数和确认状态；
- `sync_inbox`：已应用 `eventId`，用于幂等和崩溃恢复；
- `sync_cursors`：每个 Transport/Vault 的不透明拉取游标；
- `sync_conflicts`：Memory 冲突的父 revision 与解决状态。

密钥私有材料优先放操作系统 Keychain/Credential Manager；数据库只保存引用或经过设备保护密钥封装的密文。远端密文绝不能直接作为“已经安全”而跳过长度、schema、路径、引用和配额校验。

现有 `revisions.json` 在迁移前仍是 Memory Revision 事实来源。引入同步时应给 Revision 增加稳定 UUID 父链和同步元数据；设备本地 `sequence` 仅用于展示/恢复，不能再参与跨设备身份。可以继续使用 `sequence:contentHash` 作为旧客户端的乐观锁 token，但同步协议使用 revision UUID 和内容 hash。

## 快照、历史与配额

不可变事件会持续增长，因此需要客户端生成端到端加密快照。快照包含某个已知事件水位下的 Source/Credential/link 集合、Memory heads、未解决冲突、tombstone 和 schema 版本，并由生成设备签名。

- 新设备先下载最新可验证快照，再拉取水位后的事件；
- 服务端不能自行合并或压缩密文；
- 只有当所有活跃设备确认某水位、并超过用户可恢复窗口后，才允许删除更早事件；
- 长期离线设备超过保留窗口后必须从新快照重新初始化；
- 单事件大小、单次拉取量、Vault 总量和失败重试要有硬限制，防止损坏或恶意设备耗尽磁盘。

同步不是备份：错误删除和损坏也会传播。仍应提供独立、可验证、带恢复演练的加密导出，并允许用户保留多个时间点。

## 分阶段实施

### 阶段 0：明确不安全路径

- 在存储设置旁说明同步文件夹只支持单写者备份；
- 检测常见同步盘路径时给出警告，不强行阻止高级用户；
- 文档明确数据库运行期间不能复制 `lookingfor.sqlite` 单文件作为一致备份。

### 阶段 1：可移植加密包

- 定义带 manifest、schema version、校验和的加密导出格式；
- 导出前 checkpoint/关闭一致的数据库视图，并包含 Markdown 与 Revision；
- 导入到临时目录，完成解密、schema、引用和 hash 校验后再原子切换；
- 默认只允许导入到空 Vault；合并导入留给增量同步阶段；
- 覆盖错误密码、截断、篡改、旧 schema、新 schema、磁盘空间不足和导入中崩溃。

### 阶段 2：单账号、双设备同步 MVP

- 实现设备配对、恢复密钥和设备列表；
- 先同步追加型 Source/Credential/link，再加入单路径 Memory 快进；
- 增加 outbox/inbox、幂等重试、离线恢复、状态页和诊断信息；
- Memory 检测到分叉时先一律进入显式冲突，不急于自动三方合并；
- 不同步模型 API Key，不支持远端 wipe，不做事件 GC。

### 阶段 3：完整冲突与生命周期

- 实现确定性三方合并和冲突解决 UI；
- 实现 tombstone、设备撤销、key epoch 轮换、快照和安全 GC；
- 加入全 Vault 删除、长时间离线设备重新初始化与配额处理；
- 用故障注入覆盖上传成功但本地未确认、应用到一半崩溃、重复/乱序/缺失事件和时钟错误。

## 验收不变量

实现不能只测试“两台在线设备互相看到数据”，至少要持续验证：

- 相同事件应用任意次数，最终本地状态不变；
- 不依赖设备墙上时钟决定谁覆盖谁；
- Source ID、Credential ID 和引用在同步前后保持一致；
- 任意明文、数据库密码、Vault Data Key、模型 API Key 不出现在网络日志、错误报告或服务端对象中；
- 没有有效设备签名、被撤销设备签名、错误 key epoch、未知 schema 或越界 Memory Path 的事件均被拒绝；
- 两台设备并发改同一 Memory 时，至少保留两个版本并产生可见冲突，不静默丢失任一版本；
- 断网、重复上传、乱序拉取、应用中崩溃、磁盘满和进程重启后能够继续同步；
- 同步不可用不会阻止本地保存、搜索、reveal 和 Agent 的受控写入；
- 新设备从快照恢复的结果与从完整事件流重放的结果一致。

## 暂缓决定的问题

以下选择不影响先建立本地事件模型，可以等产品约束更明确后决定：

- 远端是自建 relay、托管对象存储还是用户自带 WebDAV；
- 是否需要账号体系，或只使用持有 Vault 邀请的设备身份；
- 自动同步频率、移动端后台限制和大附件策略；
- 恢复密钥采用助记词、文件还是硬件密钥；
- 是否允许用户选择同步模型 API Key；
- 事件与快照的默认保留期和收费配额。

在这些问题确定前，不应先接入某个云盘 SDK。应先实现并测试本地 `SyncCoordinator`、事件 schema、outbox/inbox、加密包和冲突模型；远端适配器随后只是传输不透明对象，而不是承载 lookingfor 业务语义。
