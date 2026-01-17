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

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function msToAssTime(ms) {
  // ASS time format: H:MM:SS.cc (centiseconds)
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3600000);
  const rem1 = total - h * 3600000;
  const m = Math.floor(rem1 / 60000);
  const rem2 = rem1 - m * 60000;
  const s = Math.floor(rem2 / 1000);
  const cs = Math.floor((rem2 - s * 1000) / 10); // centiseconds
  const pad2 = (x) => String(x).padStart(2, "0");
  return `${h}:${pad2(m)}:${pad2(s)}.${pad2(cs)}`;
}

function sanitizeAndScaleCaptions(captions, audioMs) {
  if (!Array.isArray(captions) || captions.length === 0) return [];

  // Keep only usable items
  const cleaned = captions
    .map((c) => ({
      start_ms: Number(c?.start_ms),
      end_ms: Number(c?.end_ms),
      text: String(c?.text || "").trim(),
    }))
    .filter(
      (c) =>
        Number.isFinite(c.start_ms) &&
        Number.isFinite(c.end_ms) &&
        c.end_ms > c.start_ms &&
        c.text.length > 0
    )
    .sort((a, b) => a.start_ms - b.start_ms);

  if (!cleaned.length) return [];

  const captionsEnd = cleaned[cleaned.length - 1].end_ms;
  if (!Number.isFinite(audioMs) || audioMs <= 0 || !Number.isFinite(captionsEnd) || captionsEnd <= 0) {
    return cleaned;
  }

  const scale = audioMs / captionsEnd;

  // Scale
  const scaled = cleaned.map((c) => ({
    start_ms: c.start_ms * scale,
    end_ms: c.end_ms * scale,
    text: c.text,
  }));

  // Sanitize: continuous, no gaps/overlaps, first starts at 0, last ends exactly at audioMs
  const minDur = 180; // ms minimum per segment so it never becomes unreadable
  const out = [];
  let cursor = 0;

  for (let i = 0; i < scaled.length; i++) {
    const isLast = i === scaled.length - 1;

    // Proposed duration (scaled), but enforce minimum
    let dur = Math.max(minDur, scaled[i].end_ms - scaled[i].start_ms);

    // For last segment, force exact end at audioMs
    if (isLast) {
      const remaining = Math.max(minDur, audioMs - cursor);
      dur = remaining;
    } else {
      // Don’t let this segment push beyond audioMs minus remaining mins
      const remainingMin = minDur * (scaled.length - i - 1);
      const maxAllowed = Math.max(minDur, audioMs - cursor - remainingMin);
      dur = Math.min(dur, maxAllowed);
    }

    const start = cursor;
    const end = start + dur;

    out.push({
      start_ms: Math.round(start),
      end_ms: Math.round(end),
      text: scaled[i].text,
    });

    cursor = end;
    if (cursor >= audioMs) break;
  }

  // Ensure last ends exactly at audioMs (if we still have at least one caption)
  if (out.length) {
    out[0].start_ms = 0;
    out[out.length - 1].end_ms = Math.round(audioMs);
  }

  // Final cleanup: strictly increasing and continuous
  for (let i = 0; i < out.length; i++) {
    if (i === 0) out[i].start_ms = 0;
    if (i > 0) out[i].start_ms = out[i - 1].end_ms;
    if (out[i].end_ms <= out[i].start_ms) out[i].end_ms = out[i].start_ms + minDur;
  }
  if (out.length) out[out.length - 1].end_ms = Math.round(audioMs);

  return out;
}

function wrapToTwoLines(text, maxCharsPerLine) {
  // Goal: max 2 lines. If overflow, truncate second line with ellipsis.
  const t = String(text || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!t) return "";

  const words = t.split(" ");
  const lines = ["", ""];

  let lineIdx = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const candidate = lines[lineIdx] ? `${lines[lineIdx]} ${w}` : w;

    if (candidate.length <= maxCharsPerLine) {
      lines[lineIdx] = candidate;
      continue;
    }

    // If current line empty but word too long, hard cut
    if (!lines[lineIdx]) {
      lines[lineIdx] = w.slice(0, maxCharsPerLine);
      continue;
    }

    // Move to second line if possible
    if (lineIdx === 0) {
      lineIdx = 1;
      i -= 1; // retry this word on line 2
      continue;
    }

    // Already on line 2 and overflow => truncate
    break;
  }

  let l1 = lines[0].trim();
  let l2 = lines[1].trim();

  // If second line still too long, trim + ellipsis
  if (l2.length > maxCharsPerLine) {
    l2 = l2.slice(0, Math.max(0, maxCharsPerLine - 1)).trimEnd() + "…";
  }

  // If there are remaining words beyond what fit, also ellipsize second line
  const combined = (l1 + " " + l2).trim();
  if (combined.length < t.length) {
    if (!l2) {
      // push overflow into line 2 if empty
      const rest = t.slice(l1.length).trim();
      l2 = rest.slice(0, Math.max(0, maxCharsPerLine - 1)).trimEnd() + "…";
    } else if (!l2.endsWith("…")) {
      l2 = l2.slice(0, Math.max(0, maxCharsPerLine - 1)).trimEnd() + "…";
    }
  }

  if (l1 && l2) return `${l1}\\N${l2}`; // ASS newline
  return l1 || l2;
}

