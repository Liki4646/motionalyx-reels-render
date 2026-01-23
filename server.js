import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import tmp from "tmp";
import crypto from "crypto";

const execFileAsync = promisify(execFile);
tmp.setGracefulCleanup();

const app = express();
app.use(express.json({ limit: "50mb" }));

app.get("/", (_req, res) => res.status(200).json({ ok: true }));
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));

// =====================
// CONFIG (REQUIRED)
// =====================
// Make a GCS bucket and set it to public-read OR handle access in your own way.
// Then set env var OUTPUT_BUCKET to that bucket name.
const OUTPUT_BUCKET = process.env.OUTPUT_BUCKET || ""; // e.g. "motionalyx-renders"
const OUTPUT_PREFIX = process.env.OUTPUT_PREFIX || "renders"; // folder prefix in bucket

function mustHaveBucket() {
  if (!OUTPUT_BUCKET) throw new Error("Missing env var OUTPUT_BUCKET (GCS bucket name).");
}

function publicGcsUrl(bucket, objectName) {
  // Works if bucket/object is publicly readable
  return `https://storage.googleapis.com/${bucket}/${encodeURIComponent(objectName).replace(/%2F/g, "/")}`;
}

// =====================
// GCS helpers (no extra deps)
// Uses Cloud Run metadata server to get an access token,
// then uses GCS JSON API.
// =====================
async function getAccessToken() {
  const r = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } }
  );
  if (!r.ok) throw new Error(`metadata token failed: ${r.status}`);
  const j = await r.json();
  if (!j?.access_token) throw new Error("metadata token missing access_token");
  return j.access_token;
}

async function gcsUploadFile({ bucket, objectName, filePath, contentType }) {
  const token = await getAccessToken();
  const url =
    `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o` +
    `?uploadType=media&name=${encodeURIComponent(objectName)}`;

  const stat = fs.statSync(filePath);
  const stream = fs.createReadStream(filePath);

  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": contentType || "application/octet-stream",
      "Content-Length": String(stat.size)
    },
    body: stream
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`gcs upload failed ${r.status}: ${txt}`);
  }
  return await r.json().catch(() => ({}));
}

async function gcsUploadJson({ bucket, objectName, json }) {
  const token = await getAccessToken();
  const url =
    `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o` +
    `?uploadType=media&name=${encodeURIComponent(objectName)}`;

  const body = Buffer.from(JSON.stringify(json), "utf8");

  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": String(body.length)
    },
    body
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`gcs upload json failed ${r.status}: ${txt}`);
  }
  return await r.json().catch(() => ({}));
}

async function gcsReadJson({ bucket, objectName }) {
  const token = await getAccessToken();
  const url =
    `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/` +
    `${encodeURIComponent(objectName)}?alt=media`;

  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (r.status === 404) return null;
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`gcs read json failed ${r.status}: ${txt}`);
  }
  return await r.json();
}

// =====================
// Your existing helpers
// =====================
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

// =====================
// JOB endpoints
// =====================
app.get("/job/:id", async (req, res) => {
  try {
    mustHaveBucket();
    const id = String(req.params.id || "").trim();
    if (!id) throw new Error("missing id");

    const statusObject = `${OUTPUT_PREFIX}/jobs/${id}.json`;
    const st = await gcsReadJson({ bucket: OUTPUT_BUCKET, objectName: statusObject });

    if (!st) return res.status(404).json({ ok: false, error: "job not found" });
    return res.status(200).json({ ok: true, job: st });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

// =====================
// ASYNC RENDER
// =====================
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
    mustHaveBucket();

    if (!audio_url) throw new Error("audio_url is required");
    if (!end_card_url) throw new Error("end_card_url is required");
    ensureArray(images, "images");
    if (images.length !== 4) throw new Error("images must have exactly 4 URLs");
    ensureArray(captions, "captions");

    const jobId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");

    const mp4Object = `${OUTPUT_PREFIX}/mp4/${jobId}.mp4`;
    const statusObject = `${OUTPUT_PREFIX}/jobs/${jobId}.json`;

    const mp4Url = publicGcsUrl(OUTPUT_BUCKET, mp4Object);
    const statusUrl = `/job/${jobId}`;

    // write initial status
    await gcsUploadJson({
      bucket: OUTPUT_BUCKET,
      objectName: statusObject,
      json: {
        id: jobId,
        status: "queued",
        created_at: new Date().toISOString(),
        mp4_url: mp4Url
      }
    });

    // respond immediately (Make < 300s safe)
    res.status(202).json({
      ok: true,
      job_id: jobId,
      status_url: statusUrl,
      mp4_url: mp4Url
    });

    // run async (do NOT await)
    runJob({
      jobId,
      statusObject,
      mp4Object,
      mp4Url,
      audio_url,
      images,
      captions,
      end_card_url,
      end_card_duration_ms,
      end_card_audio_url,
      video
    }).catch((e) => {
      console.error("[job] fatal:", e);
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: String(err?.message || err) });
  }
});

// =====================
// JOB worker
// =====================
async function updateJob(jobId, statusObject, patch) {
  try {
    const next = { id: jobId, updated_at: new Date().toISOString(), ...patch };
    await gcsUploadJson({ bucket: OUTPUT_BUCKET, objectName: statusObject, json: next });
  } catch (e) {
    console.log("[job] status update failed:", String(e?.message || e));
  }
}

