import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import os from "os";
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

    // We want: first segment = audio duration, then end card fixed 4s
    const totalMs = audioMs + Number(end_card_duration_ms || 4000);

    // Create a 3-image slideshow for the audio duration (each third of audio)
    // Then concat end card 4s.
    const w = Number(video.width || 1080);
    const h = Number(video.height || 1920);
    const fps = Number(video.fps || 30);

    const seg1 = Math.floor(audioMs / 3);
    const seg2 = Math.floor(audioMs / 3);
    const seg3 = audioMs - seg1 - seg2;

    // ffmpeg filtergraph:
    // - scale images to fit 1080x1920 with blur background? (simple: scale+pad)
    // - animate: slow zoom (optional) - keep simple: static.
    // - burn subtitles only on first part (audio)
    const filter = [
      `[0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1[v0]`,
      `[1:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1[v1]`,
      `[2:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1[v2]`,
      `[3:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1[v3]`,

      // concat 3 images (durations) into one video stream "slideshow"
      `[v0]trim=duration=${seg1/1000},setpts=PTS-STARTPTS[a0]`,
      `[v1]trim=duration=${seg2/1000},setpts=PTS-STARTPTS[a1]`,
      `[v2]trim=duration=${seg3/1000},setpts=PTS-STARTPTS[a2]`,
      `[a0][a1][a2]concat=n=3:v=1:a=0[slideshow]`,

      // burn subtitles on slideshow only
      `[slideshow]subtitles=${srtPath.replace(/\\/g, "\\\\").replace(/:/g, "\\:")}:force_style='FontName=Arial,FontSize=44,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=120'[subbed]`,

      // end card fixed duration
      `[v3]trim=duration=${Number(end_card_duration_ms)/1000},setpts=PTS-STARTPTS[endcard]`,

      // concat slideshow + end card
      `[subbed][endcard]concat=n=2:v=1:a=0[vout]`
    ].join(";");

    // Inputs: 3 images + end image + audio
    // We loop each image with -loop 1 and provide enough -t
    // Then map vout + audio and stop at total duration.
    const args = [
      "-y",
      "-loop", "1", "-t", (seg1/1000).toFixed(3), "-i", img1Path,
      "-loop", "1", "-t", (seg2/1000).toFixed(3), "-i", img2Path,
      "-loop", "1", "-t", (seg3/1000).toFixed(3), "-i", img3Path,
      "-loop", "1", "-t", (Number(end_card_duration_ms)/1000).toFixed(3), "-i", endPath,
      "-i", audioPath,
      "-filter_complex", filter,
      "-map", "[vout]",
      "-map", "4:a",
      "-r", String(fps),
      "-shortest",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
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
