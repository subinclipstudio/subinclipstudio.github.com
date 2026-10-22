// 브라우저 안에서 MP4(H.264 + AAC)를 만든다: WebCodecs 로 인코딩하고 mp4-muxer 로 묶는다.
/* global Mp4Muxer */

const SR = 48000;
const VIDEO_CODECS = ["avc1.640028", "avc1.4d0028", "avc1.42e028"]; // High / Main / Baseline, 레벨 4.0

export async function capabilities(W = 1080, H = 1920, fps = 30) {
  const out = { webcodecs: "VideoEncoder" in window && "AudioEncoder" in window, video: null, audio: false, offscreen: typeof OffscreenCanvas !== "undefined" };
  if (!out.webcodecs) return out;
  for (const codec of VIDEO_CODECS) {
    try {
      const r = await VideoEncoder.isConfigSupported({ codec, width: W, height: H, bitrate: 8e6, framerate: fps });
      if (r.supported) { out.video = codec; break; }
    } catch {}
  }
  try {
    const r = await AudioEncoder.isConfigSupported({ codec: "mp4a.40.2", sampleRate: SR, numberOfChannels: 2, bitrate: 192000 });
    out.audio = !!r.supported;
  } catch {}
  return out;
}

const db = (v) => Math.pow(10, v / 20);

/** 배경음악 반복·페이드·음량을 적용한 스테레오 AudioBuffer (음악 없음이면 무음) */
export async function mixAudio(duration, musicBlob, settings) {
  const len = Math.ceil(duration * SR);
  const ctx = new OfflineAudioContext(2, len, SR);
  const info = { music: !!musicBlob, warnings: [] };
  if (musicBlob) {
    const buf = await ctx.decodeAudioData(await musicBlob.arrayBuffer());
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true; // 내장 음원은 마디 단위로 이음새 없이 만들어져 그대로 반복
    const gain = ctx.createGain();
    const num = (v, d) => (v === undefined || v === null || v === "" || isNaN(+v) ? d : +v);
    const level = db(num(settings.music_gain_db, -8)) * db(num(settings.master_gain_db, 0));
    const fi = Math.min(num(settings.fade_in, 1), duration / 2), fo = Math.min(num(settings.fade_out, 2), duration / 2);
    gain.gain.setValueAtTime(fi > 0 ? 0 : level, 0);
    if (fi > 0) gain.gain.linearRampToValueAtTime(level, fi);
    gain.gain.setValueAtTime(level, Math.max(fi, duration - Math.max(fo, 0.3)));
    gain.gain.linearRampToValueAtTime(0, duration);
    src.connect(gain).connect(ctx.destination);
    src.start(0);
  }
  const out = await ctx.startRendering();
  let peak = 0;
  for (let c = 0; c < 2; c++) { const d = out.getChannelData(c); for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i])); }
  if (peak > 0.98) {
    for (let c = 0; c < 2; c++) { const d = out.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] *= 0.98 / peak; }
    info.warnings.push("음량이 커서 전체 볼륨을 자동으로 낮췄습니다.");
  }
  info.peak = peak;
  return { buffer: out, info };
}

/**
 * timeline.draw(ctx, t) 로 프레임을 그려 MP4 Blob 을 만든다.
 * onProgress(0~1), shouldStop() 으로 진행 표시·중단.
 */