function escapeAssText(s) {
  // Escape ASS control chars minimally
  return String(s || "")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/{/g, "\\{")
    .replace(/}/g, "\\}")
    .replace(/\\/g, "\\\\");
}

function escapeFilterPath(p) {
  // Escape for ffmpeg filter args
  return String(p).replace(/\\/g, "\\\\").replace(/:/g, "\\:");
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

    // temp working dir
    const workDir = tmp.dirSync({ unsafeCleanup: true }).name;

    const audioPath = path.join(workDir, "audio.mp3");
    const img1Path = path.join(workDir, "img1.png");
    const img2Path = path.join(workDir, "img2.png");
    const img3Path = path.join(workDir, "img3.png");
    const endPath = path.join(workDir, "end.png");
    const assPath = path.join(workDir, "captions.ass");
    const outPath = path.join(workDir, "out.mp4");

    // downloads
    await downloadToFile(audio_url, audioPath);
    await downloadToFile(images[0], img1Path);
    await downloadToFile(images[1], img2Path);
    await downloadToFile(images[2], img3Path);
    await downloadToFile(end_card_url, endPath);

    // Determine audio duration (ms) via ffprobe
    const { stdout: probeOut } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      audioPath,
    ]);
    const audioSeconds = parseFloat(probeOut.trim());
    const audioMs = Number.isFinite(audioSeconds) ? Math.round(audioSeconds * 1000) : 0;
    if (!audioMs) throw new Error("Could not determine audio duration");

    // Keep your existing timing logic (already working) and ensure captions exactly match audio length
    const finalCaptions = sanitizeAndScaleCaptions(captions, audioMs);

    // Video settings
    const w = Number(video.width || 1080);
    const h = Number(video.height || 1920);
    const fps = Number(video.fps || 30);

    // Slideshow segment durations
    const seg1 = Math.floor(audioMs / 3);
    const seg2 = Math.floor(audioMs / 3);
    const seg3 = audioMs - seg1 - seg2;

    // ---- SUBTITLE DOCK SETTINGS (bottom 25%) ----
    const dockH = Math.round(h * 0.25);
    const dockY = h - dockH;
    const padX = Math.round(w * 0.06); // safe padding left/right
    const padV = Math.round(dockH * 0.14); // safe padding from bottom inside dock

    // Make font very small + enforce 2 lines via pre-wrapping
    const fontSize = clamp(Math.round(h * 0.015), 18, 26); // small on 1080x1920
    const maxCharsPerLine = 26;

    // Build ASS file so styling/positioning is reliable and confined
    const assLines = [];

    assLines.push("[Script Info]");
    assLines.push("ScriptType: v4.00+");
    assLines.push(`PlayResX: ${w}`);
    assLines.push(`PlayResY: ${dockH}`);
    assLines.push("WrapStyle: 2");
    assLines.push("ScaledBorderAndShadow: yes");
    assLines.push("");

    assLines.push("[V4+ Styles]");
    assLines.push(
      "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding"
    );

    // BorderStyle=1 with outline; dock bg provides the “subtitle dock”
    assLines.push(
      `Style: Default,Arial,${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,2,0,2,${padX},${padX},${padV},1`
    );
    assLines.push("");

    assLines.push("[Events]");
    assLines.push("Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text");

    for (const c of finalCaptions) {
      const start = msToAssTime(c.start_ms);
      const end = msToAssTime(c.end_ms);

      const wrapped = wrapToTwoLines(c.text, maxCharsPerLine);
      const safeText = escapeAssText(wrapped);

      if (!safeText) continue;

      // Dialogue line
      assLines.push(`Dialogue: 0,${start},${end},Default,,0,0,0,,${safeText}`);
    }

    fs.writeFileSync(assPath, assLines.join("\n"), "utf8");

    // ---- ffmpeg filtergraph ----
    // Key idea: render subtitles onto a dedicated dock canvas sized (w x dockH),
    // then overlay it at y = dockY so subtitles can NEVER escape the bottom 25%.
    const assEsc = escapeFilterPath(assPath);

    const filter = [
      // scale/pad images to 9:16
      `[0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1[v0]`,
      `[1:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1[v1]`,
      `[2:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1[v2]`,
      `[3:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1[v3]`,

      // concat 3 images into slideshow for exactly the audio duration
      `[v0]trim=duration=${seg1 / 1000},setpts=PTS-STARTPTS[a0]`,
      `[v1]trim=duration=${seg2 / 1000},setpts=PTS-STARTPTS[a1]`,
      `[v2]trim=duration=${seg3 / 1000},setpts=PTS-STARTPTS[a2]`,
      `[a0][a1][a2]concat=n=3:v=1:a=0[base]`,

      // Create subtitle dock canvas (bottom 25% only), render ASS onto it
      `color=c=black@0.35:s=${w}x${dockH}:r=${fps}:d=${(audioMs / 1000).toFixed(3)}[dockbg]`,
      `[dockbg]subtitles=${assEsc}[docksub]`,

      // Overlay dock onto base at the bottom
      `[base][docksub]overlay=0:${dockY}:format=auto[base_sub]`,

      // End card fixed duration
      `[v3]trim=duration=${Number(end_card_duration_ms) / 1000},setpts=PTS-STARTPTS[endcard]`,

      // concat base_sub + end card
      `[base_sub][endcard]concat=n=2:v=1:a=0[vout]`,
    ].join(";");

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
