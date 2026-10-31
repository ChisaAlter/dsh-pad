# 0.4.5 修复与发布验证

2026-10-31。此次发布修复[全面审查](audit-2026-10-31.md)确认的全部 15 项问题，包含原先已在工作区完成的入口恢复、主题、面板 kit/guide/lint 改进；独立 demo 保留在本地，不属于本次发布。

## 修复覆盖

| 范围 | 结果与回归入口 |
| --- | --- |
| 面板消失与布局竞争 | 入口退役后恢复、卡片/坞错误边界；提交按最新面板集合正规化；卸载/隐藏/失捕获时结束手势；[启动](../tests/client-startup.spec.ts)、[手势](../tests/dock-gestures.spec.ts)、[交互](../tests/dock-interaction.spec.ts) |
| 源、缓存与传输 | JSON 最多 64 层/100,000 节点，旧缓存过滤；订阅异常隔离与轮询重排；含凭据请求逐跳拒绝跨 origin；SSE 编码积压总量 8 MiB，按面板合并、30 秒未消费释放；[sources](../tests/sources.spec.ts)、[routes](../tests/routes.spec.ts)、[readings](../tests/readings.spec.ts)、[hub](../tests/hub-concurrency.spec.ts) |
| 持久化与并发编辑 | 事务在最新已提交状态上读改写，rename 成功才发布；异步模型校验后只合并请求字段；[事务](../tests/store-transactions.spec.ts)、[工具](../tests/tools.spec.ts) |
| 后台刷新 | 监听/截止时间在首个 await 前注册，创建与准备可取消；残留资源有界；终态写失败和启动恢复写失败按运行身份重试；排队模型编辑按事务内最新记录安排下次刷新；[agent-refresh](../tests/agent-refresh.spec.ts) |
| 启动与安装 | Cordis 对失败启动回滚资源，支持无重复重试；doctor 处理空格/中文/特殊路径；发行包无源码时沿用产物；[Host 启动](../tests/host-startup.spec.ts)、[doctor](../tests/doctor.spec.ts)、[prepare](../tests/prepare.spec.ts) |
| 更新与运行时 | 完整四文件暂存、校验、持久 journal、跨进程恢复；平台依赖与正文在恢复后执行；旧 feed 不覆盖已应用/待恢复状态；SemVer 预发布数字排序；metric tone 白名单；[入口](../tests/host-entry.spec.ts)、[更新事务](../tests/update-transaction.spec.ts)、[更新服务](../tests/update.spec.ts)、[kit](../tests/ui-kit.spec.ts) |

## 独立复审

更新/加载与持久化/后台刷新分别由未参与实现的审查者复核，并用隔离进程、mock 服务和受控写盘失败验证。复审补出的跨进程 journal 竞争、external 导入提前求值、迟到检查覆盖更新状态，以及终态写失败/排队编辑/失败替代 claim/启动恢复写失败均已修复并补入正式回归。

真实 React DOM 离线复核的 10 个场景全部通过：折叠面板放大后的订阅与释放、七类拖动句柄卸载清理、分栏期间新增卡片保留，以及指针身份/失捕获取消。未使用实际用户数据源或模型。

## 本地最终验证

- Vitest：**36 个测试文件、453 项通过，0 失败**。
- 生产插件与本地 demo 的 TypeScript 检查通过。
- 生产双端构建通过。
- 实际 Host bundle 在真实 Cordis、隔离数据目录与 mock 工具/连接服务下激活成功：6 个路由、9 个工具；卸载后全部清理。
- npm tarball 检查要求四个运行文件及 prepare/doctor 齐全，不包含 demo、开发日志或 node_modules；解包后执行 prepare/doctor，使用隔离的空 profile。
- GitHub CI 在 Node 22 上同时运行 Linux 和 Windows 的安装、类型检查、测试与构建。最终状态以对应 PR / commit 的检查记录为准。

## 升级与边界

原更新器仍只下载 `lib/index.js`、`lib/client.js`、`package.json`、`cordis.patch.yml`；没有新增必须下载的正文文件。正文由构建器嵌入单一 Host 入口，只有恢复和磁盘校验完成后才解析平台依赖。恢复、校验与同步初始化共用内核互斥，Windows 使用 root SHA-256 命名管道，Linux 使用同名抽象 Unix socket，进程退出自动释放；其他系统保留固定 loopback 端口的保守回退，冲突时返回错误。

新事务保护仅覆盖使用 0.4.5 及以后更新器发起的更新；旧更新器首次迁移仍走原流程，建议关闭应用后安装完整版本。目录 fsync 在 Windows 的不可用分支明确降级，文件内容仍 fsync，目标文件使用同目录单次 rename；测试模拟进程退出和替换失败，没有声称实测真实断电持久性。

HTTP 含任意请求体或非公开白名单头时保守禁止跨 origin 重定向；需要时直接配置可信目标网址。SSE 合并可能跳过中间读数，但保留最新状态；单个完整快照超过上限时断开连接。凭据服务解析本身的挂起行为未在本轮扩大处理范围。
