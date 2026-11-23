import { spawn, type ChildProcess } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { types as ms } from 'mediasoup';
import type { Room } from './media';

/**
 * Meeting recording: the SFU forwards everyone's audio and one video (a
 * shared screen if there is one, else the first camera) as plain RTP to
 * FFmpeg, which writes a WebM file to forge_team_media/recordings.
 *
 * FFmpeg can't add inputs while running, so when the streams change (someone
 * joins, leaves or starts sharing) the recorder starts a new segment. Every
 * segment is encoded the same way (VP8 1280×720 15 fps + Opus, with black
 * video or silence when there is none), so the segments are joined at the
 * end without re-encoding.
 */

const WIDTH = 1280;
const HEIGHT = 720;

async function freeUdpPortPair(): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = 20000 + 2 * Math.floor(Math.random() * 4000);
    const ok = await Promise.all([port, port + 1].map((p) => new Promise<boolean>((resolve) => {
      const s = createSocket('udp4');
      s.once('error', () => resolve(false));
      s.bind(p, '127.0.0.1', () => s.close(() => resolve(true)));
    })));
    if (ok.every(Boolean)) return port;
  }
  throw new Error('No free UDP ports for recording');
}

interface Leg {
  transport: ms.PlainTransport;
  consumer: ms.Consumer;
  port: number;
}

function sdpFor(legs: Leg[]) {
  const lines = ['v=0', 'o=- 0 0 IN IP4 127.0.0.1', 's=ForgeTeam recording', 'c=IN IP4 127.0.0.1', 't=0 0'];
  for (const leg of legs) {
    const codec = leg.consumer.rtpParameters.codecs[0]!;
    const pt = codec.payloadType;
    const name = codec.mimeType.split('/')[1]!;
    lines.push(`m=${leg.consumer.kind} ${leg.port} RTP/AVP ${pt}`, `a=rtcp:${leg.port + 1}`, `a=rtpmap:${pt} ${name}/${codec.clockRate}${codec.channels ? `/${codec.channels}` : ''}`, 'a=recvonly');
  }
  return lines.join('\r\n') + '\r\n';
}

export interface RecordingResult {
  path: string;
  size: number;
  durationMs: number;
}

export class Recorder {
  private legs: Leg[] = [];
  private ffmpeg: ChildProcess | null = null;
  private segments: string[] = [];
  private startedAt = 0;
  private stopping = false;
  private failures = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private keyframeTimer: NodeJS.Timeout | null = null;
  private readonly onChange = () => this.scheduleRestart();

  constructor(
    private readonly room: Room,
    /** Absolute path of the final .webm file. */
    readonly outputPath: string,
    private readonly opts: { ffmpegPath?: string; log?: { warn: (o: unknown, m?: string) => void } } = {},
  ) {}

  get recording() {
    return !!this.startedAt && !this.stopping;
  }

  async start() {
    await mkdir(dirname(this.outputPath), { recursive: true });
    this.startedAt = Date.now();
    this.room.on('producer-added', this.onChange);
    this.room.on('producer-closed', this.onChange);
    await this.startSegment();
  }

