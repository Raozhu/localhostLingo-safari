# GEMINI.md - LocalhostLingo Safari/oMLX 开发规范

本文件定义这个 Safari WebExtension 版本的开发约束。

## 1. 核心架构原则
- **本地优先 (Local-First)**：所有 AI 功能必须通过本机 oMLX 服务实现，默认地址为 `http://127.0.0.1:9510`。
- **固定模型与鉴权**：翻译模型固定为 `MiLMMT-mlx-8bit`，请求头使用 `Authorization: Bearer raoz`。
- **性能与并发**：
    - 文本处理必须维持分批逻辑（10 项/500 字符），严禁一次性向模型发送超大全文。
    - 浏览器并发请求数上限保持为 3，避免本地模型响应堆积导致页面卡顿。
- **无损还原**：任何翻译逻辑必须确保能够通过 `__translatedNodesMap` 还原原文，不得破坏 DOM 结构。

## 2. oMLX Prompt 规范

每条文本必须用 oMLX 翻译模型要求的纯文本 completion 格式：

```text
Translate this from <source language name> to <target language name>:
<source language name>: <source language sentence>
<target language name>:
```

`sourceLang=auto` 时，必须在 content script 中先检测出具体语言名，再发送给后台；后台不得向模型发送 `auto`。

## 3. 代码实现规范
- **接口形态**：使用 `/v1/completions`，不要使用 `/v1/chat/completions`，因为 `MiLMMT-mlx-8bit` 当前没有 chat template。
- **批量翻译**：使用 prompt array 批量请求，并按 `choices[].index` 还原顺序。
- **DOM 过滤逻辑**：必须严格排除 `pre`, `code`, `script`、`.notranslate`、`[translate="no"]` 等区域。
- **原生技术栈**：保持使用原生 JavaScript 和 Vanilla CSS，不引入大型库或框架。
- **跨浏览器 API**：保留轻量 `browser.*` / `chrome.*` 兼容包装，方便 Safari 和调试环境共用源码。

## 4. Safari 打包
- 源码目录：`/Users/rao/Desktop/localhostLingo-safari-src`
- 目标 Xcode 项目目录：`/Users/rao/Desktop/localhostLingoSafari`
- App 名称：`Rao oMLX Translate`
- Bundle ID：`com.rao.localhostlingo.safari`

完整 Xcode 安装后执行：

```sh
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
xcrun safari-web-extension-packager /Users/rao/Desktop/localhostLingo-safari-src \
  --project-location /Users/rao/Desktop/localhostLingoSafari \
  --app-name "Rao oMLX Translate" \
  --bundle-identifier com.rao.localhostlingo.safari \
  --swift \
  --macos-only \
  --copy-resources \
  --no-open \
  --no-prompt
```
