# Rao DeepSeek Translate Safari Build

This directory is the Safari WebExtension source. The Xcode project is generated on demand and is not checked in.

## Install

```sh
cp config.example.js config.js   # then fill in DEEPSEEK_API_KEY
scripts/install.sh
```

The script:

1. copies only the extension files (manifest, scripts, popup, icons, `config.js`) into `.build/extension`;
2. runs `xcrun safari-web-extension-packager` to generate a macOS Swift app project;
3. fixes the app bundle id to `com.rao.localhostlingo.safari` (the extension id `com.rao.localhostlingo.safari.Extension` must start with it);
4. builds Release with automatic signing for team `M8K6Q3HMT7` (override with `TEAM_ID=...`) and the version from `manifest.json`;
5. replaces `/Applications/Rao DeepSeek Translate.app`, unregisters and deletes the build copy so Safari lists the extension only once, and opens the app.

After installing, quit Safari (⌘Q) and reopen it so the new version loads. The first time, enable the extension in Safari Settings > Extensions.

Note: `config.js` is bundled into the app, so the installed app contains the API key. Do not share the app.
