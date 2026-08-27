# Running the unsigned macOS build

BrainBuddy's current GitHub Actions packages use an ad-hoc code signature. They
do not yet use an Apple Developer ID certificate or Apple's notarization
service. macOS may therefore block the first launch of an artifact downloaded
from GitHub.

Only use the following override for a BrainBuddy artifact downloaded from this
repository's GitHub Actions page.

1. Open the DMG and copy `BrainBuddy.app` to `/Applications`.
2. Try Control-clicking the app and selecting **Open**.
3. If macOS still reports that the app is damaged, run:

   ```bash
   xattr -dr com.apple.quarantine /Applications/BrainBuddy.app
   open /Applications/BrainBuddy.app
   ```

The ad-hoc signature is verified during the GitHub Actions build. A future
Developer ID signature and notarization step will remove the need for this
manual Gatekeeper override.
