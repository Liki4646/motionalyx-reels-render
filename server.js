import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { execFile } from "child_process";
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

function msToSrtTime(msIn) {
  let ms = Math.max(0, Math.round(Number(msIn) || 0));
  const h = Math.floor(ms / 3600000);
  ms -= h * 3600000;
  const m = Math.floor(ms / 60000);
  ms -= m * 60000;
  const s = Math.floor(ms / 1000);
  const ms2 = ms - s * 1000;
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${String(ms2).padStart(3, "0")}`;
}

function sanitizeCaptionText(input) {
  // Fix the "\n" (backslash-n) or actual newlines showing up as "n" / broken spacing in subtitles.
  // We force everything into a single line per cue and let ffmpeg handle wrapping naturally.
  return String(input ?? "")
    .replace(/\r\n/g, " ")
    .replace(/\r/g, " ")
    .replace(/\n/g, " ")
    .replace(/\\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeAndScaleCaptions(captions, audioMs) {
  // captions: [{start_ms, end_ms, text}]
  // Scale total captions to audio duration proportionally, then sanitize to be continuous and end exactly at audioMs.
  if (!Array.isArray(captions) || captions.length === 0) return [];

  const cleaned = captions
    .map((c) => ({
      start_ms: Number(c?.start_ms),
      end_ms: Number(c?.end_ms),
      text: sanitizeCaptionText(c?.text),
    }))
    .filter(
      (c) =>
        Number.isFinite(c.start_ms) &&
        Number.isFinite(c.end_ms) &&
        c.end_ms > c.start_ms &&
        c.text
    )
    .sort((a, b) => a.start_ms - b.start_ms);

  if (cleaned.length === 0) return [];

  const lastEnd = Math.max(...cleaned.map((c) => c.end_ms));
  const captionsMs = Number.isFinite(lastEnd) && lastEnd > 0 ? lastEnd : 0;

  // If we can't read audio duration, return cleaned as-is (still text-sanitized).
  if (!Number.isFinite(audioMs) || audioMs <= 0 || captionsMs <= 0) {
    // Also re-stitch to avoid overlaps/holes if input is messy
    let t = 0;
    const minSeg = 250; // ms
    return cleaned.map((c) => {
      const dur = Math.max(minSeg, Math.round(c.end_ms - c.start_ms));
      const out = { start_ms: t, end_ms: t + dur, text: c.text };
      t = out.end_ms;
      return out;
    });
  }

  const scale = audioMs / captionsMs;

  // Scale starts/ends
  const scaled = cleaned.map((c) => ({
    start_ms: Math.round(c.start_ms * scale),
    end_ms: Math.round(c.end_ms * scale),
    text: c.text,
  }));

  // Sanitize: continuous, monotonic, min duration, last ends exactly at audioMs
  const minSeg = 250; // ms (prevents tiny segments collapsing)
  let cursor = 0;

  for (let i = 0; i < scaled.length; i++) {
    const c = scaled[i];
    let dur = Math.max(minSeg, c.end_ms - c.start_ms);
    c.start_ms = cursor;
    c.end_ms = cursor + dur;
    cursor = c.end_ms;
  }

  // If we overshoot or undershoot, redistribute proportionally by durations
  const total = cursor;
  if (total !== audioMs && total > 0) {
    const factor = audioMs / total;
    cursor = 0;
    for (let i = 0; i < scaled.length; i++) {
      const dur = Math.max(minSeg, Math.round((scaled[i].end_ms - scaled[i].start_ms) * factor));
      scaled[i].start_ms = cursor;
      scaled[i].end_ms = cursor + dur;
      cursor = scaled[i].end_ms;
    }
  }

  // Hard clamp last to audioMs, and ensure non-decreasing
  if (scaled.length > 0) {
    scaled[0].start_ms = 0;
    for (let i = 1; i < scaled.length; i++) {
      if (scaled[i].start_ms !== scaled[i - 1].end_ms) {
        scaled[i].start_ms = scaled[i - 1].end_ms;
      }
      if (scaled[i].end_ms <= scaled[i].start_ms) {
        scaled[i].end_ms = scaled[i].start_ms + minSeg;
      }
    }
    scaled[scaled.length - 1].end_ms = audioMs;
  }

  return scaled;
}

app.post("/render", async (req, res) => {
  const {
    audio_url,
    images,
    captions,
    end_card_url,
    end_card_duration_ms = 4000,
    video = { width: 1080, height: 1920, fps: 30 },
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
    const srtPath = path.join(workDir, "captions.srt");
    const outPath = path.join(workDir, "out.mp4");

    await downloadToFile(audio_url, audioPath);
    await downloadToFile(images[0], img1Path);
    await downloadToFile(images[1], img2Path);
    await downloadToFile(images[2], img3Path);
    await downloadToFile(end_card_url, endPath);

    // Audio duration (ms)
    let audioMs = 0;
    try {
      const { stdout: probeOut } = await execFileAsync("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        audioPath,
      ]);
      const audioSeconds = parseFloat(String(probeOut).trim());
      if (Number.isFinite(audioSeconds) && audioSeconds > 0) {
        audioMs = Math.round(audioSeconds * 1000);
      }
    } catch (_e) {
      audioMs = 0;
    }

    // Scale + sanitize captions to match audio, and also fix "\n" artifacts
    const finalCaptions = normalizeAndScaleCaptions(captions, audioMs);

    // Write SRT
    const srtLines = [];
    finalCaptions.forEach((c, i) => {
      const start = Number(c.start_ms);
      const end = Number(c.end_ms);
      const text = sanitizeCaptionText(c.text);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !text) return;
      srtLines.push(String(i + 1));
      srtLines.push(`${msToSrtTime(start)} --> ${msToSrtTime(end)}`);
      srtLines.push(text);
      srtLines.push("");
    });
    fs.writeFileSync(srtPath, srtLines.join("\n"), "utf8");

    const w = Number(video.width || 1080);
    const h = Number(video.height || 1920);
    const fps = Number(video.fps || 30);

    const endMs = Number(end_card_duration_ms || 4000);
    const endSec = Math.max(0.1, endMs / 1000);

    // Slideshow durations (audio split in 3)
    const aMs = Math.max(0, audioMs);
    const seg1 = Math.floor(aMs / 3);
    const seg2 = Math.floor(aMs / 3);
    const seg3 = Math.max(0, aMs - seg1 - seg2);

    // Subtitle styling:
    // - No background bar (no drawbox, no subtitle background)
    // - Bottom-center alignment, moved up into the ~78%-89% band via MarginV ≈ h*0.16
    // - Increase size by +50% vs previous (+50% again): set around 99-100 for 1080x1920
    const marginV = Math.round(h * 0.16); // ~300 at 1920 height (puts baseline around 84%)
    const fontSize = 100; // ~+50% from ~66; adjust if needed

    // Escape path for ffmpeg subtitles filter
    const escSrtPath = srtPath.replace(/\\/g, "\\\\").replace(/:/g, "\\:");

    const filter = [
      `[0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1[v0]`,
      `[1:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1[v1]`,
      `[2:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1[v2]`,
      `[3:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1[v3]`,

      `[v0]trim=duration=${(seg1 / 1000).toFixed(3)},setpts=PTS-STARTPTS[a0]`,
      `[v1]trim=duration=${(seg2 / 1000).toFixed(3)},setpts=PTS-STARTPTS[a1]`,
      `[v2]trim=duration=${(seg3 / 1000).toFixed(3)},setpts=PTS-STARTPTS[a2]`,
      `[a0][a1][a2]concat=n=3:v=1:a=0[slideshow]`,

      // Burn subtitles on slideshow only (no background). Keep bottom-center, move up via MarginV.
      `[slideshow]subtitles=${escSrtPath}:force_style='FontName=Arial,FontSize=${fontSize},PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BackColour=&H00000000,Bold=0,Italic=0,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=${marginV},MarginL=120,MarginR=120'[subbed]`,

      `[v3]trim=duration=${endSec.toFixed(3)},setpts=PTS-STARTPTS[endcard]`,
      `[subbed][endcard]concat=n=2:v=1:a=0[vout]`,
    ].join(";");

    const args = [
      "-y",
      "-loop",
      "1",
      "-t",
      (Math.max(0.1, seg1 / 1000)).toFixed(3),
      "-i",
      img1Path,
      "-loop",
      "1",
      "-t",
      (Math.max(0.1, seg2 / 1000)).toFixed(3),
      "-i",
      img2Path,
      "-loop",
      "1",
      "-t",
      (Math.max(0.1, seg3 / 1000)).toFixed(3),
      "-i",
      img3Path,
      "-loop",
      "1",
      "-t",
      endSec.toFixed(3),
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
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      outPath,
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
