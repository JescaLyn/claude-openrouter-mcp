# Test Fixtures

This directory is gitignored — fixture files are **not committed to the repo**.

The model comparison suite (`tests/model-comparison/`) requires local fixture files to run multimodal test cases. If a fixture is missing, the runner skips that test and logs a warning.

## Setting up fixtures

Add your own files matching the names below. Any sufficiently representative image or video of the right type works.

### Image fixtures

| Filename | Used in test | Expected content |
|---|---|---|
| `vera.jpeg` | `analyze_img_01` — Portrait Analysis | A portrait photo (person, face visible) |
| `beesknees.gif` | `analyze_img_02` — Animation/Art Style | An animated GIF (any style) |
| `fox-alphabet.webp` | `analyze_img_03` — Cartoon/Character Analysis | A cartoon or illustrated character image |
| `phantom.jpeg` | `analyze_img_04` — Portrait Photography | A photographic portrait |

### Video fixtures

| Filename | Used in test | Expected content |
|---|---|---|
| `Generate Personality v1.mov` | `analyze_vid_02` — Motion Graphics/Animation | A short motion graphics or animation clip (MOV) |
| `Trump 2.0： Last Week Tonight with John Oliver (HBO) [cw0F8G4-dMw].mp4` | `analyze_vid_01` — Talk Show Analysis | A talk show or interview clip (MP4) |

> Tip: any short, permissively-licensed media of the right format works. The test prompts analyze style and content generically — they don't depend on specific subjects.

## Skipping fixture-based tests

Fixture tests are only in `tests/model-comparison/` and only run via `npm run test:models`. The regular unit test suite (`npm test`) uses mocked clients and has no fixture dependencies.
