# TamerClaw - App Store & Play Store Publishing Guide

## Prerequisites

### Developer Accounts
1. **Apple Developer Program** ($99/year)
   - Sign up at: https://developer.apple.com/programs/
   - Requires Apple ID + identity verification
   - Takes 24-48 hours to approve

2. **Google Play Developer** ($25 one-time)
   - Sign up at: https://play.google.com/console/signup
   - Requires Google account + identity verification
   - Takes a few days for first app review

### Tools Required
- macOS computer (required for iOS builds - cannot build iOS on Linux)
- Xcode 15+ (from Mac App Store)
- Flutter SDK 3.16+
- Fastlane: `gem install fastlane`

---

## Android (Google Play Store)

### Step 1: Generate Release Signing Key
```bash
keytool -genkey -v \
  -keystore android/tamerclaw-release.jks \
  -keyalg RSA -keysize 2048 \
  -validity 10000 \
  -alias tamerclaw
```
IMPORTANT: Save this keystore and password securely. If you lose it, you cannot update the app.

### Step 2: Configure Signing
```bash
cp android/key.properties.template android/key.properties
# Edit android/key.properties with your keystore details
```

### Step 3: Build App Bundle
```bash
flutter build appbundle --release --obfuscate --split-debug-info=build/debug-info
```
Output: `build/app/outputs/bundle/release/app-release.aab`

### Step 4: Upload to Play Console
1. Go to https://play.google.com/console
2. Create new app > "TamerClaw - AI Voice Assistant"
3. Fill in store listing from `store/shared/store-listing.md`
4. Upload privacy policy (`store/shared/privacy-policy.html`) — host it at a URL
5. Upload screenshots (phone + 7" tablet + 10" tablet)
6. Set content rating (fill questionnaire)
7. Set pricing: Free
8. Upload .aab to Internal Testing track first
9. Test with internal testers
10. Promote to Production when ready

### Step 5: App Review
- First review takes 3-7 days
- Accessibility apps sometimes get expedited review
- Common rejection reasons: missing privacy policy, unclear permissions

---

## iOS (App Store)

### Step 1: Setup on Mac
```bash
# Install dependencies
sudo gem install fastlane
flutter pub get
cd ios && pod install && cd ..
```

### Step 2: Configure Signing in Xcode
1. Open `ios/Runner.xcworkspace` in Xcode
2. Select Runner target > Signing & Capabilities
3. Set Team to your Apple Developer account
4. Bundle Identifier: `com.tamerclaw.app`
5. Enable "Automatically manage signing"

### Step 3: Create App in App Store Connect
1. Go to https://appstoreconnect.apple.com
2. My Apps > "+" > New App
3. Name: "TamerClaw - AI Voice Assistant"
4. Bundle ID: `com.tamerclaw.app`
5. SKU: `com.tamerclaw.app`

### Step 4: Build IPA
```bash
flutter build ipa --release --obfuscate --split-debug-info=build/debug-info --export-method=app-store
```

### Step 5: Upload to TestFlight
```bash
# Using Fastlane
cd ios && fastlane testflight_upload

# Or manually via Xcode > Product > Archive > Distribute
```

### Step 6: Submit for Review
1. In App Store Connect, select the build
2. Fill in store listing from `store/shared/store-listing.md`
3. Add screenshots (6.7" iPhone, 6.5" iPhone, 12.9" iPad)
4. Set privacy policy URL
5. Answer App Review questions
6. Submit for review

### Step 7: App Review
- First review takes 1-3 days
- Mention accessibility purpose in review notes:
  "This app is designed to help people with cerebral palsy and other speech disabilities communicate using AI voice agents."
- Apple expedites accessibility-focused apps

---

## Screenshots Needed

### Android (Google Play)
- Phone: 1080x1920 or 1440x2560 (min 2, max 8)
- 7" Tablet: 1200x1920 (optional but recommended)
- 10" Tablet: 1600x2560 (optional but recommended)

### iOS (App Store)
- 6.7" iPhone (1290x2796) — required
- 6.5" iPhone (1242x2688) — required
- 5.5" iPhone (1242x2208) — required
- 12.9" iPad (2048x2732) — required if supporting iPad

### Screenshot Content Suggestions
1. Main chat screen with an agent conversation
2. Voice call screen (showing the animated avatar)
3. Agent list with customized names/icons
4. Voice note being recorded
5. Settings/biometric lock screen

---

## App Icon

Current icons are Flutter defaults. You need a custom TamerClaw icon:
- 1024x1024 PNG (no transparency for iOS)
- Use a tool like https://www.appicon.co/ to generate all sizes
- Place Android icons in `android/app/src/main/res/mipmap-*/`
- Place iOS icon in `ios/Runner/Assets.xcassets/AppIcon.appiconset/`

---

## Important Notes

1. **iOS requires a Mac** — you cannot build for iOS on this Linux server
2. **Bundle ID consistency** — use `com.tamerclaw.app` on both platforms
3. **Version numbers** — keep Android and iOS versions in sync via pubspec.yaml
4. **Privacy policy** — must be hosted at a public URL (both stores require it)
5. **Accessibility claim** — both stores have special categories/tags for accessibility apps. Use them — they help with discoverability and may speed up review.
