# Rao DeepSeek Translate

Safari WebExtension source for translating web pages through the DeepSeek API.

## Service

- URL: `https://api.deepseek.com`
- Model: `deepseek-flash` (thinking disabled)
- API: OpenAI-compatible `/v1/chat/completions`
- API key: copy `config.example.js` to `config.js` (git-ignored) and fill in `DEEPSEEK_API_KEY`
- Browser translation concurrency: `8`

## Test Page

Open `translation-quality-test.html` in Safari, enable the temporary extension, and run page translation from the toolbar popup.

## Translation Guards

- GitHub repository chrome, breadcrumbs, file metadata, file trees, standalone filenames, repository paths, usernames, code flags, acronyms, and CamelCase identifiers are skipped or protected before model calls.

## Shortcuts

- `Option+A`: toggle the current page between translated text and original text.
- `Control+S`: translate and replace the full text in the currently focused input field. If the text is already in the configured target language, the extension translates it back to the configured source language. With source set to Auto and target set to Chinese, English text becomes Chinese and Chinese text becomes English.

## Safari Packaging

See `SAFARI.md` for generating the Safari Web Extension Xcode project after full Xcode is installed.
