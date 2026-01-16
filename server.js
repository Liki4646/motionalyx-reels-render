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

    // temp working dir
    const workDir = tmp.dirSync({ unsafeCleanup: true }).name;

    const audioPath = path.join(workDir, "audio.mp3");
    const img1Path = path.join(workDir, "img1.png");
    const img2Path = path.join(workDir, "img2.png");
    const img3Path = path.join(workDir, "img3.png");
    const endPath = path.join(workDir, "end.png");
    const srtPath = path.join(workDir, "captions.srt");
    const outPath = path.join(workDir, "out.mp4");

    // downloads
    await downloadToFile(audio_url, audioPath);
    await downloadToFile(images[0], img1Path);
    await downloadToFile(images[1], img2Path);
    await downloadToFile(images[2], img3Path);
    await downloadToFile(end_card_url, endPath);

    // build SRT from captions (expects ms)
    // captions: [{start_ms, end_ms, text}]
    function msToSrtTime(ms) {
      const h = Math.floor(ms / 3600000);
      ms -= h * 3600000;
      const m = Math.floor(ms / 60000);
      ms -= m * 60000;
      const s = Math.floor(ms / 1000);
      const ms2 = ms - s * 1000;
      const pad = (n, w = 2) => String(n).padStart(w, "0");
      return `${pad(h)}:${pad(m)}:${pad(s)},${String(ms2).padStart(3, "0")}`;
    }

    const srtLines = [];
    captions.forEach((c, i) => {
      const start = Number(c.start_ms);
      const end = Number(c.end_ms);
      const text = String(c.text || "").trim();
      if (!Number.isFinite(start) || !Number.isFinite(end) || !text) return;
      srtLines.push(String(i + 1));
      srtLines.push(`${msToSrtTime(start)} --> ${msToSrtTime(end)}`);
      srtLines.push(text);
      srtLines.push("");
    });
    fs.writeFileSync(srtPath, srtLines.join("\n"), "utf8");

    // Determine audio duration (ms) via ffprobe
    const { stdout: probeOut } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      audioPath
    ]);
    const audioSeconds = parseFloat(probeOut.trim());
    const audioMs = Math.round(audioSeconds * 1000);

    const w = Number(video.width || 1080);
    const h = Number(video.height || 1920);
    const fps = Number(video.fps || 30);

    // Split audio duration into 3 image segments
    const seg1 = Math.floor(audioMs / 3);
    const seg2 = Math.floor(audioMs / 3);
    const seg3 = audioMs - seg1 - seg2;

    // Escape SRT path for ffmpeg subtitles filter
    const srtEsc = srtPath
      .replace(/\\/g, "\\\\")
      .replace(/:/g, "\\:");

    // COVER+CROP helper:
    // - scale up until it fully covers 1080x1920, then crop to exact size.
    // - force fps + yuv420p for consistent encoding.
    const coverCrop = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=${fps},format=yuv420p`;

    const filter = [
      // Make each image a proper 9:16 frame (no black bars)
      `[0:v]${coverCrop}[v0]`,
      `[1:v]${coverCrop}[v1]`,
      `[2:v]${coverCrop}[v2]`,
      `[3:v]${coverCrop}[v3]`,

      // Trim each image stream to its segment duration
      `[v0]trim=duration=${(seg1 / 1000)},setpts=PTS-STARTPTS[a0]`,
      `[v1]trim=duration=${(seg2 / 1000)},setpts=PTS-STARTPTS[a1]`,
      `[v2]trim=duration=${(seg3 / 1000)},setpts=PTS-STARTPTS[a2]`,
      `[a0][a1][a2]concat=n=3:v=1:a=0[slideshow]`,

      // Burn subtitles on slideshow only
      `[slideshow]subtitles=${srtEsc}:force_style='FontName=Arial,FontSize=44,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=120'[subbed]`,

      // End card fixed duration
      `[v3]trim=duration=${(Number(end_card_duration_ms) / 1000)},setpts=PTS-STARTPTS[endcard]`,

      // Concat slideshow + end card
      `[subbed][endcard]concat=n=2:v=1:a=0[vout]`
    ].join(";");

    const args = [
      "-y",

      // loop images for their durations
      "-loop", "1", "-t", (seg1 / 1000).toFixed(3), "-i", img1Path,
      "-loop", "1", "-t", (seg2 / 1000).toFixed(3), "-i", img2Path,
      "-loop", "1", "-t", (seg3 / 1000).toFixed(3), "-i", img3Path,
      "-loop", "1", "-t", (Number(end_card_duration_ms) / 1000).toFixed(3), "-i", endPath,

      // audio input
      "-i", audioPath,

      "-filter_complex", filter,

      "-map", "[vout]",
      "-map", "4:a",

      // output
      "-r", String(fps),
      "-shortest",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-profile:v", "high",
      "-level", "4.1",
      "-c:a", "aac",
      "-b:a", "192k",
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
