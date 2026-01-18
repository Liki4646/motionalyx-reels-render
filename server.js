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

function assEscape(t) {
  // Keep captions “natural” (no forced newlines), just escape ASS control chars.
  // Also remove real line breaks to avoid any \n/\N weirdness.
  return String(t || "")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\\/g, "\\\\")
    .replace(/{/g, "\\{")
    .replace(/}/g, "\\}");
}

function wrapByChars(text, maxCharsPerLine, maxLines) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return "";

  const words = t.split(" ");
  const lines = [];
  let cur = "";

  for (const w of words) {
    const cand = cur ? `${cur} ${w}` : w;

    if (cand.length <= maxCharsPerLine) {
      cur = cand;
      continue;
    }

    if (cur) lines.push(cur);
    cur = w;

    if (lines.length >= maxLines - 1) break;
  }

  // Push the last line
  if (cur && lines.length < maxLines) {
    // If we broke early because we hit maxLines, append the rest to the last line
    const usedWords = lines.join(" ").split(" ").filter(Boolean).length + cur.split(" ").filter(Boolean).length;
    const remaining = words.slice(usedWords).join(" ").trim();
    if (remaining) {
      // Try to fit remaining into existing last line by wrapping again
      let last = cur;
      const restWords = remaining.split(" ");
      for (const w of restWords) {
        const cand = `${last} ${w}`;
        if (cand.length <= maxCharsPerLine) last = cand;
        else break;
      }
      cur = last;
    }
    lines.push(cur);
  }

  // If still somehow empty, fallback
  if (!lines.length) return t;

  // ASS newline is \N
  return lines.join("\\N");
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
    const assPath = path.join(workDir, "subs.ass");
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

    // === SLIDES TIMING (as you requested earlier): image 1 lasts exactly segment 1 ===
    const seg1Ms = scaledCaptions.length ? Math.max(1, Math.round(Number(scaledCaptions[0].end_ms))) : Math.floor(effectiveAudioMs / 3);
    const remaining = Math.max(0, effectiveAudioMs - seg1Ms);
    const seg2Ms = Math.floor(remaining / 2);
    const seg3Ms = Math.max(0, remaining - seg2Ms);

    const seg1 = seg1Ms;
    const seg2 = seg2Ms;
    const seg3 = seg3Ms;
    // ============================================================================

    const coverCrop = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=${fps},format=yuv420p`;

    // =========================
    // SUBTITLE STYLES (ASS)
    // Change requested:
    // - Segment 1 font size +50%
    // - All other segments: same size + boldness as old Segment 1
    // - Keep margins (10% L/R), avoid overflow by wrapping with more lines
    // =========================

    // Segment 1 (Title)
    const titleFontSize = 150; // was 100, now +50%
    const titleOutline = 5;

    // Other segments (Caption): match old Segment 1 look (100 + bold)
    const captionFontSize = 100; // match old title size
    const captionOutline = 5;

    const marginLR = Math.round(w * 0.10); // 10% left/right
    const marginV = Math.round(h * 0.16); // bottom captions placement (same behavior as before)

    // Title vertical placement (top-center aligned, margin from top)
    const titleMarginV = Math.round(h * 0.34);

    // Wrapping limits to avoid going past left/right edges
    // (bigger fonts => fewer chars per line, allow more lines)
    const titleMaxCharsPerLine = 16;
    const titleMaxLines = 4;

    const capMaxCharsPerLine = 22;
    const capMaxLines = 4;

    const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${w}
PlayResY: ${h}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Title,DejaVu Sans,${titleFontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,${titleOutline},0,8,${marginLR},${marginLR},${titleMarginV},1
Style: Caption,DejaVu Sans,${captionFontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,${captionOutline},0,2,${marginLR},${marginLR},${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

    function msToAssTime(ms) {
      const t = Math.max(0, Number(ms) || 0);
      const cs = Math.floor(t / 10); // centiseconds
      const hh = Math.floor(cs / 360000);
      const mm = Math.floor((cs % 360000) / 6000);
      const ss = Math.floor((cs % 6000) / 100);
      const cc = cs % 100;
      const pad2 = (n) => String(n).padStart(2, "0");
      return `${hh}:${pad2(mm)}:${pad2(ss)}.${pad2(cc)}`;
    }

    let ass = header;

    for (let i = 0; i < scaledCaptions.length; i++) {
      const c = scaledCaptions[i];
      const start = msToAssTime(c.start_ms);
      const end = msToAssTime(c.end_ms);

      if (i === 0) {
        const raw = assEscape(c.text);
        const wrapped = wrapByChars(raw, titleMaxCharsPerLine, titleMaxLines);
        // No \pos overrides; style alignment + margins handle placement
        ass += `Dialogue: 0,${start},${end},Title,,0,0,0,,${wrapped}\n`;
      } else {
        const raw = assEscape(c.text);
        const wrapped = wrapByChars(raw, capMaxCharsPerLine, capMaxLines);
        ass += `Dialogue: 0,${start},${end},Caption,,0,0,0,,${wrapped}\n`;
      }
    }

    fs.writeFileSync(assPath, ass, "utf8");

    const filterParts = [
      `[0:v]${coverCrop}[v0]`,
      `[1:v]${coverCrop}[v1]`,
      `[2:v]${coverCrop}[v2]`,
      `[3:v]${coverCrop}[v3]`,

      `[v0]trim=duration=${(seg1 / 1000).toFixed(3)},setpts=PTS-STARTPTS[s0]`,
      `[v1]trim=duration=${(seg2 / 1000).toFixed(3)},setpts=PTS-STARTPTS[s1]`,
      `[v2]trim=duration=${(seg3 / 1000).toFixed(3)},setpts=PTS-STARTPTS[s2]`,
      `[s0][s1][s2]concat=n=3:v=1:a=0[slideshow]`,

      // Burn-in ASS subtitles
      `[slideshow]ass=${assPath.replace(/\\/g, "\\\\")}[subbed]`,

      `[v3]trim=duration=${(Number(end_card_duration_ms) / 1000).toFixed(3)},setpts=PTS-STARTPTS[endcard]`,
      `[subbed][endcard]concat=n=2:v=1:a=0[vout]`
    ];

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
