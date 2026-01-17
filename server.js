import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import tmp from "tmp";

const execFileAsync = promisify(execFile);
tmp.setGracefulCleanup();

const app = express();
app.use(express.json({ limit: "50mb" }));

app.get("/", (_req, res) => res.status(200).json({ ok: true }));
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));

async function downloadToFile(url, outPath) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Download failed ${r.status}: ${url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(outPath, buf);
}

function ensureArray(val, name) {
  if (!Array.isArray(val)) throw new Error(`${name} must be an array`);
}

function normalizeAndScaleCaptions(captions, audioMs) {
  if (!Array.isArray(captions)) return [];

  const items = [];
  for (const c of captions) {
    const start = Number(c?.start_ms);
    const end = Number(c?.end_ms);
    const txt = String(c?.text || "").trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !txt) continue;
    items.push({ dur_ms: end - start, text: txt });
  }
  if (items.length === 0) return [];

  if (!Number.isFinite(audioMs) || audioMs <= 0) {
    const out = [];
    let cur = 0;
    for (const it of items) {
      const dur = Math.max(1, Math.round(it.dur_ms));
      out.push({ start_ms: cur, end_ms: cur + dur, text: it.text });
      cur += dur;
    }
    return out;
  }

  const totalDur = items.reduce((acc, it) => acc + Math.max(1, Math.round(it.dur_ms)), 0);
  if (totalDur <= 0) return [];

  const factor = audioMs / totalDur;

  const n = items.length;
  let minSegMs = 600;
  const maxPossibleMin = Math.floor(audioMs / n);
  if (maxPossibleMin <= 0) minSegMs = 80;
  else if (minSegMs > maxPossibleMin) minSegMs = Math.max(80, maxPossibleMin);

  const scaled = items.map((it) => {
    const d = Math.max(1, Math.round(it.dur_ms));
    return { text: it.text, dur_ms: Math.max(minSegMs, Math.round(d * factor)) };
  });

  let sum = scaled.reduce((acc, x) => acc + x.dur_ms, 0);

  if (sum > audioMs) {
    let over = sum - audioMs;
    const idx = scaled
      .map((x, i) => ({ i, d: x.dur_ms }))
      .sort((a, b) => b.d - a.d)
      .map((x) => x.i);

    for (const i of idx) {
      if (over <= 0) break;
      const canReduce = Math.max(0, scaled[i].dur_ms - minSegMs);
      const reduceBy = Math.min(canReduce, over);
      scaled[i].dur_ms -= reduceBy;
      over -= reduceBy;
    }

    if (over > 0) {
      for (let i = scaled.length - 1; i >= 0 && over > 0; i--) {
        const canReduce = Math.max(0, scaled[i].dur_ms - 1);
        const reduceBy = Math.min(canReduce, over);
        scaled[i].dur_ms -= reduceBy;
        over -= reduceBy;
      }
    }
  } else if (sum < audioMs) {
    scaled[scaled.length - 1].dur_ms += audioMs - sum;
  }

  const out = [];
  let cur = 0;
  for (let i = 0; i < scaled.length; i++) {
    const dur = Math.max(1, Math.round(scaled[i].dur_ms));
    const start_ms = cur;
    const end_ms = i === scaled.length - 1 ? audioMs : start_ms + dur;
    out.push({ start_ms, end_ms, text: scaled[i].text });
    cur = end_ms;
  }
  if (out.length) out[out.length - 1].end_ms = audioMs;

  return out;
}

// IMPORTANT FIX:
// - Do NOT alter caption text content (no wrapping, no whitespace normalization).
// - But we must escape for FFmpeg drawtext parsing.
// - And we must encode real newlines as "\\n" (double backslash) so FFmpeg renders a line break
//   instead of eating "\" and leaving "n" in the text.
function escDrawtext(t) {
  let s = String(t || "");

  // If input contains literal "\n" or "\r\n" sequences, interpret them as actual newlines.
  // This preserves intent without changing words/spaces.
  s = s.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n");

  return s
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/%/g, "\\%")
    // FFmpeg drawtext newline requires \\n (double backslash) inside filter string
    .replace(/\n/g, "\\\\n");
}

// OPTION 2: text_w limiter via dynamic font-size (simple + robust heuristic).
// We approximate text width by characters. For DejaVuSans at large sizes, average glyph width
// is roughly ~0.56 * fontsize. We fit the longest line into safeW (12% margins each side => 76% width).
function fitFontSizeForSafeWidth(rawText, baseFontSize, safeW) {
  const s = String(rawText || "")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n");

  const lines = s.split("\n");
  const maxChars = Math.max(1, ...lines.map((ln) => ln.length));

  const AVG_CHAR_EM = 0.56; // heuristic for DejaVuSans
  const fsFit = Math.floor(safeW / (maxChars * AVG_CHAR_EM));

  // Clamp: never exceed baseFontSize, never go below a readable minimum
  const MIN_FS = 20;
  return Math.max(MIN_FS, Math.min(baseFontSize, fsFit));
}

