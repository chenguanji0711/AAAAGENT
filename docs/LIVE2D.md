# 接入自己的 Live2D / Bring your own Live2D

[项目首页](../README.md) · [English](#english)

## 支持范围

项目通过 Cubism Web 渲染管线接入 **Cubism 的 `.model3.json` / `.moc3` 模型**。支持在本地适配不同角色。具体兼容性取决于模型导出版本、你安装的 Cubism SDK、纹理规格以及本地适配结果。

接入模型需要配置参数和资源路径。Cubism 2 `.model.json` / `.moc` 及模型包热切换暂不支持。

**仓库不包含现用第三方 Live2D 模型。** 不附其网格、纹理、物理、表情、动作、可编辑工程、截图或录屏。也不附 Cubism SDK；请从 [Live2D 官方下载页](https://www.live2d.com/en/sdk/download/web/) 获取并遵守其条款。

## 本地接入步骤

| 步骤 | 需要做的事 |
| --- | --- |
| 1. 准备资源 | 取得允许你使用的模型包；保持 `.model3.json` 引用的目录和文件名正确。不要把个人下载的模型加入公开仓库。 |
| 2. 准备 SDK | 按 [安装说明](SETUP.md) 配置 Cubism Framework、Core 与 WebGL shaders。模型和 SDK 分别遵守各自授权。 |
| 3. 设置加载路径 | 自备资源放在 `desktop/assets/local-model/`，入口为 `pet.model3.json`；其他位置需同时适配 `assetBase` 和静态资源服务。 |
| 4. 映射参数 | 对照实际模型的参数 ID 和取值范围，接入眼睛、嘴、头部、身体和视线。移除模型没有的参数引用。 |
| 5. 建立预设 | 为这个模型重新编写表现目录，关联它自己的 expression / motion；启用哪些自动表情由管理设置控制。 |
| 6. 对齐资源版本 | 模型、预设和后端登记必须对应；按源码的指纹逻辑更新绑定，不能关闭校验来掩盖错误。 |
| 7. 本地验收 | 构建前端，先检查静态中性姿态，再检查口型、眨眼、转头、动作叠加和回中。 |

从 `code/desktop-pet/` 运行 `node tools/configure-model.mjs` 可依据已经放入的真实模型文件生成禁用的预设目录及资源指纹；它拒绝覆盖已有目录。之后仍需自行填写模型映射、预设并验证。

请根据占位配置的结构填写自己的模型资源与预设。

## 本机导入流程（用户自备模型）

把有权使用的模型放进 `code/desktop-pet/desktop/assets/local-model/`，入口命名为 `pet.model3.json`，然后：

```bash
cd code/desktop-pet
node tools/configure-model.mjs                 # 在现有目录上生成禁用目录
node tools/configure-model.mjs --id my-rig     # 指定 modelId（默认 local-model）
node tools/configure-model.mjs --replace       # 已有 presets.json 时先留带时间戳的备份
```

规则：

- **必需**：`Moc` 与 `Textures`（没有它们模型无法渲染，工具会直接拒绝并说明原因）。
- **可选**：`Physics`、`Pose`、`DisplayInfo`、`UserData`、`Expressions`、`Motions` 全部按缺省处理；
  缺某一节是合法模型，不是坏模型。渲染器、管理端与导入工具共用 `desktop/model-references.mjs`
  的同一套读取规则，`presets.json` 的字节指纹在三处必须一致，否则目录会被判为过期。
- **不越权**：只写 `presets.json`，不下载、不复制、不修改、不去水印；不触碰 `assets/local-model/dsh-pet/` 视频素材；
  每个引用路径都做相对路径校验并 realpath 限制在模型目录内；已存在的目录默认不覆盖。
- **保守目录**：工具只声明 manifest 证明确实存在的东西。表情与动作一律生成为 `manual`（禁用），
  **不会**自动占用六个语义情绪槽；`neutral` 保持无表情待机。看完实际表现后，再手动把验证过的条目
  提升为 `automatic` 并填 `emotions`。

`tools/configure-model.mjs` 的容错与拒绝行为有 `desktop/tests/model-import.test.mjs` 覆盖；真实 rig 的加载、
口型、表情回落、挂起与指纹拒绝由 `desktop/tests/run-haru-rig.mjs` 覆盖。

## 验收现状

- Haru（官方示例模型，仅用于兼容测试，**不是**最终角色）：真实 rig 5/5、切换生命周期 2/2。
- 真实透明窗口实测：`model-loaded {runtime:"Cubism5-r.5", drawables:84, parameters:42, textures:2}`、
  `renderer-selected {rendererKind:"live2d"}`、目录指纹校验通过后 `presentation-policy {applied:true, enabledCount:11}`，
  画面里模型以透明背景正确显示。
- **最终皮套仍待用户提供**；在它到位之前视频角色是正式角色，Live2D 只用于验证接入能力。

## 为什么不只是换文件

旧角色可能使用自定义头部参数，另一角色则使用 `ParamAngleX`、`ParamAngleY`、`ParamAngleZ`。发布包把头部与嘴形名称集中在 `desktop/config/parameter-map.json`；嘴型、表情开关和动作曲线仍需逐项核对。新模型缺少某个参数时，应调整映射与动作范围。

本项目源码中的渲染适配器仍保留部分历史命名和模型假设。接入新角色时，重点核对：

- `FileReferences` 中的 Moc、Textures、Physics、Expressions 和 Motions；当前管线对物理和 Idle 动作有约定，缺失时需要适配加载代码。
- 口型对应的开口参数、默认闭口值和播放结束归零行为。
- 头部/身体/眼球参数的名称、最大幅度与每帧叠加顺序。
- 预设目录的模型 ID、版本指纹、expression 名称及可自动启用的项目。
- 特定角色专用的外观开关。不要把旧角色的隐藏部件或水印控制照搬到新模型。
- 画布裁切、全身/半身构图、透明混合与纹理尺寸。

至少检查：连续说话后正确闭口、按键打断立即停止口型、思考/工作状态结束回到中性、不同表情不互相残留、缺失参数时给出明确提示。每个新模型都需要检查这些项目。

## DeepSeek 大肥鱼设计稿

[项目设计稿目录](../assets/original-design/README.md) 包含静态整稿、透明立绘、头像与基础分层 PSD。可用于后续 Live2D 制作。

仍需补齐遮挡区域、制作网格和变形器、绑定参数、导出运行模型并检查连续动作。

## 代码入口

- [`desktop/cubism-renderer.mjs`](../code/desktop-pet/desktop/cubism-renderer.mjs)：资源读取、模型绑定、参数与口型。
- [`desktop/interaction-motion.mjs`](../code/desktop-pet/desktop/interaction-motion.mjs)：交互动作与平滑过渡。
- [`contracts/presentation.ts`](../code/desktop-pet/contracts/presentation.ts)：表现意图和统一语义。
- [`desktop/presentation-preview.mjs`](../code/desktop-pet/desktop/presentation-preview.mjs)：预设预览。

<a id="english"></a>

## English

The renderer integrates **Cubism `.model3.json` / `.moc3` models**. Different characters can be adapted locally, subject to export-version compatibility, the installed SDK, texture requirements and parameter mappings. Each model requires local configuration. Cubism 2 exports and model-package hot switching are currently unsupported.

The existing third-party character and all its textures, expressions, motions, editable files, screenshots and recordings are excluded. The Cubism SDK is also excluded; obtain it from the [official download page](https://www.live2d.com/en/sdk/download/web/) under its own terms.

1. Obtain an authorized model package and preserve all referenced paths locally.
2. Install the Framework, Core and WebGL shaders following [Setup](SETUP.md).
3. Adapt `assetBase`, the entry model file and static-resource serving.
4. Map the model's actual eye, mouth, head, body and gaze parameters and ranges.
5. Create a model-specific presentation catalog using that model's expressions and motions.
6. Keep model identity/fingerprint and backend registration consistent; do not bypass validation.
7. Build and validate neutral state, lip sync, blinking, head motion, transitions, interruption and return to idle.

With your actual model under `desktop/assets/local-model/` and its entry named `pet.model3.json`, run `node tools/configure-model.mjs` from `code/desktop-pet/` to create a disabled catalog with its resource fingerprint. Existing catalogs are preserved. Local mapping and preset work is still required.

Some historical model assumptions remain in the adapter. In particular, inspect required physics and Idle motion files, custom parameter names, appearance switches, framing and texture sizes. Do not copy character-specific visibility or watermark controls into another model. Check each newly integrated character.

The [DeepSeek whale-girl artwork](../assets/original-design/README.md#english) is a concept and layer-preparation package. Occlusion completion, meshes, deformers, parameter rigging, export and continuous-motion checks remain necessary. The code links above identify the adaptation points.
