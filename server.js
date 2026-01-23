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
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !txt)
      continue;
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
      const lastEnd = scaledCaptions.length
        ? Number(scaledCaptions[scaledCaptions.length - 1].end_ms)
        : 0;
      effectiveAudioMs = Number.isFinite(lastEnd) && lastEnd > 0 ? Math.round(lastEnd) : 15000;
    }

    // =============================
    // SLIDES TIMING (SEGMENT-DRIVEN)
    // 7 segments:
    // - img1 = seg1
    // - img2 = seg2+seg3
    // - img3 = seg4+seg5
    // - img4 = seg6+seg7
    // =============================
    let seg1 = 0,
      seg2 = 0,
      seg3 = 0,
      seg4 = 0;

    if (scaledCaptions.length >= 7) {
      const t1 = Math.round(Number(scaledCaptions[0].end_ms)); // end seg1
      const t3 = Math.round(Number(scaledCaptions[2].end_ms)); // end seg3
      const t5 = Math.round(Number(scaledCaptions[4].end_ms)); // end seg5
      const t7 = Math.round(Number(scaledCaptions[6].end_ms)); // end seg7

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

    // Faster crossfade + fewer heavy ops => faster render
    const fadeMs = 100;
    const fadeSec = (fadeMs / 1000).toFixed(3);

    // Extend first 3 sources by fade to allow overlap, keep total duration unchanged
    const seg1In = seg1 + fadeMs;
    const seg2In = seg2 + fadeMs;
    const seg3In = seg3 + fadeMs;
    const seg4In = seg4;

    const seg1Sec = seg1 / 1000;
    const seg2Sec = seg2 / 1000;
    const seg3Sec = seg3 / 1000;
    const seg4Sec = seg4 / 1000;

    const slideshowMs = Math.max(1, Math.round(seg1 + seg2 + seg3 + seg4));
    const endCardDurMs = Math.max(0, Math.round(Number(end_card_duration_ms) || 0));
    const totalMs = slideshowMs + endCardDurMs;

    // Offsets for xfade (use true boundaries)
    const off1 = (seg1Sec).toFixed(3);
    const off2 = (seg1Sec + seg2Sec).toFixed(3);
    const off3 = (seg1Sec + seg2Sec + seg3Sec).toFixed(3);

    // =========================
    // SUBTITLE STYLES (ASS)
    // =========================
    const titleFontSize = 150;
    const titleOutline = 5;

    const captionFontSize = 100;
    const captionOutline = 3;

    const marginLR = Math.round(w * 0.10);
    const marginV = Math.round(h * 0.16);
    const titleMarginV = Math.round(h * 0.34);

    const titleMaxCharsPerLine = 12;
    const titleMaxLines = 6;

    const capMaxCharsPerLine = 18;
    const capMaxLines = 5;

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
        ass += `Dialogue: 0,${start},${end},Caption,,0,0,0,,${wrapped}\n`;
      }
    }

    fs.writeFileSync(assPath, ass, "utf8");

    // ==========================================================
    // FILTER COMPLEX (FAST VERSION)
    // - Ken Burns via animated crop (faster than zoompan)
    // - Hook has stronger push-in
    // - Crossfade 0.10s
    // - Subtle grain ONLY (no vignette) on slideshow
    // - End card remains static (no grain)
    // ==========================================================
    const baseScale = 1.18; // enough room for zoom + micro-pan, but lighter than 1.25
    const baseW = Math.ceil(w * baseScale);
    const baseH = Math.ceil(h * baseScale);

    const coverToBase = `scale=${baseW}:${baseH}:force_original_aspect_ratio=increase,crop=${baseW}:${baseH},setsar=1,fps=${fps}`;
    const endCover = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=${fps},format=yuv420p`;

    const hookZoomDelta = 0.08; // 1.00 -> 1.08 (push-in on hook)
    const midZoomDelta = 0.04;  // 1.00 -> 1.04 (others calmer)

    // Helper to build a fast KenBurns-like chain using crop expressions
    // Start crop bigger -> end crop exact w/h = zoom-in.
    function kbChain(tagIn, tagOut, durSec, zoomDelta, panX, panY) {
      // Crop size starts at (1+zoomDelta)*w/h and shrinks to w/h by end.
      // Avoid division by 0 with max(durSec,0.001)
      const D = Math.max(0.001, durSec);
      const zW = `(${w}*(1+${zoomDelta}*(1-(t/${D}))))`;
      const zH = `(${h}*(1+${zoomDelta}*(1-(t/${D}))))`;

      // Pan offsets are fraction of available room
      const x = `(iw-ow)/2 + (iw-ow)*${panX}*(t/${D})`;
      const y = `(ih-oh)/2 + (ih-oh)*${panY}*(t/${D})`;

      return `[${tagIn}]trim=duration=${durSec.toFixed(3)},setpts=PTS-STARTPTS,` +
        `crop=w='${zW}':h='${zH}':x='${x}':y='${y}',` +
        `scale=${w}:${h},format=yuv420p[${tagOut}]`;
    }

    const filterParts = [
      // prep base frames (do once per image)
      `[0:v]${coverToBase}[b0]`,
      `[1:v]${coverToBase}[b1]`,
      `[2:v]${coverToBase}[b2]`,
      `[3:v]${coverToBase}[b3]`,

      // Motion per image (FAST)
      // Hook: stronger push-in
      kbChain("b0", "s0", (seg1In / 1000), hookZoomDelta, 0.05, -0.02),
      // Image 2
      kbChain("b1", "s1", (seg2In / 1000), midZoomDelta, -0.04, 0.03),
      // Image 3
      kbChain("b2", "s2", (seg3In / 1000), midZoomDelta, 0.03, -0.04),
      // Image 4
      kbChain("b3", "s3", (seg4In / 1000), midZoomDelta, -0.03, 0.02),

      // Crossfades (0.10s)
      `[s0][s1]xfade=transition=fade:duration=${fadeSec}:offset=${off1}[x01]`,
      `[x01][s2]xfade=transition=fade:duration=${fadeSec}:offset=${off2}[x012]`,
      `[x012][s3]xfade=transition=fade:duration=${fadeSec}:offset=${off3}[slideshow]`,

      // Burn-in subtitles
      `[slideshow]ass=${assPath.replace(/\\/g, "\\\\")}[subbed]`,

      // VERY subtle grain only (fast)
      `[subbed]noise=alls=1:allf=t,format=yuv420p[styled]`,

      // End card static (no grain)
      `[4:v]${endCover}[v4]`,
      `[v4]trim=duration=${(endCardDurMs / 1000).toFixed(3)},setpts=PTS-STARTPTS[endcard]`,

      // Concat slideshow + endcard
      `[styled][endcard]concat=n=2:v=1:a=0[vout]`
    ];

    // -------------------------
    // AUDIO (same as before)
    // VO only during slideshow
    // end card silence
    // slogan starts at end card + 0.2s
    // -------------------------
    const endCardStartSec = slideshowMs / 1000;
    const totalDurSec = totalMs / 1000;

    const sloganStartSec = endCardStartSec + 0.2;
    const sloganDelayMs = Math.max(0, Math.round(sloganStartSec * 1000));

    filterParts.push(
      `[5:a]asetpts=PTS-STARTPTS,` +
        `atrim=0:${endCardStartSec.toFixed(3)},` +
        `apad=pad_dur=${(endCardDurMs / 1000 + 2).toFixed(3)},` +
        `atrim=0:${totalDurSec.toFixed(3)}` +
        `[amain]`
    );

    if (hasEndCardAudio) {
      const fadeIn = 0.12;

      filterParts.push(
        `[6:a]asetpts=PTS-STARTPTS,` +
          `afade=t=in:st=0:d=${fadeIn},` +
          `volume=1.35,` +
          `adelay=${sloganDelayMs}|${sloganDelayMs}` +
          `[aslogan]`,
        `[amain][aslogan]amix=inputs=2:duration=longest:normalize=0[aout]`,
        `[aout]atrim=0:${totalDurSec.toFixed(3)}[aout2]`
      );
    } else {
      filterParts.push(`[amain]atrim=0:${totalDurSec.toFixed(3)}[aout2]`);
    }

    const filter = filterParts.join(";");

    const args = [
      "-y",

      // 4 slideshow images (first 3 slightly longer for fades)
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

      // end card
      "-loop",
      "1",
      "-t",
      (endCardDurMs / 1000).toFixed(3),
      "-i",
      endPath,

      // main voiceover
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

      // FAST ENCODE (biggest speed win)
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
