# Mac / Windows 与问题反馈

[项目首页](../README.md) · [English](#english)

Mac 与 Windows 的 **0.3.0-dev.1 开发候选**均同步到 2026-10-10 产品源码基线，分别保留原生宿主、依赖和运行配置。共同功能包括陪伴与记忆、管理页、微信和 T3 工程连接；平台完成的验证不同，不能用一端的测试结果替代另一端。本次不是稳定性或全部验收通过声明。

2026-10-18 补充：Mac 已有独立角色社交接线；Windows 已接入 QQ 实际回复回执、桌宠摘要缓存及登录后台服务。本次使用云端模型验证，范围见 [Windows 更新公告](../windows/docs/WINDOWS-20261018.md)，整体关系见 [项目架构](ARCHITECTURE.md)。

## 选对源码和安装入口

| 项目 | macOS | Windows |
| --- | --- | --- |
| 源码 | `code/desktop-pet/`、`code/workbench/`、`t3-source/` | `windows/code/desktop-pet/`、`windows/code/workbench/`、`windows/t3-source/` |
| 安装说明 | [Mac 安装与配置](SETUP.md) | [Windows 安装与配置](../windows/README-WINDOWS.md) |
| 桌面宿主 | Swift / AppKit / WebKit | Electron |
| 当前目标 | 固定引擎及唤醒依赖为 Darwin arm64 | Windows x64；ARM64 未验收 |
| 项目执行器 | 固定 Codex 0.160.0 / DSH 0.2.0-rc.2 的 Mac 运行包 | 相同版本的 Windows 运行包 |
| 对话、ASR、TTS | 原有云端供应商配置 | 云端默认；可显式选择本地扩展 |
| 本地模型扩展 | 本次不接入本地 ASR、TTS 或 Ollama 对话 | 三种 ASR、三种 TTS、Ollama 4B 前台候选 |
| 私人配置和数据 | 根目录 `.local/` 与项目外受限凭据 | `windows/.local/` 与项目外受限凭据 |
| 本次证据 | [Mac 同步与验证范围](MACOS-20261010.md) | [Windows 实测与限制](../windows/docs/WINDOWS-20261010.md) |

不要互相覆盖源码目录、`node_modules`、运行包、账号状态或激活指纹。固定引擎的归档、二进制和运行清单必须匹配平台。关闭网页也不等于停止工程后台；任务取消和服务退出要使用对应平台的明确入口。

## 资源与第三方来源

视频桌宠基于 PC2005-cloud 的 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)：代码采用 MIT，动画、提示词和源视频遵循上游非商业条款。T3 工作台基于 [T3 Code](https://github.com/pingdotgg/t3code)。媒体、购买的 Live2D、SDK、模型权重和私人参考音频不随源码分发，角色显示需要自行准备兼容且授权明确的资源。

来源与分发边界见 [根目录第三方声明](../THIRD_PARTY_NOTICES.md) 和 [Windows 第三方声明](../windows/THIRD_PARTY_NOTICES.md)。构建占位只表示缺资源时界面仍可编译，不等于已有角色、模型或音色。

## 验证范围与已知问题

Mac 此次同步在 Windows 主机上整理和检查，可验证共享 TypeScript / JavaScript、浏览器包和受控测试。Swift 编译、AppKit / WebKit 窗口、Mac 权限弹窗、真实设备及本轮原生应用互通没有因此完成验收。10/10 源包记载的 10/9 Mac 实际工程任务是历史证据，单独列于 Mac 验证文档。

Windows 已通过应用适配器分阶段调用三种 ASR 与三种 TTS：9 段合成样音、27 次交叉转写、3 次官方录音识别。仍有识别误差；GPT / Qwen 使用官方权重及合成参考，个人微调音色、实体麦克风 / 扬声器和持续负载未验收。Codex 与 DSH 各完成两轮 T3 同会话文件任务，不能据此宣称所有原生桌面 App 双向同步或桌宠 UI 路径通过。

Windows 本地 4B 对话返回了正确结构和表情，但两次把 `(17 * 23) + 5` 答成 404（应为 396），上下文复述也出现失败。一次完整后端测试把“不需要长期记忆”在前台判为 `none`、后台云端严格记忆判为 `forget`，随后触发 `source_expansion_contains_future_message`。没有放宽来源保护，该轮不能算通过。9B 仅下载和准备，用户已取消，未加载或推理。详见 [本地 LLM 结果](../windows/docs/LOCAL-LLM.md)。

这项后台记忆问题涉及共享处理逻辑，是 Mac 后续验收也需关注的风险；本轮没有在 Mac 复现它。Mac 不带本地模型扩展，也不因此成为离线应用。唤醒词检测与完整 ASR / TTS 是不同能力。

## 怎样反馈问题

在仓库 **Issues → New issue** 中提供：

1. 系统版本、CPU 架构、Node.js 版本与提交号。
2. 使用根目录 Mac 版还是 `windows/` 版，以及实际启动命令。
3. 复现步骤、预期结果、实际结果和脱敏错误日志。
4. 语音问题所处的录音、转写、回复、合成或播放阶段；工程问题对应 Codex、DSH 或 T3 的哪条路径。

请勿上传 Key、登录二维码、账号会话、个人数据库、完整私人对话或无权分发的模型素材。截图和演示中的第三方角色也要保留来源署名。

<a id="english"></a>

## English

Both **0.3.0-dev.1 development candidates** share the October 10 product baseline, with separate platform hosts and runtime installations. macOS uses root `code/` and `t3-source/`, with Swift / AppKit / WebKit and `darwin-arm64` engine pins. Windows uses `windows/`, Electron and Windows x64 pins. Follow [Mac setup](SETUP.md#english) or [Windows setup](../windows/README-WINDOWS.md).

Mac does not include the Windows local ASR, TTS or Ollama integrations. Both retain configured cloud providers. Keep their dependencies, accounts, data and activation fingerprints separate. Supply authorized character assets; private media, SDKs, weights and credentials are excluded. Preserve attribution to PC2005-cloud's [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) and [T3 Code](https://github.com/pingdotgg/t3code); see the [third-party notices](../THIRD_PARTY_NOTICES.md).

The current Mac publication was checked from Windows: shared TS/JS results do not validate Swift, Mac UI, physical devices or native-app synchronization. Historical Mac task evidence is listed separately in the [Mac report](MACOS-20261010.md). Windows speech tests, 4B arithmetic/recall failures, the cloud background-memory rejection and the cancelled 9B trial belong to the [Windows evidence](../windows/docs/WINDOWS-20261010.md). Neither candidate is described as fully accepted or entirely offline.

Report issues with platform, architecture, Node version, commit, startup command, reproduction steps and sanitized logs. Do not attach credentials, account sessions, private databases or non-redistributable assets.
