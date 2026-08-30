# Pr-Subtitle-FunASR

Premiere Pro 本地字幕识别插件。批量读取序列 → 本地语音识别 → 自动回写字幕轨。**全程离线，数据不出本机，无需联网。**

## 核心特性

- **中文：FunASR（paraformer + fsmn-vad + ct-punc）** —— 断句细、抗背景音乐强、短剧级准确度、输出无标点
- **英文：whisper large-v3** —— 可选 GPU 加速（CUDA），自动检测显卡，检测失败降级 CPU
- **批量识别**：序列多选，先混音后一次加载模型批量识别（模型只加载一次，省去 N-1 次重复加载）
- **自动回写**：识别结果直接回写到 PR 字幕轨（`createCaptionTrack`）
- **标点切句**：中文基于逐字符时间戳 + Unicode 标点断句，字符对齐精确

## 架构

```
CEP 面板 (index.html + main.js)
   ├── 中文 → py/funasr_cli.py（Python 子进程，FunASR 完整链路）
   ├── 英文 → bin/whisper/cuda/whisper-cli.exe（CUDA 版，自动降级 CPU 版）
   └── 回写 → jsx/host.jsx（ExtendScript 桥接 PR）
```

- 中文引擎：`AutoModel(ASR=seaco_paraformer, VAD=fsmn-vad, PUNC=ct-punc)`，`sentence_timestamp` 逐字符时间戳
- 便携 Python：分发版自带 `runtime/`（Python 3.10 + funasr + torch），对方无需装 Python

## 目录结构

```
com.zhang.whisper-subtitle/
├── CSXS/manifest.xml    插件清单（Host PPRO 12.0）
├── index.html           面板 UI
├── js/main.js           识别主逻辑（批量/语言分流/GPU 检测/进度）
├── js/CSInterface.js    前端运行时
├── jsx/host.jsx         读序列/片段、回写字幕轨
├── py/funasr_cli.py     中文识别 CLI（FunASR）
├── bin/                 大文件（ffmpeg / whisper / 模型，走网盘）
├── models/              模型文件（走网盘）
└── runtime/             便携 Python 运行时（走网盘）
```

## 模型与大文件下载

`bin/`、`models/`、`runtime/` 包含大文件（模型、FFmpeg、whisper 二进制、便携 Python），**未纳入本仓库**（GitHub 单文件 100MB 限制），请从百度网盘下载：

> **百度网盘链接**：（待补充）
> 提取码：（待补充）

下载后按上方目录结构放置，即可运行。

## 依赖

**无需 Python**：分发版自带便携 Python 运行时（`runtime/`），含 funasr 1.4.1 + modelscope + torch 2.13.0+cpu。

若自行搭建开发环境：

```bash
pip install funasr==1.4.1 modelscope torch
```

## 使用

1. 打开 Premiere Pro 2025（PPRO 12.0）
2. 菜单：窗口 → 扩展 → 本地字幕
3. 刷新序列列表 → 勾选序列 → 选语言 → 批量识别 → 回写

## 模型清单

| 用途 | 模型 | 大小 |
|------|------|------|
| 中文识别 | seaco_paraformer + fsmn-vad + ct-punc | ~1.2GB |
| 英文识别 | whisper large-v3 q5_0 | ~1.0GB |

## License

MIT