app.post("/render", async (req, res) => {
  const {
    audio_url,
    images,
    captions,
    end_card_url,
    end_card_duration_ms = 4000,
    video = { width: 1080, height: 1920, fps: 30 }
  } = req.body || {};

  try {
    if (!audio_url) throw new Error("audio_url is required");
    if (!end_card_url) throw new Error("end_card_url is required");
    ensureArray(images, "images");
    if (images.length !== 3) throw new Error("images must have exactly 3 URLs");
    ensureArray(captions, "captions");

    const workDir = tmp.dirSync({ unsafeCleanup: true }).name;

    const audioPath = path.join(workDir, "audio.mp3");
    const img1Path = path.join(workDir, "img1.png");
    const img2Path = path.join(workDir, "img2.png");
    const img3Path = path.join(workDir, "img3.png");
    const endPath = path.join(workDir, "end.png");
    const outPath = path.join(workDir, "out.mp4");

    await downloadToFile(audio_url, audioPath);
    await downloadToFile(images[0], img1Path);
    await downloadToFile(images[1], img2Path);
    await downloadToFile(images[2], img3Path);
    await downloadToFile(end_card_url, endPath);

    let audioMs = NaN;
    try {
      const { stdout: probeOut } = await execFileAsync("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        audioPath
      ]);
      const audioSeconds = parseFloat(String(probeOut || "").trim());
      if (Number.isFinite(audioSeconds) && audioSeconds > 0) audioMs = Math.round(audioSeconds * 1000);
    } catch (_e) {
      audioMs = NaN;
    }

    const w = Number(video.width || 1080);
    const h = Number(video.height || 1920);
    const fps = Number(video.fps || 30);

    const scaledCaptions = normalizeAndScaleCaptions(captions, audioMs);

    let effectiveAudioMs = audioMs;
    if (!Number.isFinite(effectiveAudioMs) || effectiveAudioMs <= 0) {
      const lastEnd = scaledCaptions.length ? Number(scaledCaptions[scaledCaptions.length - 1].end_ms) : 0;
      effectiveAudioMs = Number.isFinite(lastEnd) && lastEnd > 0 ? Math.round(lastEnd) : 15000;
    }

    const seg1 = Math.floor(effectiveAudioMs / 3);
    const seg2 = Math.floor(effectiveAudioMs / 3);
    const seg3 = Math.max(0, effectiveAudioMs - seg1 - seg2);

    const coverCrop = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=${fps},format=yuv420p`;

    // === CAPTION VISUALS (FONT SIZE BASE = 40px) ===
    const fontSizeBase = 40;
    const fontSize = Math.max(14, Math.round(fontSizeBase * 1.5)); // +50% (base behavior)
    const lineSpacing = Math.max(2, Math.round(fontSize * 0.25));
    const borderW = 2;

    // 12% margins left/right => safe width is 76%
    const safeW = w * 0.76;

    // Center around 84% height: y = (h*0.84) - (text_h/2)
    const yExpr = `(h*0.84)-(text_h/2)`;
    const xExpr = `(w-text_w)/2`;
    // ==============================================

    const drawtexts = scaledCaptions.map((c) => {
      const start = (Number(c.start_ms) / 1000).toFixed(3);
      const end = (Number(c.end_ms) / 1000).toFixed(3);

      // Use caption text exactly as provided (no wrapping/normalizing).
      const safeText = escDrawtext(c.text);

      // Dynamic fontsize to keep within safe width
      const fsDyn = fitFontSizeForSafeWidth(c.text, fontSize, safeW);

      return (
        `drawtext=` +
        `font=DejaVuSans:` +
        `text='${safeText}':` +
        `fontsize=${fsDyn}:` +
        `fontcolor=white:` +
        `borderw=${borderW}:` +
        `bordercolor=black@1:` +
        `line_spacing=${lineSpacing}:` +
        `x=${xExpr}:` +
        `y=${yExpr}:` +
        `enable='between(t,${start},${end})'`
      );
    });

    const filterParts = [
      `[0:v]${coverCrop}[v0]`,
      `[1:v]${coverCrop}[v1]`,
      `[2:v]${coverCrop}[v2]`,
      `[3:v]${coverCrop}[v3]`,

      `[v0]trim=duration=${seg1 / 1000},setpts=PTS-STARTPTS[s0]`,
      `[v1]trim=duration=${seg2 / 1000},setpts=PTS-STARTPTS[s1]`,
      `[v2]trim=duration=${seg3 / 1000},setpts=PTS-STARTPTS[s2]`,
      `[s0][s1][s2]concat=n=3:v=1:a=0[slideshow]`
    ];

    if (drawtexts.length) {
      filterParts.push(`[slideshow]${drawtexts.join(",")}[subbed]`);
    } else {
      filterParts.push(`[slideshow]setpts=PTS-STARTPTS[subbed]`);
    }

    filterParts.push(
      `[v3]trim=duration=${Number(end_card_duration_ms) / 1000},setpts=PTS-STARTPTS[endcard]`,
      `[subbed][endcard]concat=n=2:v=1:a=0[vout]`
    );

    const filter = filterParts.join(";");

    const args = [
      "-y",
      "-loop",
      "1",
      "-t",
      (seg1 / 1000).toFixed(3),
      "-i",
      img1Path,
      "-loop",
      "1",
      "-t",
      (seg2 / 1000).toFixed(3),
      "-i",
      img2Path,
      "-loop",
      "1",
      "-t",
      (seg3 / 1000).toFixed(3),
      "-i",
      img3Path,
      "-loop",
      "1",
      "-t",
      (Number(end_card_duration_ms) / 1000).toFixed(3),
      "-i",
      endPath,
      "-i",
      audioPath,
      "-filter_complex",
      filter,
      "-map",
      "[vout]",
      "-map",
      "4:a",
      "-r",
      String(fps),
      "-shortest",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-profile:v",
      "high",
      "-level",
      "4.1",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      outPath
    ];

    await execFileAsync("ffmpeg", args);

    const mp4 = fs.readFileSync(outPath);
    res.setHeader("Content-Type", "video/mp4");
    res.status(200).send(mp4);
  } catch (err) {
    res.status(400).json({ ok: false, error: String(err?.message || err) });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`listening on ${port}`));
