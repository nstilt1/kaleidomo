# Build
export APPLE_SIGNING_IDENTITY=5CF51755590FF0D10D003787634667ACF96D9691
export APPLE_ID="somedooby@gmail.com"
export APPLE_PASSWORD=$(security find-generic-password -a "$USER" -s "notaryPassword" -w)
export APPLE_TEAM_ID="WK272386LM"

bun run tauri:build -- --target universal-apple-darwin

#bun run tauri build -- --target universal-apple-darwin --no-sign

# Sign app with credentials from running:
# `security find-identity -v -p codesigning`
#codesign --force --deep --options runtime --timestamp \
#  --sign "5CF51755590FF0D10D003787634667ACF96D9691" \
#  "src-tauri/target/universal-apple-darwin/release/bundle/macos/Kaleidomo.app"

# Sign the DMG
#codesign --force --timestamp \
#  --sign "5CF51755590FF0D10D003787634667ACF96D9691" \
#  "src-tauri/target/universal-apple-darwin/release/bundle/dmg/Kaliedomo_1.0.1_universal.dmg"

#xcrun notarytool submit "src-tauri/target/universal-apple-darwin/release/bundle/dmg/Kaleidomo_1.0.1_universal.dmg" \
#--keychain-profile "abcNotarizationKey"