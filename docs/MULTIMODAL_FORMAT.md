# OpenRouter Multimodal Request Format

## Common Mistake (Anthropic-style format)

OpenRouter does **not** use Anthropic's vision API format. The following will fail silently — the model responds but claims it cannot see the content:

```json
{
  "role": "user",
  "content": [
    {
      "type": "image",
      "source": { "type": "base64", "media_type": "image/jpeg", "data": "..." }
    },
    { "type": "text", "text": "prompt" }
  ]
}
```

**What's wrong:**
- `type: "image"` must be `type: "image_url"`
- `source` object must be replaced with a direct `url` field
- Text must come before media in the array

---

## Correct Format (✅ Right)

### Images

```json
{
  "role": "user",
  "content": [
    {
      "type": "text",
      "text": "Analyze this image..."
    },
    {
      "type": "image_url",
      "image_url": {
        "url": "data:image/jpeg;base64,{base64_encoded_image}"
      }
    }
  ]
}
```

**Supported Image Formats:** PNG, JPEG, WebP, GIF

### Videos

```json
{
  "role": "user",
  "content": [
    {
      "type": "text",
      "text": "Analyze this video..."
    },
    {
      "type": "video_url",
      "video_url": {
        "url": "data:video/mp4;base64,{base64_encoded_video}"
      }
    }
  ]
}
```

**Supported Video Formats:** MP4, MOV, WebM

---

## Critical Details

### Array Order
✅ **Correct:** Text prompt **first**, then media
```json
[
  { "type": "text", "text": "..." },
  { "type": "image_url", "image_url": { "url": "..." } }
]
```

❌ **Wrong:** Media before text
```json
[
  { "type": "image_url", "image_url": { "url": "..." } },
  { "type": "text", "text": "..." }
]
```

### URL Encoding
Local files must be base64-encoded with data URL prefix:
```
data:image/jpeg;base64,/9j/4AAQSkZJRgABA...
```

Remote/public URLs can be used directly:
```
https://example.com/image.jpg
```

---

## What OpenRouter Does

OpenRouter acts as a **unified gateway** to multiple providers:
- Routes to the provider that hosts the model
- Converts requests to provider-specific formats
- Some providers (e.g., Google Gemini) have additional constraints
  - Gemini: Only YouTube links for video (not local base64)
  - Limits on image/video dimensions and file sizes vary by provider

---

## Implementation Notes

When implementing multimodal requests:

1. **Content Array Structure:**
   - Always put text first
   - Then image_url or video_url entries
   - Each media type gets its own content block

2. **Fixture Loading:**
   - Read file as binary
   - Base64 encode
   - Wrap with `data:{mime_type};base64,{encoded_data}`

3. **Model Selection:**
   - Verify model supports `input_modalities: ["image"]` or `["video"]`
   - Some models claim support but have limited vision capability
   - Test with known-working free models first (Gemini, Nemotron VL)

4. **Debugging Patterns:**
   - If model responds with "can't see image," check:
     a) Content type field names (image_url, not image)
     b) Array order (text first)
     c) URL encoding (proper data URL format)
     d) Provider support (some providers don't support base64 video)

---

## Sources

- OpenRouter Docs: https://openrouter.ai/docs/guides/overview/multimodal/images
- OpenRouter Docs: https://openrouter.ai/docs/guides/overview/multimodal/videos
- Tested with: Nemotron 3 Nano Omni, Nemotron VL 12B, Gemma 4, Qwen3.6

