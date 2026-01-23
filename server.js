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
  const r = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "Mozilla/5.0 (MotionalyxRenderBot)" }
  });
  if (!r.ok) throw new Error(`Download failed ${r.status}: ${url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(outPath, buf);
}

function ensureArray(val, name) {
  if (!Array.isArray(val)) throw new Error(`${name} must be an array`);
}

function assEscape(t) {
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

  if (cur && lines.length < maxLines) {
    const usedWords =
      lines.join(" ").split(" ").filter(Boolean).length +
      cur.split(" ").filter(Boolean).length;
    const remaining = words.slice(usedWords).join(" ").trim();
    if (remaining) {
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

  if (!lines.length) return t;
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
    end_card_audio_url,
    video = { width: 1080, height: 1920, fps: 30 }
  } = req.body || {};

  try {
    if (!audio_url) throw new Error("audio_url is required");
    if (!end_card_url) throw new Error("end_card_url is required");
    ensureArray(images, "images");
    if (images.length !== 4) throw new Error("images must have exactly 4 URLs");
    ensureArray(captions, "captions");

    const workDir = tmp.dirSync({ unsafeCleanup: true }).name;

    const img1Path = path.join(workDir, "img1.png");
    const img2Path = path.join(workDir, "img2.png");
    const img3Path = path.join(workDir, "img3.png");
    const img4Path = path.join(workDir, "img4.png");
    const endPath = path.join(workDir, "end.png");

    const audioPath = path.join(workDir, "audio.mp3");
    const assPath = path.join(workDir, "subs.ass");
    const outPath = path.join(workDir, "out.mp4");

    const sloganMp3Path = path.join(workDir, "end_card_audio.mp3");
    const sloganWavPath = path.join(workDir, "end_card_audio.wav");

    const sloganUrl = (end_card_audio_url && String(end_card_audio_url).trim()) || "";
    let hasEndCardAudio = Boolean(sloganUrl);

    console.log("[render] has end_card_audio_url:", hasEndCardAudio ? "YES" : "NO");
    if (hasEndCardAudio) console.log("[render] end_card_audio_url:", sloganUrl);

    await downloadToFile(images[0], img1Path);
    await downloadToFile(images[1], img2Path);
    await downloadToFile(images[2], img3Path);
    await downloadToFile(images[3], img4Path);
    await downloadToFile(end_card_url, endPath);
    await downloadToFile(audio_url, audioPath);

    if (hasEndCardAudio) {
      await downloadToFile(sloganUrl, sloganMp3Path);

      const mp3Size = fs.existsSync(sloganMp3Path) ? fs.statSync(sloganMp3Path).size : 0;
      console.log("[render] slogan mp3 bytes:", mp3Size);

      if (mp3Size < 1500) {
        console.log("[render] slogan mp3 seems too small -> skipping end card audio");
        hasEndCardAudio = false;
      } else {
        try {
          await execFileAsync("ffmpeg", [
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            sloganMp3Path,
            "-ac",
            "1",
            "-ar",
            "24000",
            "-c:a",
            "pcm_s16le",
            sloganWavPath
          ]);

          const wavSize = fs.existsSync(sloganWavPath) ? fs.statSync(sloganWavPath).size : 0;
          console.log("[render] slogan wav bytes:", wavSize);

          if (wavSize < 3000) {
            console.log("[render] slogan wav too small -> skipping end card audio");
            hasEndCardAudio = false;
          }
        } catch (e) {
          console.log("[render] slogan re-encode failed -> skipping end card audio:", String(e?.message || e));
          hasEndCardAudio = false;
        }
      }
    }

    // Probe main audio duration
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

    // =============================
    // SLIDES TIMING (SEGMENT-DRIVEN)
    // seg1=img1, seg2+3=img2, seg4+5=img3, seg6+7=img4
    // =============================
    let seg1 = 0,
      seg2 = 0,
      seg3 = 0,
      seg4 = 0;

    if (scaledCaptions.length >= 7) {
      const t1 = Math.round(Number(scaledCaptions[0].end_ms));
      const t3 = Math.round(Number(scaledCaptions[2].end_ms));
      const t5 = Math.round(Number(scaledCaptions[4].end_ms));
      const t7 = Math.round(Number(scaledCaptions[6].end_ms));

      seg1 = Math.max(1, t1);
      seg2 = Math.max(1, t3 - t1);
      seg3 = Math.max(1, t5 - t3);
      seg4 = Math.max(1, t7 - t5);

      effectiveAudioMs = Math.max(effectiveAudioMs, t7);
    } else {
      const part = Math.floor(effectiveAudioMs / 4);
      seg1 = Math.max(1, part);
      seg2 = Math.max(1, part);
      seg3 = Math.max(1, part);
      seg4 = Math.max(1, effectiveAudioMs - seg1 - seg2 - seg3);
    }

    // Faster crossfade
    const fadeMs = 100;
    const fadeSec = (fadeMs / 1000).toFixed(3);

    // Extend first 3 inputs by fade to allow overlap in xfade
    const seg1In = seg1 + fadeMs;
    const seg2In = seg2 + fadeMs;
    const seg3In = seg3 + fadeMs;
    const seg4In = seg4;

    const seg1Sec = seg1 / 1000;
    const seg2Sec = seg2 / 1000;
    const seg3Sec = seg3 / 1000;

    const slideshowMs = Math.max(1, Math.round(seg1 + seg2 + seg3 + seg4));
    const endCardDurMs = Math.max(0, Math.round(Number(end_card_duration_ms) || 0));
    const totalMs = slideshowMs + endCardDurMs;

    const off1 = (seg1Sec - fadeMs / 1000).toFixed(3);
    const off2 = (seg1Sec + seg2Sec - fadeMs / 1000).toFixed(3);
    const off3 = (seg1Sec + seg2Sec + seg3Sec - fadeMs / 1000).toFixed(3);

    // =========================
    // SUBTITLE STYLES (ASS)
    // Title: NO box
    // Caption: semi-transparent grey background box that auto-sizes to text
    // =========================
    const titleFontSize = 150;
    const titleOutline = 5;

    const captionFontSize = 100;
    const captionOutlineForStroke = 3;

    const marginLR = Math.round(w * 0.10);
    const marginV = Math.round(h * 0.16);
    const titleMarginV = Math.round(h * 0.34);

    const titleMaxCharsPerLine = 12;
    const titleMaxLines = 6;

    const capMaxCharsPerLine = 18;
    const capMaxLines = 5;

    // Caption box: BackColour uses &HAABBGGRR (AA alpha; 00 opaque, FF transparent)
    const capBoxAlpha = "80"; // ~50% transparent
    const capBoxGrayBGR = "141414"; // dark gray
    const capBackColour = `&H${capBoxAlpha}${capBoxGrayBGR}`;
    const capBoxPadding = 18; // padding around text (BorderStyle=3 uses Outline as padding)
    const capShadow = 0; // keep crisp; can set to 2 if you want extra softness

    const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${w}
PlayResY: ${h}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Title,DejaVu Sans,${titleFontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,${titleOutline},0,8,${marginLR},${marginLR},${titleMarginV},1
Style: Caption,DejaVu Sans,${captionFontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,${capBackColour},-1,0,0,0,100,100,0,0,3,${capBoxPadding},${capShadow},2,${marginLR},${marginLR},${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

    function msToAssTime(ms) {
      const t = Math.max(0, Number(ms) || 0);
      const cs = Math.floor(t / 10);
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
        ass += `Dialogue: 0,${start},${end},Title,,0,0,0,,${wrapped}\n`;
      } else {
        const raw = assEscape(c.text);
        const wrapped = wrapByChars(raw, capMaxCharsPerLine, capMaxLines);

        // Keep text stroke (OutlineColour) + box (BackColour). In BorderStyle=3, Outline is padding.
        // If you ever want a tiny stroke around letters, add an inline override:
        // {\\bord3} ... but we keep it simple for now.

        ass += `Dialogue: 0,${start},${end},Caption,,0,0,0,,${wrapped}\n`;
      }
    }

    fs.writeFileSync(assPath, ass, "utf8");

    // ==========================================================
    // VIDEO MOTION (ONLY ZOOM, NO DRIFT) — FFmpeg 5.1 compatible
    // Increase motion on images 2/3/4 (more zoom).
    // ==========================================================
    const baseScale = 1.32;
    const baseW = Math.ceil((w * baseScale) / 2) * 2;
    const baseH = Math.ceil((h * baseScale) / 2) * 2;

    const hookZoomDelta = 0.14; // hook
    const midZoomDelta = 0.12; // increased motion for images 2/3/4

    function zoompanOnlyZoom(tagIn, tagOut, durMs, zoomDelta) {
      const frames = Math.max(2, Math.round((durMs / 1000) * fps));
      const denom = Math.max(1, frames - 1);

      const z = `1+(${zoomDelta})*(on/${denom})`;
      const x = `(iw-ow)/2`;
      const y = `(ih-oh)/2`;

      return (
        `[${tagIn}]` +
        `scale=${baseW}:${baseH}:force_original_aspect_ratio=increase:flags=lanczos,setsar=1,` +
        `zoompan=z='${z}':x='${x}':y='${y}':d=${frames}:s=${w}x${h}:fps=${fps},` +
        `trim=duration=${(durMs / 1000).toFixed(3)},setpts=PTS-STARTPTS,format=yuv420p` +
        `[${tagOut}]`
      );
    }

    const endCover = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=${fps},format=yuv420p`;

    const filterParts = [
      zoompanOnlyZoom("0:v", "s0", seg1In, hookZoomDelta),
      zoompanOnlyZoom("1:v", "s1", seg2In, midZoomDelta),
      zoompanOnlyZoom("2:v", "s2", seg3In, midZoomDelta),
      zoompanOnlyZoom("3:v", "s3", seg4In, midZoomDelta),

      `[s0][s1]xfade=transition=fade:duration=${fadeSec}:offset=${off1}[x01]`,
      `[x01][s2]xfade=transition=fade:duration=${fadeSec}:offset=${off2}[x012]`,
      `[x012][s3]xfade=transition=fade:duration=${fadeSec}:offset=${off3}[slideshow]`,

      `[slideshow]ass=${assPath.replace(/\\/g, "\\\\")}[subbed]`,

      // No grain/noise
      `[subbed]format=yuv420p[styled]`,

      `[4:v]${endCover}[v4]`,
      `[v4]trim=duration=${(endCardDurMs / 1000).toFixed(3)},setpts=PTS-STARTPTS[endcard]`,

      `[styled][endcard]concat=n=2:v=1:a=0[vout]`
    ];

    // -------------------------
    // AUDIO
    // -------------------------
    const endCardStartSec = slideshowMs / 1000;
    const totalDurSec = totalMs / 1000;

    const sloganStartSec = endCardStartSec + 0.2;
    const sloganDelayMs = Math.max(0, Math.round(sloganStartSec * 1000));

    filterParts.push(
      `[5:a]asetpts=PTS-STARTPTS,` +
        `atrim=0:${endCardStartSec.toFixed(3)},` +
        `apad=pad_dur=${(endCardDurMs / 1000 + 2).toFixed(3)},` +
        `atrim=0:${totalDurSec.toFixed(3)}[amain]`
    );

    if (hasEndCardAudio) {
      const fadeIn = 0.12;
      filterParts.push(
        `[6:a]asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${fadeIn},volume=1.35,adelay=${sloganDelayMs}|${sloganDelayMs}[aslogan]`,
        `[amain][aslogan]amix=inputs=2:duration=longest:normalize=0[aout]`,
        `[aout]atrim=0:${totalDurSec.toFixed(3)}[aout2]`
      );
    } else {
      filterParts.push(`[amain]atrim=0:${totalDurSec.toFixed(3)}[aout2]`);
    }

    const filter = filterParts.join(";");

    const args = [
      "-y",

      "-loop",
      "1",
      "-t",
      (seg1In / 1000).toFixed(3),
      "-i",
      img1Path,

      "-loop",
      "1",
      "-t",
      (seg2In / 1000).toFixed(3),
      "-i",
      img2Path,

      "-loop",
      "1",
      "-t",
      (seg3In / 1000).toFixed(3),
      "-i",
      img3Path,

      "-loop",
      "1",
      "-t",
      (seg4In / 1000).toFixed(3),
      "-i",
      img4Path,

      "-loop",
      "1",
      "-t",
      (endCardDurMs / 1000).toFixed(3),
      "-i",
      endPath,

      "-i",
      audioPath
    ];

    if (hasEndCardAudio) {
      args.push("-i", sloganWavPath);
    }

    args.push(
      "-filter_complex",
      filter,

      "-map",
      "[vout]",
      "-map",
      "[aout2]",

      "-r",
      String(fps),

      // FAST encode
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "23",
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
    );

    console.log("[render] ffmpeg args:", args.join(" "));
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
