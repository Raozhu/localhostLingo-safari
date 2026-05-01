# GEMINI.md - LocalhostLingo Safari/oMLX 开发规范

本文件定义这个 Safari WebExtension 版本的开发约束。

## 1. 核心架构原则
- **本地优先 (Local-First)**：所有 AI 功能必须通过本机 oMLX 服务实现，默认地址为 `http://127.0.0.1:9510`。
- **固定模型与鉴权**：翻译模型固定为 `HY-MT1.5-1.8B-8bit`，请求头使用 `Authorization: Bearer raoz`。
- **性能与并发**：
    - 文本处理必须维持分批逻辑（10 项/500 字符），严禁一次性向模型发送超大全文。
    - 浏览器和后台 oMLX 请求并发数上限保持为 2；本机测试显示这比高并发有更好的可感知延迟。
- **无损还原**：任何翻译逻辑必须确保能够通过 `__translatedNodesMap` 还原原文，不得破坏 DOM 结构。
- **选区翻译**：`Option+S` 必须翻译并替换当前选中文本，优先支持 `input`、`textarea`，其次支持页面普通选区和 `contenteditable`。

## 2. oMLX Prompt 规范

每条文本必须用 HY-MT1.5 模型要求的纯文本 completion 格式。

源语言是中文时使用中文指令：

```text
将以下文本翻译为<target language>，注意只需要输出翻译后的结果，不要额外解释：

<source_text>
```

其他源语言使用英文指令：

```text
Translate the following segment into <target language>, without additional explanation.

<source_text>
```

`sourceLang=auto` 时，必须在 content script 中先检测出具体语言名，再发送给后台；后台不得向模型发送 `auto`。

## 3. 代码实现规范
- **接口形态**：使用 `/v1/chat/completions`，因为 HY-MT 依赖 chat template；不要回退到 raw `/v1/completions`。
- **并发翻译**：后台必须通过全局队列限制最多 2 个 oMLX 请求同时运行；重复文本仍需去重后复用结果。
- **DOM 过滤逻辑**：必须严格排除 `pre`, `code`, `script`、`.notranslate`、`[translate="no"]` 等区域。
- **语言互转**：选区翻译时，如果选中文本已经是当前目标语言，则翻译回当前源语言；当源语言为 `auto` 且目标为中文时，英文转中文、中文转英文。
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
