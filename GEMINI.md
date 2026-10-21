# GEMINI.md - Rao DeepSeek Translate 开发规范

本文件定义这个 Safari WebExtension 的开发约束。

## 1. 核心架构原则
- **模型与鉴权**：翻译走 DeepSeek（`https://api.deepseek.com/v1/chat/completions`），模型 `deepseek-flash`，必须带 `thinking: { type: "disabled" }`。API key 只放在不提交的 `config.js`。
- **请求格式**：系统提示 + 用户消息 `{"target", "items"}`，`response_format` 为 `json_object`，模型返回 `{"translations"}`，条数必须与输入一致；不一致时后台把这一组对半拆开重试。
- **分批与并发**：页面每批最多 12 段 / 2500 字符，同时最多 4 批；后台每个请求最多 20 段 / 4000 字符，同时最多 8 个请求。超时、429、5xx 自动重试 2 次。
- **按段落翻译**：一个块级元素是一个翻译单元。内联元素写成 `<gN>…</gN>`，代码、图标、嵌套块写成 `<xN/>`；译文只回写到原有文本节点，不新建、不移动元素。标签被模型打乱时，这一段退回逐个文本节点翻译。
- **按需翻译**：只翻视口附近（上下 600px）的段落；翻译状态下用 MutationObserver 自动补翻新增或被页面改动的文字。
- **无损还原**：每个被改的文本节点都记录原文和译文；切回原文必须恢复到完全一致的 DOM。双语模式只追加带 `rao-tr-own` 类名的元素，还原时移除。
- **缓存**：译文按「缓存版本 + 模型 + 目标语言 + 原文」存在 `storage.local`。修改提示词时必须提升 `CACHE_VERSION`。
- **翻不了就保留原文**：模型解释「无法翻译」、要上下文等回复一律退回原文，不显示给用户。
- **输入框翻译**：`Control+S` 必须翻译并替换当前聚焦输入框的全文（保留所有换行），优先支持 `input`、`textarea`，其次支持 `contenteditable`。
- **技术内容保护**：GitHub 仓库页的用户名、仓库名、breadcrumbs、文件树、文件和目录名、文件元信息、路径、命令参数、缩写和 CamelCase 标识符必须跳过或占位保护（`__NTA__`），不得送模型自由改写。`code`/`pre`、表单、可编辑区域不翻译。

## 2. 验证
- `npm test`：后台（假的 DeepSeek 接口）和页面脚本（WebKit）测试，不需要 key。
- 改完用 `scripts/install.sh` 安装，退出并重开 Safari 后在真实页面上确认。
