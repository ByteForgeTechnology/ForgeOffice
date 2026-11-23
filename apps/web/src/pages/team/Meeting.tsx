import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Device, type types } from 'mediasoup-client';
import type { Socket } from 'socket.io-client';
import { Circle, Hand, Mic, MicOff, MonitorUp, PhoneOff, Smile, Square, UserCheck, UserX, Users, Video, VideoOff, X } from 'lucide-react';
import { Alert, Avatar, Badge, Button, Field, Input, PageSpinner, cn, useToast } from '@forge/ui';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { ask, guestSocket, teamSocket } from './team-api';

type Source = 'mic' | 'cam' | 'screen';
interface PeerInfo {
  id: string;
  userId: string | null;
  name: string;
  guest: boolean;
  host: boolean;
  handRaised: boolean;
}
interface ProducerInfo {
  id: string;
  peerId: string;
  kind: 'audio' | 'video';
  source: Source;
  paused: boolean;
}
interface Remote {
  producerId: string;
  peerId: string;
  source: Source;
  kind: 'audio' | 'video';
  paused: boolean;
  stream: MediaStream;
  consumer: types.Consumer;
}

/**
 * A ForgeTeam meeting (/team/meet/<code>): the same page for colleagues,
 * guests from outside (who wait in the lobby), and calendar invitation links.
 */
export function MeetingPage() {
  const { code = '' } = useParams();
  const { user, ready } = useAuth();
  const [guest, setGuest] = useState<{ pass: string; name: string } | null>(null);
  if (!ready) return <PageSpinner />;
  if (!user && !guest) return <GuestEntry code={code} onPass={setGuest} />;
  return <MeetingRoom code={code} guestPass={guest?.pass ?? null} />;
}

