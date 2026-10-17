<div align="center">
  <img src="assets/original-design/whale-avatar.png" width="144" alt="AAAAGENT whale-girl character concept" />
  <h1>AAAAGENT</h1>
  <p><strong><a href="https://www.bilibili.com/video/BV1cueG6sE85/">▶ Watch the full demo on Bilibili</a></strong></p>
  <p>A desktop companion that talks, remembers, and connects your ideas to working agents.</p>
  <p><a href="README.md">简体中文</a> · <strong>English</strong></p>
  <p><a href="docs/PLATFORMS.md#english">Mac / Windows</a> · <a href="docs/SETUP.md">Setup</a> · <a href="docs/MEMORY.md#english">Memory and context</a> · <a href="docs/SOCIAL_MEMORY.en.md">Social roles</a> · <a href="docs/PROMPT_REFERENCES.md#english">Prompt references</a> · <a href="docs/LIVE2D.md#english">Bring your own Live2D</a> · <a href="assets/original-design/README.md#english">Whale-girl artwork</a></p>
</div>

> [!IMPORTANT]
> ## Project architecture
>
> Current architecture · October 18, 2026. Companion dialogue, group activity and work execution connect through explicit context and delivery receipts:
>
> ```mermaid
> flowchart TB
>     subgraph ENTRY["Interaction channels"]
>         PET["Desktop companion<br/>macOS Swift / WebKit · Windows Electron"]
>         WX["WeChat private chat<br/>Text / voice"]
>         QQ["Windows QQ group bot<br/>Existing migration bundle + bridge"]
>         WEB["Web management<br/>Configuration · memory · projects"]
>     end
>
>     subgraph COMPANION["Local companion and work backend"]
>         INPUT["Input processing<br/>Text · ASR · optional wake / vision"]
>         ROUTE{"Chat / work"}
>         CONTEXT["Context assembly<br/>Recent turns · memories · emotions · social sources"]
>         PRIVATE[("Private SQLite<br/>Dialogue · long-term memory · emotions")]
>         ANSWER["Dialogue and response<br/>Text · TTS · character actions"]
>         CONFIRM["Task card · user confirmation"]
>         WORK["T3 Code / Flow workbench<br/>Codex · DeepSeek Harness"]
>         PROJECT[("Project index / work records")]
>     end
>
>     subgraph SOCIAL["Independent social-role service"]
>         RECEIPT["Actual reply + delivery receipt<br/>Durable queue · idempotent deduplication"]
>         SUMMARY["Cloud social summaries<br/>Group · member · time · sources"]
>         GROUP[("Group database<br/>Events · receipts · summaries · sharing policy")]
>         CACHE[("Companion social cache<br/>15-second sync · 5-minute freshness limit")]
>     end
>
>     subgraph SERVICES["Models and retrieval"]
>         CLOUD["Configured cloud models<br/>Dialogue · ASR / TTS · vision · structured memory"]
>         LOCAL["Optional Windows local models<br/>ASR · TTS · Ollama dialogue"]
>         SEARCH["QQ retrieval<br/>Project code index · web search · weather"]
>     end
>
>     PET --> INPUT
>     WX --> INPUT
>     INPUT --> ROUTE
>     ROUTE -->|Chat| CONTEXT
>     PRIVATE --> CONTEXT
>     CACHE -->|Permitted summaries only| CONTEXT
>     CONTEXT --> ANSWER
>     ANSWER --> PET
>     ANSWER --> WX
>     ANSWER -.Background memory maintenance.-> PRIVATE
>     ROUTE -->|Work| CONFIRM
>     CONFIRM --> WORK
>     WORK <--> PROJECT
>     WORK -->|Status and results| PET
>     QQ <--> SEARCH
>     QQ --> CLOUD
>     QQ -->|After confirmed delivery| RECEIPT
>     RECEIPT --> SUMMARY
>     SUMMARY --> GROUP
>     GROUP -->|Sharing / revocation / forgetting updates| CACHE
>     SUMMARY --> CLOUD
>     INPUT -.-> CLOUD
>     INPUT -.-> LOCAL
>     ANSWER --> CLOUD
>     ANSWER -.-> LOCAL
>     WEB -.-> PRIVATE
>     WEB -.-> WORK
> ```
>
> Private dialogue, raw group events, shared summaries and engineering records use separate stores. QQ integration requires the existing Windows bot bundle. Windows local models remain optional; this social-integration validation used cloud models. [Architecture and source map](docs/ARCHITECTURE.md) · [Mac social setup](docs/SOCIAL_MEMORY.en.md) · [Windows integration](windows/docs/SOCIAL_MEMORY.md).

