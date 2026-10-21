#!/bin/bash
# Builds the Safari app that wraps this extension, signs it, and installs it to /Applications.
# Usage: scripts/install.sh            (TEAM_ID=XXXXXXXXXX scripts/install.sh for another signing team)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="Rao DeepSeek Translate"
BUNDLE_ID="com.rao.localhostlingo.safari"
TEAM_ID="${TEAM_ID:-M8K6Q3HMT7}"
BUILD_DIR="$ROOT/.build"
STAGE_DIR="$BUILD_DIR/extension"
PROJECT_DIR="$BUILD_DIR/xcode"
DERIVED_DIR="$BUILD_DIR/derived"
INSTALL_PATH="/Applications/$APP_NAME.app"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

if [ ! -f "$ROOT/config.js" ]; then
    echo "缺少 config.js：先复制 config.example.js 为 config.js，并填入 DEEPSEEK_API_KEY" >&2
    exit 1
fi

echo "› 准备扩展文件"
rm -rf "$BUILD_DIR"
mkdir -p "$STAGE_DIR"
cp "$ROOT"/{manifest.json,background.js,content.js,popup.html,popup.js,config.js} "$STAGE_DIR/"
cp -R "$ROOT/icons" "$STAGE_DIR/"

echo "› 生成 Xcode 工程"
xcrun safari-web-extension-packager "$STAGE_DIR" \
    --project-location "$PROJECT_DIR" \
    --app-name "$APP_NAME" \
    --bundle-identifier "$BUNDLE_ID" \
    --swift \
    --macos-only \
    --copy-resources \
    --no-open \
    --no-prompt >/dev/null

# The packager derives the app id from the app name, but the extension id must start with the app id.
sed -i '' "s/PRODUCT_BUNDLE_IDENTIFIER = \"[^\"]*\";/PRODUCT_BUNDLE_IDENTIFIER = $BUNDLE_ID;/" \
    "$PROJECT_DIR/$APP_NAME/$APP_NAME.xcodeproj/project.pbxproj"

VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/manifest.json")"

echo "› 编译并签名（团队 ${TEAM_ID}，版本 ${VERSION}）"
xcodebuild \
    -project "$PROJECT_DIR/$APP_NAME/$APP_NAME.xcodeproj" \
    -scheme "$APP_NAME" \
    -configuration Release \
    -derivedDataPath "$DERIVED_DIR" \
    DEVELOPMENT_TEAM="$TEAM_ID" \
    CODE_SIGN_STYLE=Automatic \
    MARKETING_VERSION="$VERSION" \
    -allowProvisioningUpdates \
    -quiet \
    build

BUILT_APP="$DERIVED_DIR/Build/Products/Release/$APP_NAME.app"

echo "› 安装到 $INSTALL_PATH"
osascript -e "quit app \"$APP_NAME\"" >/dev/null 2>&1 || true
rm -rf "$INSTALL_PATH"
ditto "$BUILT_APP" "$INSTALL_PATH"

# Forget the build copy so Safari lists the extension only once.
pluginkit -r "$BUILT_APP/Contents/PlugIns/$APP_NAME Extension.appex" >/dev/null 2>&1 || true
"$LSREGISTER" -u "$BUILT_APP" >/dev/null 2>&1 || true
rm -rf "$BUILD_DIR"

"$LSREGISTER" -f "$INSTALL_PATH"
open "$INSTALL_PATH"

echo "✓ 已安装。完全退出 Safari（⌘Q）后重新打开，新版本才会生效。"