function GuestEntry({ code, onPass }: { code: string; onPass: (g: { pass: string; name: string }) => void }) {
  const { signIn: startSignIn } = useAuth();
  const [info, setInfo] = useState<{ title: string; organisation: string; guestAccess: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ title: string; organisation: string; guestAccess: boolean }>(`/api/v1/team/guest/${code}`, { anonymous: true }).then(setInfo, (e) => setError(errorMessage(e)));
  }, [code]);
  const signIn = () => void startSignIn(`/team/meet/${code}`);
  return (
    <div className="flex min-h-dvh items-center justify-center bg-zinc-950 p-4 text-white">
      <div className="w-full max-w-sm rounded-2xl bg-zinc-900 p-6">
        {error ? (
          <Alert tone="danger">{error}</Alert>
        ) : !info ? (
          <PageSpinner />
        ) : (
          <>
            <p className="text-sm text-zinc-400">{info.organisation}</p>
            <h1 className="mb-4 text-xl font-semibold">{info.title}</h1>
            {info.guestAccess ? (
              <form
                className="space-y-3"
                onSubmit={async (e) => {
                  e.preventDefault();
                  setBusy(true);
                  try {
                    const r = await api<{ token: string }>(`/api/v1/team/guest/${code}`, { anonymous: true, body: { name: name.trim() } });
                    onPass({ pass: r.token, name: name.trim() });
                  } catch (err) {
                    setError(errorMessage(err));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <Field label="Your name" htmlFor="guest-name">
                  <Input id="guest-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={60} />
                </Field>
                <Button type="submit" variant="primary" className="w-full" disabled={!name.trim()} loading={busy}>
                  Join as a guest
                </Button>
              </form>
            ) : (
              <p className="text-sm text-zinc-400">This organisation only lets its own people join meetings.</p>
            )}
            <button type="button" onClick={signIn} className="mt-4 w-full text-center text-sm text-zinc-400 underline hover:text-white">
              I have an account: sign in
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The room
// ---------------------------------------------------------------------------

type Stage = 'loading' | 'prejoin' | 'lobby' | 'joining' | 'in' | 'left' | 'error';

function MeetingRoom({ code, guestPass }: { code: string; guestPass: string | null }) {
  const navigate = useNavigate();
  const toast = useToast();
  const socket = useMemo<Socket>(() => (guestPass ? guestSocket(guestPass) : teamSocket()), [guestPass]);
  const [stage, setStage] = useState<Stage>('loading');
  const [error, setError] = useState<string | null>(null);
  const [prep, setPrep] = useState<{ meeting: { id: string; title: string }; you: { name: string; guest: boolean; host: boolean }; participants: { name: string }[] } | null>(null);
  const [me, setMe] = useState<PeerInfo | null>(null);
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [remotes, setRemotes] = useState<Remote[]>([]);
  const [lobby, setLobby] = useState<{ id: string; name: string }[]>([]);
  const [recording, setRecording] = useState(false);
  const [recordingAllowed, setRecordingAllowed] = useState(false);
  const [panel, setPanel] = useState(false);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [sharing, setSharing] = useState(false);
  const [hand, setHand] = useState(false);
  const [reactions, setReactions] = useState<{ id: number; emoji: string; name: string }[]>([]);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);

  const device = useRef<Device | null>(null);
  const send = useRef<types.Transport | null>(null);
  const recv = useRef<types.Transport | null>(null);
  const producers = useRef<Partial<Record<Source, types.Producer>>>({});
  const consuming = useRef(new Set<string>());

  // ---- before joining: who's here, and a preview ----------------------------
  useEffect(() => {
    const go = () =>
      ask<NonNullable<typeof prep> & { lobby: boolean }>(socket, 'call:prepare', { code }).then(
        (r) => {
          setPrep(r);
          setStage('prejoin');
        },
        (e) => (setError(e.message), setStage('error')),
      );
    if (socket.connected) void go();
    else socket.once('connect', () => void go());
    const fail = (e: Error) => (setError(e.message === 'guests_not_allowed' ? 'Guests can’t join this meeting.' : 'Couldn’t connect to the meeting.'), setStage('error'));
    socket.on('connect_error', fail);
    return () => void socket.off('connect_error', fail);
  }, [socket, code]);

  useEffect(() => {
    if (stage !== 'prejoin' || localStream) return;
    navigator.mediaDevices
      ?.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: { width: { ideal: 1280 }, height: { ideal: 720 } } })
      .then(setLocalStream)
      .catch(() =>
        navigator.mediaDevices
          .getUserMedia({ audio: true })
          .then((s) => (setLocalStream(s), setCamOn(false)))
          .catch(() => (setMicOn(false), setCamOn(false))),
      );
  }, [stage, localStream]);

  // ---- receiving ---------------------------------------------------------------
  const consume = useCallback(
    async (p: ProducerInfo) => {
      if (!device.current || !recv.current || consuming.current.has(p.id)) return;
      consuming.current.add(p.id);
      try {
        const { consumer: c } = await ask<{ consumer: { id: string; producerId: string; kind: 'audio' | 'video'; rtpParameters: types.RtpParameters; producerPaused: boolean; source: Source; peerId: string } }>(socket, 'call:consume', {
          transportId: recv.current.id,
          producerId: p.id,
          rtpCapabilities: device.current.recvRtpCapabilities,
        });
        const consumer = await recv.current.consume({ id: c.id, producerId: c.producerId, kind: c.kind, rtpParameters: c.rtpParameters });
        setRemotes((r) => [...r.filter((x) => x.producerId !== p.id), { producerId: p.id, peerId: c.peerId, source: c.source, kind: c.kind, paused: c.producerPaused, stream: new MediaStream([consumer.track]), consumer }]);
        await ask(socket, 'call:resume', { consumerId: c.id });
      } catch (e) {
        consuming.current.delete(p.id);
        console.warn('could not receive a stream', e);
      }
    },
    [socket],
  );

  const produce = useCallback(async (source: Source, track: MediaStreamTrack) => {
    if (!send.current) return;
    producers.current[source]?.close();
    const encodings = source === 'cam' ? [{ maxBitrate: 900_000 }] : source === 'screen' ? [{ maxBitrate: 2_500_000 }] : undefined;
    const producer = await send.current.produce({ track, encodings, appData: { source }, stopTracks: false });
    producers.current[source] = producer;
    return producer;
  }, []);

  // ---- server events -------------------------------------------------------------
  useEffect(() => {
    const on = <T,>(event: string, fn: (p: T) => void) => {
      socket.on(event, fn as never);
      return () => void socket.off(event, fn as never);
    };
    const offs = [
      on<PeerInfo>('call:peer-joined', (p) => setPeers((all) => [...all.filter((x) => x.id !== p.id), p])),
      on<{ peerId: string }>('call:peer-left', ({ peerId }) => {
        setPeers((all) => all.filter((x) => x.id !== peerId));
        setRemotes((r) => r.filter((x) => x.peerId !== peerId));
      }),
      on<ProducerInfo>('call:producer-added', (p) => void (p.peerId !== socket.id && consume(p))),
      on<{ producerId: string }>('call:producer-closed', ({ producerId }) => {
        consuming.current.delete(producerId);
        setRemotes((r) => r.filter((x) => x.producerId !== producerId));
      }),
      on<{ producerId: string; paused: boolean; peerId: string }>('call:producer-paused', ({ producerId, paused, peerId }) => {
        setRemotes((r) => r.map((x) => (x.producerId === producerId ? { ...x, paused } : x)));
        if (peerId === socket.id && producers.current.mic?.id === producerId) setMicOn(!paused);
      }),
      on<{ consumerId: string }>('call:consumer-closed', ({ consumerId }) => setRemotes((r) => r.filter((x) => x.consumer.id !== consumerId))),
      on<{ peerId: string; raised: boolean }>('call:hand', ({ peerId, raised }) => setPeers((all) => all.map((x) => (x.id === peerId ? { ...x, handRaised: raised } : x)))),
      on<{ peerId: string; emoji: string }>('call:reaction', ({ peerId, emoji }) => {
        const id = Math.random();
        setReactions((r) => [...r, { id, emoji, name: peerId === socket.id ? 'You' : '' }]);
        setTimeout(() => setReactions((r) => r.filter((x) => x.id !== id)), 3500);
      }),
      on<{ waiting: { id: string; name: string }[] }>('call:lobby', ({ waiting }) => setLobby(waiting)),
      on<{ on: boolean; by?: string; error?: string }>('call:recording', (r) => {
        setRecording(r.on);
        if (r.error) toast.error(r.error);
        else if (r.on) toast.success(`${r.by ?? 'Someone'} started recording`);
      }),
      on<{ by: string }>('call:muted', ({ by }) => {
        setMicOn(false);
        toast.success(`${by} muted you`);
      }),
      on<{ by: string }>('call:removed', ({ by }) => {
        cleanup();
        setError(`${by} removed you from the meeting`);
        setStage('left');
      }),
      on('call:admitted', () => void join()),
      on('call:denied', () => (setError('The organisers didn’t let you in.'), setStage('error'))),
    ];
    return () => offs.forEach((off) => off());
  }); // re-bind with the latest closures

  // ---- join, leave ----------------------------------------------------------------
  const join = async () => {
    setStage('joining');
    try {
      const r = await ask<{ you: PeerInfo; peers: PeerInfo[]; producers: ProducerInfo[]; rtpCapabilities: types.RtpCapabilities; recording: boolean; recordingAllowed: boolean; lobby: { id: string; name: string }[] }>(socket, 'call:join', { code });
      const dev = new Device();
      await dev.load({ routerRtpCapabilities: r.rtpCapabilities });
      device.current = dev;
      const makeTransport = async (direction: 'send' | 'recv') => {
        const { transport: t } = await ask<{ transport: { id: string; iceParameters: types.IceParameters; iceCandidates: types.IceCandidate[]; dtlsParameters: types.DtlsParameters } }>(socket, 'call:transport');
        const transport = direction === 'send' ? dev.createSendTransport(t) : dev.createRecvTransport(t);
        transport.on('connect', ({ dtlsParameters }, ok, fail) => void ask(socket, 'call:connect', { transportId: transport.id, dtlsParameters }).then(() => ok(), fail));
        if (direction === 'send')
          transport.on('produce', ({ kind, rtpParameters, appData }, ok, fail) =>
            void ask<{ id: string }>(socket, 'call:produce', { transportId: transport.id, kind, rtpParameters, source: appData.source }).then(({ id }) => ok({ id }), fail),
          );
        transport.on('connectionstatechange', (s) => s === 'failed' && toast.error('The media connection failed. Check that the meeting ports are reachable.'));
        return transport;
      };
      send.current = await makeTransport('send');
      recv.current = await makeTransport('recv');
      setMe(r.you);
      setPeers(r.peers);
      setRecording(r.recording);
      setRecordingAllowed(r.recordingAllowed);
      setLobby(r.lobby);
      setStage('in');
      const audio = localStream?.getAudioTracks()[0];
      const video = localStream?.getVideoTracks()[0];
      if (audio) {
        const p = await produce('mic', audio);
        if (!micOn && p) {
          p.pause();
          await ask(socket, 'call:pause', { producerId: p.id, paused: true });
        }
      }
      if (video && camOn) await produce('cam', video);
      for (const p of r.producers) await consume(p);
    } catch (e) {
      setError((e as Error).message);
      setStage('error');
    }
  };

  const cleanup = () => {
    for (const p of Object.values(producers.current)) p?.close();
    producers.current = {};
    send.current?.close();
    recv.current?.close();
    send.current = recv.current = null;
    localStream?.getTracks().forEach((t) => t.stop());
    screenStream?.getTracks().forEach((t) => t.stop());
    consuming.current.clear();
  };
  const leave = async () => {
    await ask(socket, 'call:leave').catch(() => {});
    cleanup();
    setStage('left');
    if (guestPass) socket.disconnect();
  };
  useEffect(
    () => () => {
      socket.emit('call:leave', {});
      cleanup();
      if (guestPass) socket.disconnect();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (stage === 'in') e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [stage]);

  // ---- controls -----------------------------------------------------------------------
  const toggleMic = async () => {
    const p = producers.current.mic;
    const next = !micOn;
    setMicOn(next);
    if (!p) return;
    if (next) p.resume();
    else p.pause();
    await ask(socket, 'call:pause', { producerId: p.id, paused: !next }).catch(() => {});
  };
  const toggleCam = async () => {
    if (camOn) {
      const p = producers.current.cam;
      if (p) {
        p.close();
        delete producers.current.cam;
        await ask(socket, 'call:close-producer', { producerId: p.id }).catch(() => {});
      }
      localStream?.getVideoTracks().forEach((t) => (t.stop(), localStream.removeTrack(t)));
      setCamOn(false);
      return;
    }
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
      const track = s.getVideoTracks()[0]!;
      const merged = new MediaStream([...(localStream?.getAudioTracks() ?? []), track]);
      setLocalStream(merged);
      if (stage === 'in') await produce('cam', track);
      setCamOn(true);
    } catch {
      toast.error('Your camera isn’t available');
    }
  };
  const toggleShare = async () => {
    if (sharing) {
      const p = producers.current.screen;
      if (p) {
        p.close();
        delete producers.current.screen;
        await ask(socket, 'call:close-producer', { producerId: p.id }).catch(() => {});
      }
      screenStream?.getTracks().forEach((t) => t.stop());
      setScreenStream(null);
      setSharing(false);
      return;
    }
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
      const track = s.getVideoTracks()[0]!;
      track.onended = () => void toggleShareOff();
      await produce('screen', track);
      setScreenStream(s);
      setSharing(true);
    } catch {
      /* cancelled */
    }
  };
  const toggleShareOff = async () => {
    const p = producers.current.screen;
    if (p) {
      p.close();
      delete producers.current.screen;
      await ask(socket, 'call:close-producer', { producerId: p.id }).catch(() => {});
    }
    setScreenStream(null);
    setSharing(false);
  };
  const raiseHand = async () => {
    const next = !hand;
    setHand(next);
    await ask(socket, 'call:hand', { raised: next }).catch(() => {});
  };
  const record = async () => {
    try {
      await ask(socket, 'call:record', { on: !recording });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  // ---- rendering ------------------------------------------------------------------------
  if (stage === 'loading') return <Dark><PageSpinner /></Dark>;
  if (stage === 'error' || stage === 'left')
    return (
      <Dark>
        <div className="max-w-sm text-center">
          <h1 className="mb-2 text-xl font-semibold">{stage === 'left' ? 'You left the meeting' : 'You can’t join this meeting'}</h1>
          {error && <p className="mb-4 text-sm text-zinc-400">{error}</p>}
          <div className="flex justify-center gap-2">
            {stage === 'left' && !error?.includes('removed') && <Button onClick={() => window.location.reload()}>Rejoin</Button>}
            {!guestPass && <Button variant="primary" onClick={() => navigate('/team')}>Back to Team</Button>}
          </div>
        </div>
      </Dark>
    );

  if (stage === 'prejoin' || stage === 'lobby' || stage === 'joining')
    return (
      <Dark>
        <div className="w-full max-w-3xl">
          <h1 className="mb-1 text-xl font-semibold">{prep?.meeting.title}</h1>
          <p className="mb-4 text-sm text-zinc-400">{prep?.participants.length ? `In the meeting: ${prep.participants.map((p) => p.name).join(', ')}` : 'Nobody is here yet.'}</p>
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_16rem]">
            <div className="relative aspect-video overflow-hidden rounded-2xl bg-zinc-800">
              {camOn && localStream?.getVideoTracks().length ? <VideoEl stream={localStream} muted mirror /> : <Placeholder name={prep?.you.name ?? ''} />}
              <div className="absolute inset-x-0 bottom-3 flex justify-center gap-2">
                <RoundButton on={micOn} label={micOn ? 'Mute' : 'Unmute'} onClick={() => setMicOn((v) => !v)} icon={micOn ? Mic : MicOff} />
                <RoundButton on={camOn} label={camOn ? 'Turn camera off' : 'Turn camera on'} onClick={() => void toggleCam()} icon={camOn ? Video : VideoOff} />
              </div>
            </div>
            <div className="flex flex-col justify-center gap-3">
              <p className="text-sm">
                Joining as <strong>{prep?.you.name}</strong>
                {prep?.you.guest && <Badge className="ml-2">Guest</Badge>}
              </p>
              {stage === 'lobby' ? (
                <Alert tone="info">Waiting for someone in the meeting to let you in…</Alert>
              ) : (
                <Button
                  variant="primary"
                  loading={stage === 'joining'}
                  onClick={async () => {
                    if (prep?.you.guest) {
                      try {
                        await ask(socket, 'call:knock', { code });
                        setStage('lobby');
                      } catch (e) {
                        setError((e as Error).message);
                        setStage('error');
                      }
                    } else void join();
                  }}
                >
                  {prep?.you.guest ? 'Ask to join' : 'Join now'}
                </Button>
              )}
              {!guestPass && (
                <Button variant="ghost" onClick={() => navigate(-1)}>
                  Cancel
                </Button>
              )}
            </div>
          </div>
        </div>
      </Dark>
    );

  // In the meeting
  const everyone: (PeerInfo & { local?: boolean })[] = me ? [{ ...me, handRaised: hand, local: true }, ...peers.filter((p) => p.id !== me.id)] : peers;
  const screen = remotes.find((r) => r.source === 'screen');
  const tile = (p: PeerInfo & { local?: boolean }) => {
    const cam = p.local ? (camOn ? localStream : null) : (remotes.find((r) => r.peerId === p.id && r.source === 'cam' && !r.paused)?.stream ?? null);
    const audio = remotes.find((r) => r.peerId === p.id && r.source === 'mic');
    const muted = p.local ? !micOn : !audio || audio.paused;
    return <Tile key={p.id} name={p.local ? `${p.name} (you)` : p.name} stream={cam} local={!!p.local} muted={muted} hand={p.handRaised} guest={p.guest} audio={p.local ? (micOn ? localStream : null) : audio?.stream ?? null} />;
  };

  return (
    <div className="flex h-dvh flex-col bg-zinc-950 text-white">
      <header className="flex items-center gap-3 px-4 py-2">
        <h1 className="min-w-0 flex-1 truncate font-medium">{prep?.meeting.title}</h1>
        {recording && (
          <span className="flex items-center gap-1.5 rounded-full bg-red-600/20 px-2.5 py-1 text-xs text-red-300">
            <Circle className="size-2.5 fill-red-500 text-red-500" /> Recording
          </span>
        )}
        <span className="text-sm text-zinc-400">{everyone.length} in the meeting</span>
      </header>
      <div className="flex min-h-0 flex-1">
        <main className="relative min-w-0 flex-1 p-3">
          {screen || sharing ? (
            <div className="flex h-full flex-col gap-3">
              <div className="min-h-0 flex-1 overflow-hidden rounded-2xl bg-black">
                {screen ? <VideoEl stream={screen.stream} contain /> : <div className="flex h-full items-center justify-center text-zinc-400">You’re sharing your screen</div>}
              </div>
              <div className="flex h-32 gap-3 overflow-x-auto">{everyone.map((p) => <div key={p.id} className="aspect-video h-full shrink-0">{tile(p)}</div>)}</div>
            </div>
          ) : (
            <div className={cn('grid h-full gap-3', everyone.length <= 1 ? 'grid-cols-1' : everyone.length <= 4 ? 'grid-cols-1 sm:grid-cols-2' : everyone.length <= 9 ? 'grid-cols-2 lg:grid-cols-3' : 'grid-cols-3 lg:grid-cols-4')} style={{ gridAutoRows: '1fr' }}>
              {everyone.map(tile)}
            </div>
          )}
          <div className="pointer-events-none absolute bottom-4 left-4 flex flex-col gap-1">
            {reactions.map((r) => (
              <span key={r.id} className="animate-bounce text-4xl">
                {r.emoji}
              </span>
            ))}
          </div>
          {/* Everyone else's audio */}
          {remotes.filter((r) => r.kind === 'audio').map((r) => <AudioEl key={r.producerId} stream={r.stream} />)}
        </main>
        {panel && (
          <aside className="w-80 shrink-0 overflow-y-auto border-l border-zinc-800 p-3">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-medium">People</h2>
              <button type="button" aria-label="Close" onClick={() => setPanel(false)} className="rounded p-1 hover:bg-zinc-800">
                <X className="size-4" />
              </button>
            </div>
            {lobby.length > 0 && (
              <section className="mb-4">
                <h3 className="mb-1 text-xs font-semibold text-zinc-400 uppercase">Waiting in the lobby</h3>
                <ul className="space-y-1">
                  {lobby.map((g) => (
                    <li key={g.id} className="flex items-center gap-2 text-sm">
                      <Avatar name={g.name} size="sm" />
                      <span className="min-w-0 flex-1 truncate">{g.name} <span className="text-zinc-500">(guest)</span></span>
                      <button type="button" aria-label={`Admit ${g.name}`} onClick={() => void ask(socket, 'call:admit', { guestId: g.id, admit: true }).catch((e) => toast.error(e.message))} className="rounded p-1 text-emerald-400 hover:bg-zinc-800">
                        <UserCheck className="size-4" />
                      </button>
                      <button type="button" aria-label={`Deny ${g.name}`} onClick={() => void ask(socket, 'call:admit', { guestId: g.id, admit: false }).catch((e) => toast.error(e.message))} className="rounded p-1 text-red-400 hover:bg-zinc-800">
                        <UserX className="size-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <ul className="space-y-1">
              {everyone.map((p) => (
                <li key={p.id} className="flex items-center gap-2 text-sm">
                  <Avatar name={p.name} size="sm" />
                  <span className="min-w-0 flex-1 truncate">
                    {p.name}
                    {p.local && ' (you)'}
                    {p.host && <span className="text-zinc-500"> · organiser</span>}
                    {p.guest && <span className="text-zinc-500"> · guest</span>}
                  </span>
                  {p.handRaised && <Hand className="size-4 text-amber-400" />}
                  {me?.host && !p.local && (
                    <>
                      <button type="button" aria-label={`Mute ${p.name}`} onClick={() => void ask(socket, 'call:mute', { peerId: p.id }).catch((e) => toast.error(e.message))} className="rounded p-1 hover:bg-zinc-800">
                        <MicOff className="size-4" />
                      </button>
                      <button type="button" aria-label={`Remove ${p.name}`} onClick={() => window.confirm(`Remove ${p.name} from the meeting?`) && void ask(socket, 'call:remove', { peerId: p.id }).catch((e) => toast.error(e.message))} className="rounded p-1 text-red-400 hover:bg-zinc-800">
                        <UserX className="size-4" />
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
            {!guestPass && (
              <p className="mt-4 text-xs text-zinc-500">
                Invite people with the meeting link: <span className="break-all text-zinc-300">{window.location.origin}/team/meet/{code}</span>
              </p>
            )}
          </aside>
        )}
      </div>
      <footer className="flex flex-wrap items-center justify-center gap-2 px-4 py-3">
        <RoundButton on={micOn} label={micOn ? 'Mute' : 'Unmute'} onClick={() => void toggleMic()} icon={micOn ? Mic : MicOff} />
        <RoundButton on={camOn} label={camOn ? 'Turn camera off' : 'Turn camera on'} onClick={() => void toggleCam()} icon={camOn ? Video : VideoOff} />
        {'getDisplayMedia' in (navigator.mediaDevices ?? {}) && <RoundButton on={!sharing} active={sharing} label={sharing ? 'Stop sharing' : 'Share your screen'} onClick={() => void toggleShare()} icon={MonitorUp} />}
        <RoundButton on active={hand} label={hand ? 'Lower your hand' : 'Raise your hand'} onClick={() => void raiseHand()} icon={Hand} />
        <ReactionButton onReact={(emoji) => void ask(socket, 'call:reaction', { emoji })} />
        <RoundButton on active={panel} label="People" onClick={() => setPanel((v) => !v)} icon={Users} badge={lobby.length || undefined} />
        {recordingAllowed && <RoundButton on active={recording} label={recording ? 'Stop recording' : 'Record'} onClick={() => void record()} icon={recording ? Square : Circle} />}
        <button type="button" onClick={() => void leave()} className="ml-2 flex items-center gap-2 rounded-full bg-red-600 px-5 py-3 text-sm font-medium hover:bg-red-500">
          <PhoneOff className="size-5" /> Leave
        </button>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function Dark({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-dvh items-center justify-center bg-zinc-950 p-4 text-white">{children}</div>;
}

function VideoEl({ stream, muted, mirror, contain }: { stream: MediaStream; muted?: boolean; mirror?: boolean; contain?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream;
  }, [stream]);
  return <video ref={ref} autoPlay playsInline muted={muted} className={cn('h-full w-full', contain ? 'object-contain' : 'object-cover', mirror && '-scale-x-100')} />;
}

function AudioEl({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    if (ref.current) {
      ref.current.srcObject = stream;
      void ref.current.play().catch(() => {});
    }
  }, [stream]);
  return <audio ref={ref} autoPlay />;
}

/** Whether someone is speaking, from their audio level. */
function useSpeaking(stream: MediaStream | null) {
  const [speaking, setSpeaking] = useState(false);
  useEffect(() => {
    const track = stream?.getAudioTracks()[0];
    if (!track) return;
    const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(new MediaStream([track])).connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const t = setInterval(() => {
      analyser.getByteFrequencyData(data);
      const level = data.reduce((a, b) => a + b, 0) / data.length;
      setSpeaking(level > 18);
    }, 200);
    return () => {
      clearInterval(t);
      void ctx.close();
    };
  }, [stream]);
  return speaking;
}

function Tile({ name, stream, audio, local, muted, hand, guest }: { name: string; stream: MediaStream | null; audio: MediaStream | null; local: boolean; muted: boolean; hand: boolean; guest: boolean }) {
  const speaking = useSpeaking(muted ? null : audio);
  return (
    <div className={cn('relative h-full min-h-32 overflow-hidden rounded-2xl bg-zinc-800 ring-2 transition', speaking ? 'ring-emerald-400' : 'ring-transparent')}>
      {stream?.getVideoTracks().length ? <VideoEl stream={stream} muted mirror={local} /> : <Placeholder name={name} />}
      <div className="absolute inset-x-2 bottom-2 flex items-center gap-1.5">
        <span className="flex min-w-0 items-center gap-1.5 rounded-md bg-black/60 px-2 py-0.5 text-xs">
          {muted && <MicOff className="size-3.5 shrink-0 text-red-400" />}
          <span className="truncate">{name}</span>
          {guest && <span className="text-zinc-400">(guest)</span>}
        </span>
      </div>
      {hand && (
        <span className="absolute top-2 left-2 rounded-full bg-amber-400 p-1.5 text-zinc-900" aria-label="Hand raised">
          <Hand className="size-4" />
        </span>
      )}
    </div>
  );
}

function Placeholder({ name }: { name: string }) {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <span className="flex size-20 items-center justify-center rounded-full bg-violet-600 text-3xl font-semibold">{name.replace(/\(you\)/, '').trim().slice(0, 1).toUpperCase()}</span>
    </div>
  );
}

function RoundButton({ on, active, label, onClick, icon: Icon, badge }: { on: boolean; active?: boolean; label: string; onClick: () => void; icon: typeof Mic; badge?: number }) {
  return (
    <button type="button" title={label} aria-label={label} aria-pressed={active} onClick={onClick} className={cn('relative rounded-full p-3 transition', !on ? 'bg-red-600 hover:bg-red-500' : active ? 'bg-brand hover:opacity-90' : 'bg-zinc-800 hover:bg-zinc-700')}>
      <Icon className="size-5" />
      {badge ? <span className="absolute -top-1 -right-1 flex size-5 items-center justify-center rounded-full bg-amber-400 text-xs font-semibold text-zinc-900">{badge}</span> : null}
    </button>
  );
}

function ReactionButton({ onReact }: { onReact: (emoji: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative">
      <RoundButton on label="React" onClick={() => setOpen((o) => !o)} icon={Smile} />
      {open && (
        <span className="absolute bottom-14 left-1/2 flex -translate-x-1/2 gap-1 rounded-full bg-zinc-800 p-1.5">
          {['👍', '❤️', '😂', '👏', '🎉', '😮'].map((e) => (
            <button key={e} type="button" onClick={() => (onReact(e), setOpen(false))} className="rounded-full p-1.5 text-xl hover:bg-zinc-700">
              {e}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}