export async function encodeMp4(timeline, audioBuffer, { W, H, fps = 30, onProgress, shouldStop }) {
  const caps = await capabilities(W, H, fps);
  if (!caps.webcodecs) throw new Error("이 브라우저는 영상 인코딩(WebCodecs)을 지원하지 않습니다. PC·안드로이드의 최신 Chrome 또는 Edge를 사용하세요.");
  if (!caps.video) throw new Error("이 기기에서 H.264 영상 인코딩을 사용할 수 없습니다.");
  if (!caps.audio) throw new Error("이 브라우저에서 AAC 오디오 인코딩을 사용할 수 없습니다. PC의 최신 Chrome 또는 Edge를 사용하세요.");

  const muxer = new Mp4Muxer.Muxer({
    target: new Mp4Muxer.ArrayBufferTarget(),
    video: { codec: "avc", width: W, height: H, frameRate: fps },
    audio: { codec: "aac", numberOfChannels: 2, sampleRate: SR },
    fastStart: "in-memory",
    firstTimestampBehavior: "offset",
  });
  let encError = null;
  let vChunks = 0, aChunks = 0;
  const venc = new VideoEncoder({
    output: (chunk, meta) => { muxer.addVideoChunk(chunk, meta); vChunks++; },
    error: (e) => (encError = e),
  });
  venc.configure({ codec: caps.video, width: W, height: H, bitrate: W >= 1080 ? 10e6 : 4e6, framerate: fps, avc: { format: "avc" }, latencyMode: "quality" });
  const aenc = new AudioEncoder({
    output: (chunk, meta) => { muxer.addAudioChunk(chunk, meta); aChunks++; },
    error: (e) => (encError = e),
  });
  aenc.configure({ codec: "mp4a.40.2", sampleRate: SR, numberOfChannels: 2, bitrate: 192000 });

  // 오디오: 1024 샘플씩 planar float32 로 전달
  const L = audioBuffer.getChannelData(0), R = audioBuffer.getChannelData(1);
  const totalFrames = Math.round(timeline.total * fps);
  const audioLen = Math.min(L.length, Math.round(totalFrames / fps * SR));
  for (let off = 0; off < audioLen; off += 1024) {
    const n = Math.min(1024, audioLen - off);
    const data = new Float32Array(n * 2);
    data.set(L.subarray(off, off + n), 0);
    data.set(R.subarray(off, off + n), n);
    const ad = new AudioData({ format: "f32-planar", sampleRate: SR, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((off / SR) * 1e6), data });
    aenc.encode(ad);
    ad.close();
  }

  const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(W, H) : Object.assign(document.createElement("canvas"), { width: W, height: H });
  const g = canvas.getContext("2d", { alpha: false });
  for (let k = 0; k < totalFrames; k++) {
    if (encError) throw new Error("인코딩 오류: " + encError.message);
    if (shouldStop && shouldStop()) throw new Error("사용자가 생성을 중단했습니다.");
    timeline.draw(g, k / fps);
    const vf = new VideoFrame(canvas, { timestamp: Math.round((k * 1e6) / fps), duration: Math.round(1e6 / fps) });
    venc.encode(vf, { keyFrame: k % (fps * 2) === 0 });
    vf.close();
    while (venc.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 2));
    if (k % 10 === 0) { onProgress && onProgress(k / totalFrames); await new Promise((r) => setTimeout(r, 0)); }
  }
  await venc.flush();
  await aenc.flush();
  if (encError) throw new Error("인코딩 오류: " + encError.message);
  venc.close(); aenc.close();
  muxer.finalize();
  onProgress && onProgress(1);
  if (!vChunks) throw new Error("영상 데이터가 만들어지지 않았습니다.");
  if (!aChunks) throw new Error("오디오 데이터가 만들어지지 않았습니다.");
  return { blob: new Blob([muxer.target.buffer], { type: "video/mp4" }), codec: caps.video, vChunks, aChunks };
}

/** 만든 MP4 를 실제로 불러와 해상도·길이를 확인하고 중간 프레임까지 디코딩되는지 검사한다. */
export function verifyMp4(blob, expectW, expectH, expectDur) {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.muted = true; v.preload = "auto";
    const url = URL.createObjectURL(blob);
    const done = (res) => { URL.revokeObjectURL(url); v.removeAttribute("src"); v.load(); resolve(res); };
    const timer = setTimeout(() => done({ ok: false, problems: ["결과 영상을 불러오지 못했습니다(시간 초과)."] }), 20000);
    v.onerror = () => { clearTimeout(timer); done({ ok: false, problems: ["브라우저가 결과 영상을 재생할 수 없습니다."] }); };
    v.onloadedmetadata = () => { v.currentTime = Math.min(expectDur / 2, v.duration / 2); };
    v.onseeked = () => {
      clearTimeout(timer);
      const problems = [];
      if (v.videoWidth !== expectW || v.videoHeight !== expectH) problems.push(`해상도 불일치 ${v.videoWidth}x${v.videoHeight}`);
      if (Math.abs(v.duration - expectDur) > 0.25) problems.push(`길이 불일치 ${v.duration.toFixed(2)} / ${expectDur.toFixed(2)}초`);
      done({ ok: !problems.length, problems, width: v.videoWidth, height: v.videoHeight, duration: v.duration });
    };
    v.src = url;
  });
}