  private scheduleRestart() {
    if (this.stopping) return;
    // Several changes at once (someone joining with mic and camera) make one new segment.
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => void this.restart().catch((err) => this.opts.log?.warn({ err }, 'recording segment failed')), 1500);
  }

  private async restart() {
    if (this.stopping) return;
    await this.stopSegment();
    await this.startSegment();
  }

  /** Streams for this segment: all audio, plus a screen share or else the first camera. */
  private chooseProducers() {
    const all = this.room.producers().filter((p) => !p.paused || p.kind === 'audio');
    const audio = all.filter((p) => p.kind === 'audio').slice(0, 16);
    const video = all.find((p) => p.source === 'screen') ?? all.find((p) => p.source === 'cam');
    return [...audio, ...(video ? [video] : [])];
  }

  private async startSegment() {
    const chosen = this.chooseProducers();
    for (const p of chosen) {
      const port = await freeUdpPortPair();
      const transport = await this.room.router.createPlainTransport({ listenInfo: { protocol: 'udp', ip: '127.0.0.1' }, rtcpMux: false, comedia: false });
      await transport.connect({ ip: '127.0.0.1', port, rtcpPort: port + 1 });
      const consumer = await transport.consume({ producerId: p.id, rtpCapabilities: this.room.router.rtpCapabilities, paused: true });
      this.legs.push({ transport, consumer, port });
    }
    const audioLegs = this.legs.filter((l) => l.consumer.kind === 'audio');
    const videoLeg = this.legs.find((l) => l.consumer.kind === 'video');
    const ordered = [...audioLegs, ...(videoLeg ? [videoLeg] : [])];
    const segment = `${this.outputPath}.part${this.segments.length}.webm`;
    this.segments.push(segment);

    const args = ['-hide_banner', '-loglevel', 'error', '-y'];
    let next = 0;
    let sdpInput = -1;
    if (ordered.length) {
      const sdpPath = `${segment}.sdp`;
      await writeFile(sdpPath, sdpFor(ordered));
      args.push('-protocol_whitelist', 'file,udp,rtp', '-fflags', '+genpts', '-analyzeduration', '5000000', '-probesize', '10000000', '-f', 'sdp', '-i', sdpPath);
      sdpInput = next++;
    }
    const blackInput = videoLeg ? -1 : next++;
    if (!videoLeg) args.push('-f', 'lavfi', '-i', `color=c=black:s=${WIDTH}x${HEIGHT}:r=15`);
    const silenceInput = audioLegs.length ? -1 : next++;
    if (!audioLegs.length) args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');

    const filters: string[] = [];
    if (audioLegs.length > 1) filters.push(`${audioLegs.map((_, i) => `[${sdpInput}:a:${i}]`).join('')}amix=inputs=${audioLegs.length}:duration=longest:dropout_transition=0:normalize=0[a]`);
    else if (audioLegs.length === 1) filters.push(`[${sdpInput}:a:0]anull[a]`);
    else filters.push(`[${silenceInput}:a]anull[a]`);
    const vIn = videoLeg ? `[${sdpInput}:v:0]` : `[${blackInput}:v]`;
    filters.push(`${vIn}scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2,fps=15,format=yuv420p[v]`);
    args.push(
      '-filter_complex', filters.join(';'),
      '-map', '[v]', '-map', '[a]',
      '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '1500k', '-g', '30',
      '-c:a', 'libopus', '-b:a', '96k', '-ar', '48000', '-ac', '2',
      '-shortest', '-f', 'webm', segment,
    );
    // Without any RTP input FFmpeg would run forever on lavfi: bound it by stop().
    const proc = spawn(this.opts.ffmpegPath ?? 'ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr!.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
    proc.on('error', (err) => this.opts.log?.warn({ err }, 'could not start ffmpeg'));
    proc.on('exit', (code) => {
      if (this.stopping || this.ffmpeg !== proc) return;
      // FFmpeg stopped on its own (e.g. a stream it couldn't read): carry on in a new segment.
      this.ffmpeg = null;
      if (++this.failures > 5) {
        this.opts.log?.warn({ code, stderr }, 'recording keeps failing; giving up until it is stopped');
        return;
      }
      this.opts.log?.warn({ code, stderr }, 'recording segment ended unexpectedly; starting a new one');
      this.scheduleRestart();
    });
    this.ffmpeg = proc;
    // Give FFmpeg a moment to open its ports, then start the streams and ask for a keyframe.
    await new Promise((r) => setTimeout(r, 800));
    for (const l of this.legs) await l.consumer.resume();
    const keyframes = async () => {
      for (const l of this.legs) if (l.consumer.kind === 'video' && !l.consumer.closed) await l.consumer.requestKeyFrame().catch(() => {});
    };
    await keyframes();
    this.keyframeTimer = setInterval(() => void keyframes(), 2000);
  }

  private async stopSegment() {
    if (this.keyframeTimer) clearInterval(this.keyframeTimer);
    this.keyframeTimer = null;
    const proc = this.ffmpeg;
    this.ffmpeg = null;
    if (proc && proc.exitCode === null) {
      const exited = new Promise<void>((r) => proc.once('exit', () => r()));
      // "q" asks FFmpeg to finish the file cleanly.
      proc.stdin?.write('q');
      proc.stdin?.end();
      const timer = setTimeout(() => proc.kill('SIGKILL'), 8000);
      await exited;
      clearTimeout(timer);
    }
    for (const l of this.legs) l.transport.close();
    this.legs = [];
  }

  async stop(): Promise<RecordingResult> {
    if (this.stopping) throw new Error('Already stopping');
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.room.off('producer-added', this.onChange);
    this.room.off('producer-closed', this.onChange);
    await this.stopSegment();
    const parts: string[] = [];
    for (const s of this.segments) if (await stat(s).then((x) => x.size > 0, () => false)) parts.push(s);
    if (!parts.length) throw new Error('Nothing was recorded');
    if (parts.length === 1) {
      await rmQuiet(this.outputPath);
      await import('node:fs/promises').then((fs) => fs.rename(parts[0]!, this.outputPath));
    } else {
      const list = `${this.outputPath}.parts.txt`;
      await writeFile(list, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
      await new Promise<void>((resolve, reject) => {
        const p = spawn(this.opts.ffmpegPath ?? 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', this.outputPath], { stdio: 'ignore' });
        p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`joining recording segments failed (${code})`))));
        p.on('error', reject);
      });
      await rmQuiet(list);
    }
    for (const s of this.segments) {
      await rmQuiet(s);
      await rmQuiet(`${s}.sdp`);
    }
    const size = (await stat(this.outputPath)).size;
    return { path: this.outputPath, size, durationMs: Date.now() - this.startedAt };
  }
}

const rmQuiet = (p: string) => rm(p, { force: true }).catch(() => {});

export const recordingPath = (root: string, meetingId: string) => join(root, 'recordings', `${meetingId}-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`);
