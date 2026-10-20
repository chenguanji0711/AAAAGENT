# macOS 桌宠源码交付 · 2026-10-20

本分支基于 [phoiex/AAAAGENT](https://github.com/phoiex/AAAAGENT) 的 `d8ff52d90485c7c79b3e2b314e8fd6ec81e5c584`，保留原作者、贡献者署名及所有第三方声明。不是原作者官方发布，不包含上游此提交之后的所有更改。Windows 子目录保留上游版本，本次修改主要针对 macOS。

## 已加入的行为

- Swift/AppKit 透明窗口 + WKWebView + 可选官方 Cubism SDK for Web 渲染；真实模型参数、表情和物理接线。
- 待机/呼吸/眨眼/注视/交互状态，帧率与动作设置，音频分析和口型平滑。模型缺少的参数不会凭空生成。
- 聊天栏、快捷输入框默认常驻，各自独立隐藏/恢复；流式文本更新与屏幕边缘布局。
- 独立目标锚点：输入框高度往返、临时缩放取消和收起恢复不再累积改变人物位置；保留人物/小球拖动。
- 后端启动失败按阶段和白名单原因输出脱敏诊断；运行时登记第二次写入失败时尝试恢复旧配置。
- 模型引用与路径校验、可选动作台词清单和本地生成工具。

## 许可证和未附带资源

根目录 [LICENSE](../LICENSE) 是上游的**非商业使用及署名许可**，不是 MIT、Apache 或 OSI 批准的开源许可。本分支属于按原许可公开的修改源码，不重新许可上游内容。

不提供第三方模型、纹理、动作、表情、可编辑模型工程、Cubism SDK、原始参考视频、生成语音、账号配置、凭据、聊天或运行日志。不提供包含上述资源的 `.app` / DMG。仓库原有设计稿及第三方源码继续遵守各自声明。详见 [THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES.md)。

没有自备 SDK / 模型时，公开源码仍可构建桌面壳，但不会显示本机使用的蓝发少女。需要按 [SETUP](SETUP.md) 与 [LIVE2D](LIVE2D.md) 安装有权使用的资源，重新构建并完成自己的首次配置。不要把 SDK 或模型资源提交到 Git。

## 构建

要求 Apple Silicon macOS、Xcode Command Line Tools、Node.js 24（锁文件固定依赖）、npm。

```sh
git clone --branch macos-live2d-20261020 https://github.com/chenguanji0711/AAAAGENT.git
cd AAAAGENT/code/desktop-pet
npm ci
npm run check
npm test
npm run build:desktop
npm run build:native
```

需要可选的唤醒依赖打包时执行 `npm run build:wake`；完整本机构建入口为 `npm run build:macos`。使用配置向导准备自己的供应商与凭据，再按 SETUP 启动。不要复用作者的本机激活或路径。

```sh
node --test --test-concurrency=2 tests/desktop/native-anchor-stability.test.mjs tests/desktop/native-display.test.mjs desktop/tests/chat-hud-layout.test.mjs desktop/tests/pet-drag-release.test.mjs
node --test --test-concurrency=2 tools/tests/reregister-runtime.test.mjs
```

运行需要 SDK/模型的测试时，请按各测试说明准备本地资源；公开仓库不会为运行测试自动购买资源或调用付费模型。

## 验证范围与限制

本机交付阶段曾通过：11 项原生/布局/拖动测试、8 个生产浏览器场景（24 组边缘变体）、646 项默认回归。WKWebView 实机检查了多行输入与清空、收起/展开，模型和后端就绪。DSH 独立静态复审未发现位置修复的阻断问题。

发布副本的干净构建与回归结果见 [发布验证](PUBLICATION-VALIDATION.md)。历史本机带模型验证不能替代他人在自己的模型/SDK和设备上的验证。

默认位置接近右下角；不保证精确跟随系统废纸篓。跨重启位置持久化、多显示器插拔、完整透明区域穿透、音素多嘴型和长期性能不属于此次已验收保证。配置回滚处理报告出的 I/O 错误，不保证断电时的两文件原子提交。