async function runJob(params) {
  const {
    jobId,
    statusObject,
    mp4Object,
    mp4Url,
    audio_url,
    images,
    captions,
    end_card_url,
    end_card_duration_ms,
    end_card_audio_url,
    video
  } = params;

  const startedAt = Date.now();
  await updateJob(jobId, statusObject, { status: "downloading", mp4_url: mp4Url });

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

  try {
    // Parallel downloads
    await Promise.all([
      downloadToFile(images[0], img1Path),
      downloadToFile(images[1], img2Path),
      downloadToFile(images[2], img3Path),
      downloadToFile(images[3], img4Path),
      downloadToFile(end_card_url, endPath),
      downloadToFile(audio_url, audioPath)
    ]);

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

    await updateJob(jobId, statusObject, { status: "rendering" });

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

    // TURBO defaults to fit under time (you can tweak)
    const fps = 20; // turbo
    const crf = 32; // turbo

    const scaledCaptions = normalizeAndScaleCaptions(captions, audioMs);

    let effectiveAudioMs = audioMs;
    if (!Number.isFinite(effectiveAudioMs) || effectiveAudioMs <= 0) {
      const lastEnd = scaledCaptions.length ? Number(scaledCaptions[scaledCaptions.length - 1].end_ms) : 0;
      effectiveAudioMs = Number.isFinite(lastEnd) && lastEnd > 0 ? Math.round(lastEnd) : 15000;
    }

    // SLIDE timing
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

    const fadeMs = 80;
    const fadeSec = (fadeMs / 1000).toFixed(3);

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

    // ASS subtitles (keep your sizes/segments + centered + nudged down)
    const titleFontSize = 150;
    const titleOutline = 5;

    const captionFontSize = 100;
    const captionOutline = 3;

    const marginLR = Math.round(w * 0.10);
    const titleMarginV = Math.round(h * 0.34);
    const captionMarginV = Math.min(h - 10, titleMarginV + Math.round(captionFontSize * 1.25));

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
Style: Caption,DejaVu Sans,${captionFontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,${captionOutline},0,8,${marginLR},${marginLR},${captionMarginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

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

    // VIDEO motion (turbo + jitter fixes)
    const baseScale = 1.15;
    const baseW = Math.ceil((w * baseScale) / 16) * 16;
    const baseH = Math.ceil((h * baseScale) / 16) * 16;

    const hookZoomDelta = 0.14;
    const midZoomDelta = 0.08;

    function zoompanOnlyZoom(tagIn, tagOut, durMs, zoomDelta) {
      const frames = Math.max(2, Math.round((durMs / 1000) * fps));
      const denom = Math.max(1, frames - 1);

      const z = `1+(${zoomDelta})*(on/${denom})`;

      // stable center lock (prevents jitter)
      const x = `floor(iw/2-(iw/(2*zoom)))`;
      const y = `floor(ih/2-(ih/(2*zoom)))`;

      return (
        `[${tagIn}]` +
        `scale=${baseW}:${baseH}:force_original_aspect_ratio=increase:flags=fast_bilinear,setsar=1,` +
        `zoompan=z='${z}':x='${x}':y='${y}':d=${frames}:s=${w}x${h}:fps=${fps},` +
        `setpts=PTS-STARTPTS,format=yuv420p` +
        `[${tagOut}]`
      );
    }

    const endCover =
      `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=fast_bilinear,` +
      `crop=${w}:${h},setsar=1,fps=${fps},format=yuv420p`;

    const filterParts = [
      zoompanOnlyZoom("0:v", "s0", seg1In, hookZoomDelta),
      zoompanOnlyZoom("1:v", "s1", seg2In, midZoomDelta),
      zoompanOnlyZoom("2:v", "s2", seg3In, midZoomDelta),
      zoompanOnlyZoom("3:v", "s3", seg4In, midZoomDelta),

      `[s0][s1]xfade=transition=fade:duration=${fadeSec}:offset=${off1}[x01]`,
      `[x01][s2]xfade=transition=fade:duration=${fadeSec}:offset=${off2}[x012]`,
      `[x012][s3]xfade=transition=fade:duration=${fadeSec}:offset=${off3}[slideshow]`,

      `[slideshow]ass=${assPath.replace(/\\/g, "\\\\")}[styled]`,

      `[4:v]${endCover}[v4]`,
      `[v4]trim=duration=${(endCardDurMs / 1000).toFixed(3)},setpts=PTS-STARTPTS[endcard]`,

      `[styled][endcard]concat=n=2:v=1:a=0[vout]`
    ];

    // AUDIO
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
      "-hide_banner",
      "-loglevel",
      "error",
      "-threads",
      "0",

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

    if (hasEndCardAudio) args.push("-i", sloganWavPath);

    args.push(
      "-filter_complex",
      filter,
      "-map",
      "[vout]",
      "-map",
      "[aout2]",
      "-r",
      String(fps),

      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-tune",
      "zerolatency",
      "-crf",
      String(crf),
      "-pix_fmt",
      "yuv420p",
      "-profile:v",
      "baseline",
      "-level",
      "3.1",

      "-c:a",
      "aac",
      "-b:a",
      "128k",

      outPath
    );

    console.log("[job] ffmpeg args:", args.join(" "));
    await execFileAsync("ffmpeg", args);

    await updateJob(jobId, statusObject, { status: "uploading" });

    // Upload mp4 to GCS (durable URL)
    await gcsUploadFile({
      bucket: OUTPUT_BUCKET,
      objectName: mp4Object,
      filePath: outPath,
      contentType: "video/mp4"
    });

    const totalSec = Math.round((Date.now() - startedAt) / 1000);

    await updateJob(jobId, statusObject, {
      status: "done",
      mp4_url: mp4Url,
      finished_at: new Date().toISOString(),
      render_seconds: totalSec
    });

    console.log("[job] done:", jobId, "sec:", totalSec);
  } catch (e) {
    const msg = String(e?.message || e);
    console.log("[job] error:", jobId, msg);
    await updateJob(jobId, statusObject, {
      status: "error",
      error: msg,
      finished_at: new Date().toISOString()
    });
  }
}

// =====================
const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`listening on ${port}`));
