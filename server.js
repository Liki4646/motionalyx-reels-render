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

function wrapToTwoLines(text, maxCharsPerLine = 30) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  if (t.length <= maxCharsPerLine) return t;

  const words = t.split(" ");
  let line1 = "";
  let i = 0;

  while (i < words.length) {
    const cand = line1 ? `${line1} ${words[i]}` : words[i];
    if (cand.length <= maxCharsPerLine) {
      line1 = cand;
      i += 1;
    } else {
      break;
    }
  }

  if (!line1) return t.slice(0, maxCharsPerLine - 1) + "…";

  const rest = words.slice(i).join(" ").trim();
  if (!rest) return line1;

  let line2 = rest;
  if (line2.length > maxCharsPerLine) {
    line2 = line2.slice(0, maxCharsPerLine - 1).trimEnd() + "…";
  }

  return `${line1}\n${line2}`;
}

function normalizeAndScaleCaptions(captions, audioMs) {
  if (!Array.isArray(captions)) return [];

  const items = [];
  for (const c of captions) {
    const start = Number(c?.start_ms);
    const end = Number(c?.end_ms);
    const txt = String(c?.text || "").trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !txt) continue;
    items.push({
      start_ms: start,
      end_ms: end,
      dur_ms: end - start,
      text: txt
    });
  }

  if (items.length === 0) return [];

  if (!Number.isFinite(audioMs) || audioMs <= 0) {
    const sanitized = [];
    let cur = 0;
    for (const it of items) {
      const dur = Math.max(1, Math.round(it.dur_ms));
      const start_ms = cur;
      const end_ms = start_ms + dur;
      sanitized.push({ start_ms, end_ms, text: it.text });
      cur = end_ms;
    }
    return sanitized;
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
    const sd = Math.max(minSegMs, Math.round(d * factor));
    return { text: it.text, dur_ms: sd };
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
    const under = audioMs - sum;
    scaled[scaled.length - 1].dur_ms += under;
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
    const srtPath = path.join(workDir, "captions.srt");
    const outPath = path.join(workDir, "out.mp4");

    await downloadToFile(audio_url, audioPath);
    await downloadToFile(images[0], img1Path);
    await downloadToFile(images[1], img2Path);
    await downloadToFile(images[2], img3Path);
    await downloadToFile(end_card_url, endPath);

    // Probe audio duration (ms)
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
      if (Number.isFinite(audioSeconds) && audioSeconds > 0) {
        audioMs = Math.round(audioSeconds * 1000);
      }
    } catch (_e) {
      audioMs = NaN;
    }

    const w = Number(video.width || 1080);
    const h = Number(video.height || 1920);
    const fps = Number(video.fps || 30);

    // Normalize + scale captions to match audio duration (KEEP AS-IS)
    const scaledCaptions = normalizeAndScaleCaptions(captions, audioMs);

    // Write SRT (max 2 lines)
    const srtLines = [];
    let idx = 1;
    for (const c of scaledCaptions) {
      const start = Number(c.start_ms);
      const end = Number(c.end_ms);
      const wrapped = wrapToTwoLines(c.text, 30);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !wrapped) continue;

      srtLines.push(String(idx++));
      srtLines.push(`${msToSrtTime(start)} --> ${msToSrtTime(end)}`);
      srtLines.push(wrapped);
      srtLines.push("");
    }
    fs.writeFileSync(srtPath, srtLines.join("\n"), "utf8");

    // If audio duration missing, approximate from captions end
    let effectiveAudioMs = audioMs;
    if (!Number.isFinite(effectiveAudioMs) || effectiveAudioMs <= 0) {
      const lastEnd = scaledCaptions.length ? Number(scaledCaptions[scaledCaptions.length - 1].end_ms) : 0;
      effectiveAudioMs = Number.isFinite(lastEnd) && lastEnd > 0 ? Math.round(lastEnd) : 15000;
    }

    // Slideshow durations
    const seg1 = Math.floor(effectiveAudioMs / 3);
    const seg2 = Math.floor(effectiveAudioMs / 3);
    const seg3 = Math.max(0, effectiveAudioMs - seg1 - seg2);

    // COVER + CROP to 9:16 for all images (Solution A stays)
    const coverCropRGBA = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=${fps},format=rgba`;
    const coverCropYUV = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=${fps},format=yuv420p`;

    // ---- Subtitle rendering locked to bottom 25% via separate layer ----
    const dockH = Math.round(h * 0.25);
    const dockY = h - dockH;

    // Padding inside dock
    const padLR = Math.round(w * 0.07); // 7% width
    const padBottom = Math.round(dockH * 0.14); // bottom padding within dock
    const padTop = Math.round(dockH * 0.10); // top breathing room within dock (by limiting font size)

    // Font sizing based on dock height (not whole video) + hard caps
    // Goal: predictable physical size on 1080x1920
    const fontMin = 24;
    const fontMax = 52;
    const fontBase = Math.round(dockH * 0.14); // ~14% of dock height
    const fontSize = Math.max(fontMin, Math.min(fontMax, fontBase));

    // Moderate line spacing (libass "Spacing" is extra spacing between glyphs, not line-height; keep small)
    // We'll rely on font size + 2-line max to keep within dock.
    const outline = 2;

    // Escape SRT path for ffmpeg subtitles filter
    const srtEsc = srtPath.replace(/\\/g, "\\\\").replace(/:/g, "\\:");

    // Use original_size to prevent libass PlayRes scaling surprises
    // Render subtitles onto a transparent layer sized (w x dockH), then overlay at y=dockY.
    const subtitleStyle = [
      `FontName=Arial`,
      `FontSize=${fontSize}`,
      `PrimaryColour=&H00FFFFFF`,
      `OutlineColour=&H00000000`,
      `BorderStyle=1`,
      `Outline=${outline}`,
      `Shadow=0`,
      `Alignment=2`, // bottom-center within the DOCK layer
      `MarginV=${padBottom}`,
      `MarginL=${padLR}`,
      `MarginR=${padLR}`
    ].join(",");

    // ffmpeg filtergraph
    const filter = [
      // Prepare 3 images as RGBA
      `[0:v]${coverCropRGBA}[v0]`,
      `[1:v]${coverCropRGBA}[v1]`,
      `[2:v]${coverCropRGBA}[v2]`,

      // End card as YUV (no subtitles)
      `[3:v]${coverCropYUV}[vend]`,

      // Slideshow concat (RGBA)
      `[v0]trim=duration=${seg1 / 1000},setpts=PTS-STARTPTS[s0]`,
      `[v1]trim=duration=${seg2 / 1000},setpts=PTS-STARTPTS[s1]`,
      `[v2]trim=duration=${seg3 / 1000},setpts=PTS-STARTPTS[s2]`,
      `[s0][s1][s2]concat=n=3:v=1:a=0[slideshow_rgba]`,

      // Build transparent subtitle layer locked to dock size
      `color=c=black@0.0:s=${w}x${dockH}:r=${fps},format=rgba[subbase]`,

      // Burn subtitles onto the dock layer (NOT the full frame)
      `[subbase]subtitles=${srtEsc}:original_size=${w}x${dockH}:force_style='${subtitleStyle}'[subdock]`,

      // Overlay dock subtitles onto slideshow at y=dockY, then convert to yuv for final concat
      `[slideshow_rgba][subdock]overlay=x=0:y=${dockY}:format=auto[subbed_rgba]`,
      `[subbed_rgba]format=yuv420p[subbed_yuv]`,

      // End card fixed duration (YUV)
      `[vend]trim=duration=${Number(end_card_duration_ms) / 1000},setpts=PTS-STARTPTS[endcard_yuv]`,

      // Concat slideshow(with subs) + end card
      `[subbed_yuv][endcard_yuv]concat=n=2:v=1:a=0[vout]`
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
