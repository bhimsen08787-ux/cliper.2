# Clipcraft: free OpusClip-style clipper (Vercel + browser)

How it works: Vercel hosts a static page. Your browser does the video work (ffmpeg.wasm).
Only audio goes to Groq (free Whisper). Optional Gemini key picks the best moments.
No server cost, no GPU, works on any device with a modern browser (best on desktop Chrome/Edge).

## Deploy to Vercel (free)
Option A (no coding): push this folder to a GitHub repo, then vercel.com > Add New > Project > import it.
  Framework Preset: Other. Build command: empty. Output directory: empty (root). Deploy.
Option B: install Node, then in this folder run:  npx vercel --prod

## Use
1. Get a free Groq key: console.groq.com/keys. (Optional) free Gemini key: aistudio.google.com.
2. Open your Vercel URL, choose a video, paste the key(s), click Generate clips.

## Limits (be aware)
- Rendering runs on the visitor's device: expect ~1-4 min per 30 s clip. Keep the tab open.
- Crop is a fixed left/center/right position (slider), not face tracking.
- Groq free tier has rate limits; very long videos may need waiting.
- Use only videos you own or have permission to use.