## Windows update · QQ bot and companion memory · 2026-10-18

- Confirmed QQ delivery receipts feed a durable, deduplicated summary queue. Synchronization retries do not send another QQ reply.
- The Windows companion pulls permitted summaries every 15 seconds, preserving group, participant, time and source attribution. Sharing revocation and forgetting propagate; stale caches stop contributing after five minutes.
- Windows login tasks, process recovery and management scripts protect configuration and data with SID-based ACLs and reference existing private model credentials.
- Six real cloud DeepSeek calls passed, with zero local-model calls. QQ delivery used synthetic receipts; real group delivery still needs a natural incoming message.

[Release notes and validation](windows/docs/WINDOWS-20261018.md) · [Setup and operation](windows/docs/SOCIAL_MEMORY.md) · [Windows changelog](windows/CHANGELOG-WINDOWS.md)

---

## Social roles and companion memory · 2026-10-15

The Mac companion can connect to an independent role service and recall permitted group experiences in private dialogue. Private memory, group records and summary caches remain separate, with recovery, sharing revocation and sourced forgetting. Local real-model and cache synchronization checks have passed. Windows now connects the existing QQ bot to the companion cache; see the October 18 update above. New WeChat group adapters and remote deployment remain unverified. [Architecture, setup and memory guide](docs/SOCIAL_MEMORY.en.md).

---

## Mac / Windows development update · 2026-10-11

Mac and Windows **0.3.0-dev.1** now share the October 10 handoff baseline: the newer T3 Code / Flow workbench, Codex / DeepSeek Harness connections, and the new pet. Mac uses Swift / WebKit and the root source tree; Windows uses Electron under `windows/`. Local ASR, TTS and Ollama dialogue extensions are currently available on Windows only.

- Both source trees include video-pet / Live2D switching, the T3 Code workbench, and pinned Codex / DeepSeek Harness connections. The refreshed Mac window, audio devices and engine integration still need validation on a Mac.
- Windows offers three local ASR options (SenseVoice, Paraformer, Whisper) and three TTS options (GPT-SoVITS, Kokoro, Qwen3-TTS), tested sequentially to limit RAM and VRAM pressure.
- Qwen3.5 4B foreground dialogue through Ollama's OpenAI-compatible endpoint. Background memory may still use cloud services. Tests exposed arithmetic and recall errors, plus a known background forgetting-processing failure; this is a development candidate, not a fully offline or stable release.

