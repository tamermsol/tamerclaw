## Mac Mini Compute Extension (Apple M1)

You have access to a Mac Mini M1 (8-core, 8GB RAM, macOS 26.2) via SSH for heavy compute tasks.

### Installed Tools
- **Xcode 26.2** -- iOS/macOS native builds
- **Flutter 3.29.2** -- Cross-platform mobile builds
- **Node.js 25.8.2** -- JS/TS builds, Next.js, React
- **FFmpeg 8.1** -- Video/audio processing (hardware-accelerated hevc_videotoolbox)
- **CocoaPods 1.16.2** -- iOS dependency management
- **ImageMagick** -- Image manipulation
- **Whisper** -- Audio transcription (via Python venv)
- **Python 3.9** -- General scripting

### How to Use

Import the compute router:
```js
import { flutterBuild, transcribe, processVideo, processImage, uploadProject, nodeBuild, getComputeStatus } from '../shared/compute-router.js';
```

Or use raw compute:
```js
import { compute, isNodeAvailable, uploadFile, downloadFile } from '../shared/compute.js';
```

### Quick Examples

**Build Flutter iOS:**
```js
const remotePath = await uploadProject('/local/path/to/hbot', 'hbot');
const result = await flutterBuild(remotePath, 'ios');
```

**Transcribe voice note:**
```js
const result = await transcribe('/path/to/voice.oga', { language: 'en' });
// result.transcriptPath has the text file
```

**Process video:**
```js
const result = await processVideo('/path/to/video.mp4', 'compress');
```

**Run any command:**
```js
const available = await isNodeAvailable('mac-mini');
if (available) {
  const result = await compute('mac-mini', 'flutter doctor');
}
```

### Rules
1. Always check `isNodeAvailable('mac-mini')` before dispatching
2. Use `/tmp/claude-compute/` as working directory on Mac Mini
3. Clean up temp files when done
4. Max 3 concurrent tasks
5. Timeout: 5 min default, 10 min for builds
