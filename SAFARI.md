# Rao oMLX Translate Safari Build

This directory is the Safari WebExtension source for `Rao oMLX Translate`.

## Local service

- oMLX URL: `http://127.0.0.1:9510`
- API key: `raoz`
- Model: `HY-MT1.5-1.8B-8bit`
- Endpoint used by the extension: `/v1/chat/completions`
- Browser translation concurrency: `2`

The extension also checks `/v1/models` to make sure the model is available before enabling translation.

Shortcuts:

- `Option+A`: toggle page translation.
- `Control+A`: translate and replace selected text.

## Generate the Safari Xcode project

This Mac currently has Command Line Tools selected, not the full Xcode developer directory. After installing Xcode, run:

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

Then open the generated Xcode project, run the app target, and enable the extension in Safari Settings > Extensions.
