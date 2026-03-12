# Longer Videos: Veo Extension & Alternatives

## Current Limitation

- **Veo (Gemini API)** generates a single clip of **4, 6, or 8 seconds** per request.
- Asking for "20–30 seconds" in the prompt does **not** produce a longer clip; it can cause the API to fail or return no video.
- So today we use **8 second clips** only.

---

## Option 1: Veo 3.1 Video Extension (same API, recommended)

**No new provider.** Use the same Veo 3.1 model and Gemini API.

### How it works

1. **First call (text-to-video):** Generate an **8 second** clip with a prompt (as we do now).
2. **Extension calls:** Call the **same** `predictLongRunning` endpoint again with:
   - **Input:** The **video** from the previous step (URI or bytes from the last generation).
   - **Prompt:** A **continuation** prompt (e.g. “Continue with the next step of the recipe” or “Continue the movement”).
3. Each extension adds **7 seconds** to the video.
4. You can extend **up to 20 times** per video.
5. **Max total length:** 8 + (20 × 7) = **148 seconds** (~2.5 minutes).

Reference: [Generate videos with Veo 3.1 – Extending Veo videos](https://ai.google.dev/gemini-api/docs/video) (Gemini API docs).

### Example lengths

| Use case   | Extensions | Total length   |
|-----------|------------|----------------|
| Exercise  | 1          | 8 + 7 = **15 s** |
| Exercise  | 2          | 8 + 14 = **22 s** |
| Meal      | 4          | 8 + 28 = **36 s** |
| Meal      | 6          | 8 + 42 = **50 s** |
| Meal (max)| 20         | **148 s**       |

### What we need to implement

1. **Backend (API)**  
   - After the first video generation completes and we have a **video URI** (or downloadable URL):
     - Call **Veo again** with that video as input + a **continuation prompt** (same `predictLongRunning` flow, different request body).
   - Docs indicate the request must include a `video` parameter (previous Veo output); the exact REST shape for `instances` / `parameters` for “video in” needs to be taken from the [Gemini video API](https://ai.google.dev/gemini-api/docs/video) (e.g. `instances: [{ prompt, video: { uri } }]` or similar).
   - Poll this second operation until done, then read the new video URI.
   - Optionally **repeat** the extend step N times (e.g. N=3 for meals → 8 + 21 = 29 s).

2. **Prompts**  
   - **First prompt:** Same as today (e.g. “Chef preparing ingredients for X, professional kitchen, 8 second clip”).
   - **Continuation prompts:** Short, step-wise (e.g. “Continue cooking on the stove, steam rising” then “Continue plating and garnishing”). For exercises: “Continue the same movement” or “Continue the rep.”

3. **Configuration**  
   - Add a setting (e.g. per asset type or per request): “number of extensions” (0 = current 8 s only, 1–20 = longer). Meals could default to 4–6; exercises to 1–2.

4. **UI**  
   - Optional: “Longer video” toggle or “Extension count” (0 / 1 / 2 / 4 / 6) so users can choose length without changing code.

### Technical note

- Extension is **only** for **Veo 3.1** (e.g. `veo-3.1-generate-preview`).
- Extension output is **720p** (no 1080p for extended part).
- Input video must be **Veo-generated** and meet length/aspect/resolution limits in the docs.

**Caveat:** Extension = multiple segments (8s + 7s + 7s + …). The join can sometimes feel visible; it’s not one continuous render. If you want **one cohesive clip** with no “cut out” feeling, use a different API that supports longer **single-clip** generation (see Option 2 below).

---

## Option 2: Other APIs – single cohesive clip (no stitching)

Use an API that generates **one video in a single request** (no extension/stitching), so the result is one cohesive clip.

| Provider | Single-clip max (typical) | Notes |
|----------|---------------------------|--------|
| **OpenAI Sora (Videos API)** | **8–20 seconds** (configurable `seconds`) | One render, one MP4. Good continuity, no stitching. [Videos API](https://platform.openai.com/docs/guides/video-generation). Requires OpenAI API key. |
| **Runway API** | **2–10 seconds** | Gen-4 Turbo / Gen-4. Single clip per request. [Runway API](https://docs.dev.runwayml.com/). |
| **Luma Dream Machine** | **~5–10 seconds** (duration parameter) | Single clip. [Luma API](https://docs.lumalabs.ai/). |
| **Kling AI** (via fal.ai, Segmind, etc.) | **5–10 seconds** base | Longer via extension (again multiple segments). |
| **Pika / Minimax / Seedance** | **~25–30 seconds** (reports) | Single-clip APIs; availability and limits vary by provider. |

**Practical recommendation if you want one cohesive clip:**

- **OpenAI Sora** – Best fit for a **single, smooth clip** (e.g. 10–20s) with one API call. Same flow as today: prompt → poll → download MP4. No extension, so no “5 videos of 8 seconds cut out.”
- **Runway** – Shorter single clip (2–10s) but still one cohesive output; add as an option if you already use Runway.
- **Luma** – Similar idea; add if you prefer Luma’s quality or pricing.

Integration effort: new backend “provider” (e.g. Sora client), env var for API key, and a config or UI toggle to choose “Veo” vs “Sora” (or other). Same upload-to-YouTube flow can be reused.

---

## Summary

- **To get longer videos with what we have today:**  
  Implement **Veo 3.1 extension** in the backend: after the first 8 s generation, call Veo again with the previous video + continuation prompt, and optionally repeat (e.g. 1–2× for exercises, 4–6× for meals).
- **For meals:** Same method; use 4–6 extensions to reach ~36–50 seconds.
- **No other method is required** for “longer meals and exercises” as long as ~30–60 s (or up to 148 s) is enough; extension is the intended way to get longer Veo videos.

Next step: implement the “extend” request (video in + continuation prompt) and a loop for N extensions in the backend, then wire length/extension count from config or UI.
