# 项目架构与代码入口

[首页整体架构图](../README.md) · [Windows 本次更新](../windows/docs/WINDOWS-20261018.md)

截至 2026-10-18，AAAAGENT 由桌面陪伴后端、独立角色社交服务和工程工作台组成。Mac 代码位于根目录，Windows 使用独立 `windows/` 源码；两端分别构建、安装依赖、配置凭据和保存运行状态。

## 从输入到回应

桌面文字、按键语音与原有微信私聊进入本机后端。ASR 负责转写，唤醒及图像观察按配置启用。聊天路径组装近期对话、摘要、相关长期记忆、情绪状态和允许共享的社交摘要，再调用所选对话模型。回复送到文字界面、TTS 与角色表现，长期整理异步写入私人记忆。

Windows 可选本地 ASR、TTS 与 Ollama 前台对话；启用某个本地组件不会自动把其他云端组件变为离线。本次 QQ / 桌宠社交整合的真实推理全部使用云端 DeepSeek。

## QQ 与社交经历

Windows 的现有 QQ 机器人独立接收群消息、调用云端回答，也保留自身项目代码索引、联网搜索、天气和表情包能力。这些机器人运行依赖及账号属于现有迁移包，仓库提供社交适配器与 Runtime 接线补丁，未包含完整迁移包或私人账号。

QQ 平台确认回复送达后，适配器把该轮发言、实际回复和回执排入持久队列。独立服务生成经历摘要，保留群、成员、时间及来源。它不会为这条已经发出的回复再生成一条待发 QQ 消息。Mac 的通用社交服务还保留“接收事件 → 生成回复 → 渠道领取 → 真实回执”的接口；新的微信群适配和远程部署仍待验证。

桌宠每 15 秒拉取授权摘要与撤回记录，仅缓存允许共享的内容。缓存五分钟未成功同步时停止提供上下文；推理期间撤回的来源也要重新校验。私人桌宠对话不上传到社交服务。

## 工作执行

工作请求经任务卡和用户确认，交给 T3 Code / Flow 工作台中的 Codex 或 DeepSeek Harness。项目索引、完整执行记录与结果回执保存在工程路径，陪伴上下文按需取引用和状态。原生桌面 App 的完整双向同步及所有设备路径仍以各平台验证文档为准。

## 数据分层

| 数据 | 保存与使用方式 |
| --- | --- |
| 私人记忆 | 本机 `companion.sqlite`：私人对话、长期记忆、情绪与来源。由原记忆系统管理。 |
| 群聊与经历 | 独立服务 `social.sqlite`：群事件、真实回执、摘要、身份和共享策略；摘要模型只读所需群上下文。 |
| 桌宠社交缓存 | 本机 `social-cache.sqlite`：授权摘要、公开人设、游标与撤回状态；只读拉取服务端增量。 |
| QQ 同步队列 | 迁移包 `social-outbox.sqlite`：已送达回复的待同步事件；按事件去重，重启后继续。 |
| 工程记录 | 工作台项目与任务存储：项目索引、执行状态、结果和引用，不常驻全部陪伴上下文。 |
| 凭据与运行状态 | 本机受限文件、平台权限及 `.local/`；不进入源码包。 |

群友经历不会归到桌宠主人名下，公开社交人设不会替换私人角色设定。已在私人聊天中另存的记忆仍由私人遗忘功能管理；源群记录当前没有自动清理期限。调用云端时，相应文本、音频或图像按所选功能发送给配置的供应商。

## 代码与操作入口

| 模块 | macOS | Windows |
| --- | --- | --- |
| 桌面宿主 | [原生窗口及 WebKit](../code/desktop-pet/desktop/) | [Electron 宿主](../windows/code/desktop-pet/desktop/electron/) |
| 本机后端、任务路由 | [app/](../code/desktop-pet/app/) | [app/](../windows/code/desktop-pet/app/) |
| 私人记忆与情绪 | [memory/](../code/desktop-pet/memory/) | [memory/](../windows/code/desktop-pet/memory/) |
| 社交服务与只读缓存 | [companion/cloud/](../code/desktop-pet/companion/cloud/) | [companion/cloud/](../windows/code/desktop-pet/companion/cloud/) |
| QQ 渠道桥接 | 通用渠道协议，未接入 QQ 实际渠道 | [适配器、测试与 Runtime 补丁](../windows/code/desktop-pet/tools/pet-cloud/qq-bridge/) |
| 云端适配器 | [providers/](../code/desktop-pet/providers/) | [providers/](../windows/code/desktop-pet/providers/) |
| 可选本地模型 | 不包含 Windows 本地扩展 | [local-models/](../windows/local-models/) |
| T3 与固定引擎 | [工作台集成](../code/workbench/integration/) | [Windows 集成](../windows/code/workbench/integration/) |
| 网页管理 | [management/](../code/desktop-pet/management/) | [management/](../windows/code/desktop-pet/management/) |
| 社交启停与部署 | [CLI 与部署模板](../code/desktop-pet/tools/pet-cloud/) | [Windows 登录后台任务与 CLI](../windows/code/desktop-pet/tools/pet-cloud/) |

安装见 [Mac 说明](SETUP.md)和 [Windows 说明](../windows/README-WINDOWS.md)；社交协议与边界见 [Mac 社交说明](SOCIAL_MEMORY.md)和 [Windows 社交说明](../windows/docs/SOCIAL_MEMORY.md)。角色媒体、第三方 SDK、模型权重、私人音色及凭据需自行准备并遵守各自许可。