See [Mac setup](docs/SETUP.md#english), [Mac scope and validation](docs/MACOS-20261010.md), [Windows setup](windows/README-WINDOWS.md), [Windows validation and known issues](windows/docs/WINDOWS-20261010.md), and [local dialogue](windows/docs/LOCAL-LLM.md). Supply model weights, personal voices, character media, SDKs, credentials and runtime data separately. See the [Mac](THIRD_PARTY_NOTICES.md) and [Windows](windows/THIRD_PARTY_NOTICES.md) third-party notices.

Video-pet material comes from **[PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)** (v0.3.6, commit `d422f274e7ca0580dc8e4370fd96ca4d2b4d84b3`). Its code is MIT; animations, prompts and source videos prohibit commercial use and require the original project link in derivative introductions, displays and distributions. AAAAGENT supplies Mac / Windows playback and state integration; the media bundle is not included. The workbench derives from **[T3 Code](https://github.com/pingdotgg/t3code)** with its MIT license and dependency notices preserved. Purchased Live2D assets retain their original terms and are not redistributed.

---

## V2.0 development progress · 2026-10-11

This update brings **a newer [T3 Code](https://github.com/pingdotgg/t3code) workbench, a smoother workflow, local model support, and a new desktop pet**. Task organization, conversation browsing and continuation come together in the workbench. Flow organizes projects as conversation nodes for easier movement between tasks.

Mac now includes the handoff's workbench and Codex / DeepSeek Harness connections. Windows adds local ASR and TTS, and 4B dialogue through Ollama on the same feature baseline. Run models in separate stages to keep RAM and VRAM use manageable.

**[GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) is our first recommendation for local speech synthesis.** For your own voice, start with the [official Chinese installation and fine-tuning guide](https://github.com/RVC-Boss/GPT-SoVITS/blob/main/docs/cn/README.md#微调) and the README's recommended [Bilibili introduction by 花儿不哭](https://www.bilibili.com/video/BV12g4y1m7Uw). Bilibili also offers [training guides and community walkthroughs](https://search.bilibili.com/all?keyword=GPT-SoVITS%20%E8%AE%AD%E7%BB%83%E6%95%99%E7%A8%8B); choose one matching your version.

The new pet uses video animations and expressions from **[PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)**. Thank you to its original author. We provide playback, state switching and platform integration, while the media retains its original attribution and usage terms. Our own DeepSeek whale Live2D is still in production. This is a development candidate; see the [full update](docs/V2_RELEASE_UPDATE.md#english) for validation and known limitations.

![Flow workbench development preview](assets/previews/v2-flow-workbench-original.jpg)

*Development preview: projects are organized as conversation nodes that open into individual conversations.*

---

## Changelog

[View all updates](CHANGELOG.md#english) · Times: UTC+8

| Time | Change |
| --- | --- |
| 2026-10-15 21:40 | Added a separate social-role service and summary sync for the Mac companion, with architecture, memory, setup and deployment guides. |
| 2026-10-11 02:11 | Synced Mac 0.3.0-dev.1 with the October 10 handoff, including T3 / Codex / Harness, video pet support, and public setup and build fixes. |
| 2026-10-11 01:49 | Replaced the V2 delay notice with workbench, pet and local-model progress, plus GPT-SoVITS training references. |
| 2026-10-11 01:40 | Updated Windows setup, validation scope and third-party attribution. |
| 2026-10-11 01:40 | Published separate Windows 0.3.0-dev.1 with three ASR options, three TTS options and Ollama 4B dialogue. |
| 2026-09-21 20:31 | Added API key connection tests on Mac and Windows, running once after saving and showing each credential’s result or provider error. |
| 2026-09-21 18:46 | Fixed rejection of new-format API keys on Mac and Windows, preserving dotted keys through saving, reading and request headers. |
| 2026-09-19 19:58 | Fixed default file-owner checks for elevated Windows processes; Windows and release suites pass on GitHub Actions. |
| 2026-09-19 19:52 | Released Windows 0.1.2 with emotion state and web queries, Windows regressions for chat import, self-service setup and task dispatch, and updated documentation. |
| 2026-09-19 19:15 | Added text and recent-dialogue emotion inference, separate user and companion states, frozen message snapshots and a web view on macOS. |

## Planned development

Local-model scope differs by platform. Mac retains its existing optional local wake-word detector and uses cloud speech and dialogue services:

| Capability | Windows | Mac |
| --- | --- | --- |
| Dialogue | Ollama 4B development validation, with known errors | Cloud |
| Speech recognition | SenseVoice, Paraformer, Whisper | Cloud |
| Speech synthesis | GPT-SoVITS, Kokoro, Qwen3-TTS | Cloud |
| Local audiovisual emotion recognition | Small Qwen-Omni family models, planned | Planned |

---

> [!NOTE]
> **The DeepSeek whale Live2D model is taking longer to make. See the [release update](docs/V2_RELEASE_UPDATE.md#english).**
>
> The model currently used and shown in the demo is a **purchased third-party stock Live2D model** ([search stock Live2D models on Bilibili](https://search.bilibili.com/all?vt=35099468&amp;keyword=live2d%E9%87%8F%E8%B4%A9&amp;search_source=1&amp;from_source=web_recommend_search)). Its original license prohibits redistribution, so its model files, textures, expressions and motions are not included in this project.
>
> You can also choose a free Live2D model whose license permits your intended use and adapt it locally using the [integration guide](docs/LIVE2D.md#english). Please follow each model's usage and redistribution terms.

## Watch the demo

https://github.com/user-attachments/assets/f499c069-4a13-4f79-b705-ce332d7b06f2

**Play the full demo above (about 9m 21s).** This is a 720p web playback version; [watch on Bilibili](https://www.bilibili.com/video/BV1cueG6sE85/) · [download the original-quality 1080p60 video](https://github.com/phoiex/AAAAGENT/releases/tag/demo-video-20260917).

---

> **Noncommercial only · Attribution required.** All commercial use of original project material is prohibited. Credit AAAAGENT, its authors and [the source repository](https://github.com/phoiex/AAAAGENT) when using, citing, reproducing or adapting it. See [LICENSE](LICENSE).

AAAAGENT is a desktop companion developed primarily for macOS, with a separate Windows development version, offering text and voice conversation, a WeChat entry point, and task forwarding. Describe a job, review the proposed task card, and confirm before it is sent to DeepSeek Harness or an existing Codex task. **[▶ Watch the full demo on Bilibili](https://www.bilibili.com/video/BV1cueG6sE85/)**

[Download the final demo in original quality (1080p60, corrected subtitles)](https://github.com/phoiex/AAAAGENT/releases/tag/demo-video-20260917). To meet GitHub's per-file size limit, it is split losslessly into two parts, with no re-encoding or quality reduction.

## Platforms and feedback

**Both platforms are development candidates with separate setup instructions. This Mac refresh still needs native-device validation; Windows measurements and limitations are documented. Please report reproducible problems in this repository's Issues.**

| Platform | Status and entry point |
| --- | --- |
| **macOS** | **0.3.0-dev.1**, synchronized with the October 10 Mac handoff, in root `code/desktop-pet/` and `t3-source/`. See [setup](docs/SETUP.md#english) and [validation scope](docs/MACOS-20261010.md). |
| **Windows** | Separate Electron development candidate **0.3.0-dev.1** in `windows/code/desktop-pet/`; [setup](windows/README-WINDOWS.md) · [validation and limits](windows/docs/WINDOWS-20261010.md) · [credits](windows/THIRD_PARTY_NOTICES.md). |

See [platform differences and issue reporting](docs/PLATFORMS.md#english). Include your OS version, reproduction steps and sanitized errors. Install dependencies separately for each platform; do not mix configuration or build outputs.

Companion conversation and work share an entry point without loading every project's engineering history into personal memory. Recent turns preserve continuity; long-term memories provide relevant recollections; project references locate work-specific context when needed.

**This is a source distribution.** It does not include credentials, private conversations or memory databases, WeChat login state, cloned-voice material, wake-model weights, third-party Live2D characters, or the Cubism SDK. The image above is project-produced fan artwork; Live2D rigging is still in progress.

New: **Memory → Import past chats** imports explicitly selected local history with pause, deduplication and forgetting protection. Review model and cost settings before starting; see the [guide](docs/MEMORY.md#import-past-chats).

## Features

The overview below covers shared features. Both platforms include emotion states, message snapshots and the emotion page; see [Windows memory documentation](windows/docs/MEMORY.md#english) for its usage and data boundaries.

| Capability | What the code provides |
| --- | --- |
| Voice conversation | Push-to-talk, live level feedback, interruption by new input, and separate transcription and dialogue services. |
| Local wake detection | Opt-in keyword detection, wake-word removal, and silence-based recording completion. Compatible local weights must be supplied separately. |
| Emotion-aware responses | Text and recent dialogue inform separate user and companion states, alongside available audio/video observations; message snapshots and sources are visible in the web console. Unknown intensity remains empty. |
| Speech and animation | TTS playback drives lip sync; thinking, work and interaction states feed character presentation. Available motions depend on the model. |
| WeChat | Text and voice input; configurable text or audio-file replies. Native voice bubbles are currently unreliable. |
| Agent forwarding | Harness for appropriate smaller search/organization jobs, Codex for planning and engineering. Explicit executor choices are preserved and dispatch requires confirmation. |
| Web management | Persona prompts, stored memories, recall traces, context settings, speech configuration, presentation presets, and connection status. |

Everyday questions should stay in conversation instead of creating engineering tasks. Task requests can be supplemented, confirmed or cancelled by voice. A normal progress query selects the most recently arranged task; listing everything requires an explicit request.

## Persona prompts and community references

**Prompts for more natural conversation are not yet ready.** The web console supports customizing the persona to suit your conversational preferences.

If you want a different conversational style, personality or emotional response, explore community resources and adjust the prompt under **Memory and conversation → Character Prompt** in the web console, then try it in conversation. Our [references and acknowledgements](docs/PROMPT_REFERENCES.md#english) link to MaiBot, SillyTavern, ChatHaruhi, Hume, Alice_methodology, **[AI-Vtuber](https://github.com/Ikaros-521/AI-Vtuber)** and **[Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber)**. Thank you to their authors and contributors for sharing their work; the guide links to each original source.

## Architecture

The complete architecture appears at the top of this page; see the [source map and data boundaries](docs/ARCHITECTURE.md).

DeepSeek handles text dialogue and structured processing. Dedicated ASR supplies the transcript, Qwen multimodal adapters process images, and the MiniMax adapter generates speech. Users supply service configurations and credentials. The application connects to existing Harness and Codex services rather than bundling another agent platform.

## How memory works

1. **Recent conversation comes first.** Within the input budget, the assembler selects a contiguous suffix of complete turns before adding summaries and relevant long-term memory.
2. **Maintenance runs in the background.** Ordinary memory-processing failures should not block subsequent chat. Forgetting and correction requests have separate privacy safeguards.
3. **Emotion keeps its provenance.** Each message freezes its observation and the separate user/companion states at that time. Recent turns and relevant memories take priority; emotion provides supporting context. See **Memory → Current emotion**. The existing long-term memory formula is unchanged.
4. **Project details are retrieved on demand.** Project names, short abstracts and references stay separate from full task bodies, receipts and execution history.
5. **Users can inspect and edit.** The web interface exposes source records, edits, selected recall parameters, actual recall traces and failed processing items.

See [Memory and context](docs/MEMORY.md#english) for formulas and code references. Current retrieval uses keyword and phrase matching.

## Getting started

**Self-service setup:** after building, run `npm run configure-local` (Windows: `npm.cmd`) to save DeepSeek/Bailian keys, choose adapted models and upload your own reference audio. Enable the relevant Bailian models first: saving a Key does not prove access. Harness and Codex must be installed, launched and authenticated separately; missing executors cannot receive tasks. See [setup](docs/SETUP.md#english).

Mac users should read [Setup](docs/SETUP.md#english); Windows users should start with [Windows setup](windows/README-WINDOWS.md). The commands below target the root Mac source tree. This is a developer-oriented source package. A complete animated desktop setup requires your own authorized Live2D model and SDK.

```sh
cd code/desktop-pet
npm ci
npm run build
```

Compilation does not log in to WeChat, call models or open the microphone. Follow the setup document for runtime configuration, launch steps and missing-resource checks.

| Component | Bring your own |
| --- | --- |
| Text dialogue | Supported provider configuration and credentials |
| ASR / image understanding | Service access and API configuration |
| Speech output | MiniMax configuration and a voice you are authorized to use |
| Live2D | Licensed model, Cubism SDK, parameter mappings and presentation presets |
| Wake detection | Compatible keyword-spotting weights and local settings |
| Work agents | Local Harness / Codex services and the intended projects and tasks |
| WeChat | Your own account login and binding |

## Live2D and character artwork

**Different Cubism Live2D models can be integrated with local adaptation.** Parameter IDs, expression files, motion ranges and physics differ between characters. Replacing an image or copying a single model file is not sufficient. See [Live2D integration](docs/LIVE2D.md#english).

The currently available [DeepSeek whale-girl design resources](assets/original-design/README.md#english) contain static artwork and separated layers; Live2D rigging is still in progress.

## Repository layout

```text
README.md / README.en.md   Chinese and English home pages
code/desktop-pet/          Primary macOS source
windows/                  Windows development version and validation notes
tools/                    Release checks and configuration helpers
docs/                     Setup, memory and model integration
assets/original-design/   Project-produced whale-girl fan artwork
```

## Privacy and current limits

- Conversations, memories, project references and settings are stored locally. Selected cloud services still receive the text, audio or images needed for their calls.
- Publish only this clean release directory. Do not add private runtime directories, databases, credentials, token-bearing links, server configurations or conversation logs.
- Wake detection is opt-in and local; it does not continuously call a cloud recognizer. ASR, dialogue and TTS after wake-up may incur charges.
- macOS is currently the most complete version. Windows 0.1.2 has a [dated local validation report](windows/WINDOWS-VALIDATION.md#2026-09-19-windows-update), separating automated regressions, real-service checks and untested devices. Linux desktop behavior is not validated. Phone delivery, voices and new model animations require device testing.
- Original project material is under the [Noncommercial and Attribution License](LICENSE): **all commercial use is prohibited; use or citation requires credit to the project and authors, with a source link**. Third-party dependencies, SDKs and artwork retain their separate terms; see the [artwork notice](assets/original-design/README.md#english) and third-party notices in the source tree.

When reporting an issue, provide a minimal reproduction without private data. Never attach credentials, a full conversation database or a login QR code to a public issue.

## Citation and credit

Credit the project in applications, demos, videos, articles and papers, and retain copyright notices:

> AAAAGENT — phoiex and project contributors. https://github.com/phoiex/AAAAGENT (include the version or commit and access date)

Use GitHub’s “Cite this repository” entry for citation metadata. Mark modifications and retain the license when redistributing. Credit third-party materials separately.
