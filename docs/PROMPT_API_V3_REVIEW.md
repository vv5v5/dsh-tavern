# v3 API 候选交付与验收

日期：2026-09-14。候选软件版本：2.3.0。分支：`codex/prompt-composition-api-v3`。状态：实现与本地自动验收完成后供用户审核；没有发布声明。

## 审核入口

1. [新增需求、设计逻辑和完整 API 用法](PROMPT_API_V3.md)，包括边界、错误处理和恢复。
2. [English integration contract](PROMPT_API_V3_en.md)。
3. [可运行插件示例](examples/prompt-composer.mjs)，采用固定 system 段落策略；不自称完整 ST 排序器。
4. 后端入口：`packages/tavern-loader/src/prompt-composition.js`；接入点：loader `index.js`、`profile-loader.js`；Trace 增量：`packages/tavern-trace/src/recorder.js`。
5. 回归测试：`test/prompt-composition.test.mjs`，真实服务测试：`test/prompt-composition-host.test.mjs`；均已纳入 `verify:2.0`。

## 设计结论

建议增加 v3 组合合同，同时改进外部模式的注入颗粒度。只开放绑卡查询能解决发现性，但不能解决双重注入、世界书的本轮激活、预设 replace 与其他插件的冲突。

默认内置策略保持兼容；外部模式按 session 单独启用，独占 Tavern 资源组合，返回命名 system sections。DSH durable history、工具策略、RP 锁和一次性导入上下文保持现有所有权。原始数据留在本机库中，HTTP 只提供受既有安全层保护的快照；运行时不用浏览器或外部 HTTP 回调。

会话偏好持久化，注册函数随插件生命周期存在。缺失或失败时明确报错；不静默 fallback。mode revision 做 CAS，sources revision 做内容刷新，二者职责不同。fork/swipe/new-session 的资源绑定可沿用既有机制，外部 owner 必须对新会话单独启用；配置模板不偷偷携带第三方执行依赖。

## 自动验收证据

验证使用自造角色卡、用户、世界书和临时目录，未操作真实 DSH profile 或真实用户会话。

- Node 22.23.1。
- 全量测试（启用真实 0.1.5 codec 与 prompt 服务测试）：559 项，557 通过、0 失败、2 跳过。跳过的是用户私有验收卡 fixture 和正在运行的 Host chrome/workspace 只读 smoke；本次未提供这些环境。
- `npm run verify:2.0`：通过分组验收、构建与 npm pack dry-run；真实服务测试已启用。
- DSH `0.1.2-rc.1` / `0.1.5-rc.1` 已安装的真实 `systemPrompt` + Cordis 服务：两版本均通过命名外部段落、宿主 persona 保留、缺失组合器拒绝、显式恢复与卸载服务清理。真实服务测试使用临时 Tavern 数据，未连接真实模型。
- 上述两个版本的公共 section/assemble/ctx.provide 接缝均检查实际已安装版本源码；没有使用浮动 upstream master 推断支持。
- 字段保真、Unicode 计数、未知扩展、禁用字段、多来源世界书去重、匹配候选、首轮开场判断、同次 assembly 缓存、采样一致性、持久化/重启、CAS、运行中切换、异步/错误/非法输出、大小限制、订阅释放、HTTP 安全层和示例代码都有定向测试。
- Trace 验证 owner/sourceRevision/段名保存且不保存外部输出正文。外部模式下 import-context 的 claim/consume 保留，以及真实 loader HTTP prefix 路由也有回归测试。
- 发布包 dry-run：196 个文件，约 5.6 MB；包含 v3 后端、中英文合同、验收记录和可运行示例。新增文档的相对链接与 `git diff --check` 通过。已生成本地 2.3.0 候选 tarball，未上传。

可复验命令（`<runtime>` 为相应版本现有 dependency 环境）：

