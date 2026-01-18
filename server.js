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
    const txt = String(c?.text || "").replace(/\s+/g, " ").trim();
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

function assTime(ms) {
  const t = Math.max(0, Math.round(Number(ms) || 0));
  const cs = Math.floor((t % 1000) / 10);
  const totalS = Math.floor(t / 1000);
  const s = totalS % 60;
  const m = Math.floor(totalS / 60) % 60;
  const h = Math.floor(totalS / 3600);
  const pad2 = (n) => String(n).padStart(2, "0");
  return `${h}:${pad2(m)}:${pad2(s)}.${pad2(cs)}`;
}

function escAssText(t) {
  return String(t || "")
    .replace(/\r\n/g, " ")
    .replace(/\r/g, " ")
    .replace(/\n/g, " ")
    .replace(/{/g, "\\{")
    .replace(/}/g, "\\}");
}

function wrapToLines(text, maxCharsPerLine, maxLines) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return [];
  const words = t.split(" ");
  const lines = [];
  let line = "";

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const cand = line ? `${line} ${w}` : w;

    if (cand.length <= maxCharsPerLine) {
      line = cand;
      continue;
    }

    if (line) {
      lines.push(line);
      line = w;
    } else {
      // single word longer than max: hard cut
      lines.push(w.slice(0, maxCharsPerLine));
      line = w.slice(maxCharsPerLine);
    }

    if (maxLines && lines.length >= maxLines) {
      // no shortening requested; just keep the remaining words on the last line(s)
      // We will keep appending to the last line even if it exceeds maxCharsPerLine
      // to avoid ellipsis and preserve full text.
      const rest = words.slice(i + 1).join(" ");
      if (rest) {
        lines[lines.length - 1] = `${lines[lines.length - 1]} ${line} ${rest}`.replace(/\s+/g, " ").trim();
        line = "";
      }
      break;
    }
  }

  if (line) lines.push(line);
  return lines;
}

function buildAss({ w, h, captions }) {
  // Default captions (bottom dock)
  const marginLR = Math.round(w * 0.10); // 10% left/right margins
  const marginV = Math.round(h * 0.16); // bottom captions placement (from bottom)

  // Title (Segment 1) big + bold
  const titleFontSize = 100;
  const titleOutline = 5;

  // CHANGE #1: vertical placement for Title using MarginV (no \pos)
  const titleMarginV = Math.round(h * 0.34);

  // Default captions wrapping
  const maxCharsPerLine = 26;
  const maxLines = 3;

  // Title wrapping (tighter to avoid clipping at large font)
  const titleMaxCharsPerLine = 18;
  const titleMaxLines = 3;

  const outline = 3;

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${w}
PlayResY: ${h}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Default,DejaVu Sans,40,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,${outline},0,2,${marginLR},${marginLR},${marginV},1
Style: Title,DejaVu Sans,${titleFontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,${titleOutline},0,8,${marginLR},${marginLR},${titleMarginV},1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
`;

  const lines = [];
  for (let i = 0; i < captions.length; i++) {
    const c = captions[i];
    const start = assTime(c.start_ms);
    const end = assTime(c.end_ms);

    const raw = escAssText(c.text);

    if (i === 0) {
      const titleLines = wrapToLines(raw, titleMaxCharsPerLine, titleMaxLines);
      const titleText = titleLines.join("\\N");
      // CHANGE #2: no \pos override for Title (use alignment + margins only)
      lines.push(`Dialogue: 1,${start},${end},Title,,0,0,0,,${titleText}`);
    } else {
      const bodyLines = wrapToLines(raw, maxCharsPerLine, maxLines);
      const bodyText = bodyLines.join("\\N");
      lines.push(`Dialogue: 1,${start},${end},Default,,0,0,0,,${bodyText}`);
    }
  }

  return header + lines.join("\n") + "\n";
}

function escFilterPath(p) {
  // for ffmpeg filter strings in single quotes
  return String(p).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
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

    // === CHANGE: image timing based on segment 1 duration ===
    // Image 1 lasts exactly as long as caption segment 1.
    // Images 2 and 3 split the remaining duration equally.
    let seg1 = 0;
    if (scaledCaptions.length >= 1 && Number.isFinite(Number(scaledCaptions[0].end_ms))) {
      seg1 = Math.max(0, Math.round(Number(scaledCaptions[0].end_ms)));
    } else {
      seg1 = Math.floor(effectiveAudioMs / 3);
    }
    seg1 = Math.min(seg1, effectiveAudioMs);

    const remaining = Math.max(0, effectiveAudioMs - seg1);
    const seg2 = Math.floor(remaining / 2);
    const seg3 = Math.max(0, remaining - seg2);
    // ================================================

    const ass = buildAss({ w, h, captions: scaledCaptions });
    fs.writeFileSync(assPath, ass, "utf8");

    const coverCrop = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=${fps},format=yuv420p`;

    const subsFilter = `subtitles='${escFilterPath(assPath)}'`;

    const filterParts = [
      `[0:v]${coverCrop}[v0]`,
      `[1:v]${coverCrop}[v1]`,
      `[2:v]${coverCrop}[v2]`,
      `[3:v]${coverCrop}[v3]`,

      `[v0]trim=duration=${(seg1 / 1000).toFixed(3)},setpts=PTS-STARTPTS[s0]`,
      `[v1]trim=duration=${(seg2 / 1000).toFixed(3)},setpts=PTS-STARTPTS[s1]`,
      `[v2]trim=duration=${(seg3 / 1000).toFixed(3)},setpts=PTS-STARTPTS[s2]`,
      `[s0][s1][s2]concat=n=3:v=1:a=0[slideshow]`,

      `[slideshow]${subsFilter}[subbed]`,

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