```sh
node --test test/prompt-composition.test.mjs
DSH_TAVERN_PROMPT_COMPAT_ROOT=<runtime> node --test test/prompt-composition-host.test.mjs
# 同时启用原有 0.1.5 codec 集成测试：
DSH_TAVERN_COMPAT_ROOT=<0.1.5-runtime> DSH_TAVERN_PROMPT_COMPAT_ROOT=<0.1.5-runtime> npm test
DSH_TAVERN_COMPAT_ROOT=<0.1.5-runtime> DSH_TAVERN_PROMPT_COMPAT_ROOT=<0.1.5-runtime> npm run verify:2.0
```

## 代码自审

已检查来源拷贝与存储边界、HTTP 路由/安全层、组装缓存及 request 参数一致性、外部模式持久化/CAS、Cordis 生命周期和 Trace 内容最小化。当前没有未修复的已知实现缺陷。采用单 agent 自审，未声称独立第三方审查；下列运行环境与对方插件联调缺口仍然保留。

## 明天需要人工验收

这些事项没有被 fixture 或真实服务级测试替代。建议使用有备份的测试 profile 与虚构会话：

| 步骤 | 预期结果 |
| --- | --- |
| 在目标 DSH Host 安装候选包及对方的提示词管理插件 | v1/v2 UI 可用，GET v3 capabilities 能发现其 owner |
| 绑定含中文/emoji、多开场、系统字段、深度字段和内嵌书的卡，读取 sources | 对方 UI 能直接显示卡 ID、原文、开场序号与各字段字数，不解析大字符串 |
| external 未开启时发送 | 仍是原内置注入策略，无外部段落 |
| 显式开启后发送含世界书触发词的首条消息 | 真实模型请求只有对方提交的 Tavern 资源段；其前端能显示来源；本轮 lore 和开场适用性正确 |
| 完成首条回复，再发送第二条 | 不应再作为首轮开场参考；真实 DSH 历史正常重放 |
| 运行中尝试切换外部模式、回合结束后切卡/切预设 | 前者 409；后者下一轮拿到新字段，无旧快照混用 |
| 同时打开两个管理面板，交错写 mode | 旧 revision 被拒绝，没有悄悄覆盖 owner |
| 卸载/重载组合器，重启 Host；分别恢复插件和显式切 builtin | 偏好保留；缺失时明确失败；恢复后可继续；没有重复注入 |
| 使用 fork/swipe 创建子会话 | 资源复制继续工作，外部接管需对子会话明确启用 |
| 有 import-context 的空会话发送首轮 | 导入上下文仍只由原有 claim/consume 机制负责，不因外部模式丢失或重复；来源快照不暴露导入正文 |
| RP 开启时测试已有权限提示和工具策略 | 模式切换不会移除 RP policy、放开工具权限或更改 sandbox |
| Host 使用 complete system section 或对方也改 assembly waterfall | 以实际请求检查顺序及可见性；若被宿主覆盖，需要修正宿主/对方配置，v3 不仲裁这些全局覆盖 |
| 卸载 Tavern | 原生 DSH、原始会话仍可使用；持久化资源未被此 API 改写 |

对方实际插件未提供源码或可运行包，所以对方页面布局、其完整 ST marker/宏策略以及真实 provider 请求仍需上述联调。新模式入口本次以 HTTP/后端 API 交付，没有新增内置 UI 按钮。

## 发布与回滚

候选包为 2.3.0，原因是新增稳定公共能力，兼容旧接口；不是一次要求应用升到 3.0.0 的破坏性修改。用户已授权将实现、文档与测试提交并推送到候选分支，暂不合并。最终人工验收、合并、tag 和发布仍待后续明确授权。

使用 external 的会话在移除接管插件前可 PUT builtin。回滚到不认识 v3 的旧 Tavern 时，旧版会忽略新增偏好文件并按内置策略运行；不要把它当作保持外部接管语义的透明回滚。偏好文件仅含标识，可备份保留。原始角色卡、预设、DSH 日志无需数据迁移。
