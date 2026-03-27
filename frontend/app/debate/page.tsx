'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth, useUser } from '@clerk/nextjs';
import { useRouter } from 'next/navigation';
import { Swords, ArrowLeft, Loader2 } from 'lucide-react';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
const DEBATE_ROUNDS = Number(process.env.NEXT_PUBLIC_DEBATE_ROUNDS ?? '3');
const TURNS_PER_ROUND = 2; // number of agents
const TOTAL_TURNS = DEBATE_ROUNDS * TURNS_PER_ROUND;
const TYPEWRITER_MS = 18; // ms per character

interface Twin {
  twin_id: string;
  name: string;
  title: string;
  archetype_display_name?: string;
}

interface HistoryEntry {
  twin_name: string;
  text: string;
}

interface CompletedTurn {
  twin_id: string;
  twin_name: string;
  text: string;
  turnIndex: number;
}

type PageState = 'setup' | 'running' | 'done';

export default function DebatePage() {
  const { getToken, isSignedIn, isLoaded } = useAuth();
  const { user } = useUser();
  const router = useRouter();

  const [twins, setTwins] = useState<Twin[]>([]);
  const [twinsLoading, setTwinsLoading] = useState(true);
  const [twinsError, setTwinsError] = useState('');

  const [twinIdA, setTwinIdA] = useState('');
  const [twinIdB, setTwinIdB] = useState('');
  const [topic, setTopic] = useState('');

  const [pageState, setPageState] = useState<PageState>('setup');
  const [debateError, setDebateError] = useState('');

  // Completed turns (fully animated)
  const [completedTurns, setCompletedTurns] = useState<CompletedTurn[]>([]);
  // Turn currently being typewriter-animated
  const [animating, setAnimating] = useState<{ twin_id: string; twin_name: string; displayedText: string; turnIndex: number } | null>(null);
  // Which side is waiting for the API response
  const [typingFor, setTypingFor] = useState<'A' | 'B' | null>(null);

  const cancelledRef = useRef(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Cancel any in-flight animation and requests on unmount
  useEffect(() => {
    return () => {
      cancelledRef.current = true;
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      abortControllerRef.current?.abort();
    };
  }, []);

  // Redirect to sign-in if unauthenticated
  useEffect(() => {
    if (isLoaded && !isSignedIn) router.push('/sign-in');
  }, [isLoaded, isSignedIn, router]);

  // Load user's twins
  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      setTwinsLoading(false);
      return;
    }
    async function fetchTwins() {
      try {
        const token = await getToken();
        if (!token) { setTwinsError('Unable to retrieve auth token.'); return; }
        const res = await fetch(`${API}/users/me/twins`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`${res.status}`);
        const data = await res.json();
        setTwins(data.twins || []);
      } catch {
        setTwinsError('Failed to load your twins.');
      } finally {
        setTwinsLoading(false);
      }
    }
    fetchTwins();
  }, [isLoaded, isSignedIn, getToken]);

  // Auto-scroll when a new turn starts or finishes (not on every typewriter tick)
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [completedTurns.length, animating?.turnIndex]);

  const twinA = twins.find(t => t.twin_id === twinIdA);
  const twinB = twins.find(t => t.twin_id === twinIdB);
  const canStart = twinIdA && twinIdB && twinIdA !== twinIdB && topic.trim();

  // Returns a promise that resolves once all characters have been typed out
  const animateText = useCallback(
    (twin_id: string, twin_name: string, text: string, turnIndex: number): Promise<void> => {
      return new Promise(resolve => {
        setAnimating({ twin_id, twin_name, displayedText: '', turnIndex });
        let i = 0;
        intervalRef.current = setInterval(() => {
          if (cancelledRef.current) {
            clearInterval(intervalRef.current!);
            intervalRef.current = null;
            resolve();
            return;
          }
          i++;
          setAnimating(prev =>
            prev ? { ...prev, displayedText: text.slice(0, i) } : prev
          );
          if (i >= text.length) {
            clearInterval(intervalRef.current!);
            intervalRef.current = null;
            resolve();
          }
        }, TYPEWRITER_MS);
      });
    },
    []
  );

  async function startDebate() {
    if (!canStart || pageState !== 'setup') return;
    cancelledRef.current = false;
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setPageState('running');
    setDebateError('');
    setCompletedTurns([]);
    setAnimating(null);
    setTypingFor(null);

    const token = await getToken();
    if (!token) {
      setPageState('setup');
      setTypingFor(null);
      setAnimating(null);
      router.push('/sign-in');
      return;
    }

    const history: HistoryEntry[] = [];
    const twinOrder = [twinIdA, twinIdB];

    for (let i = 0; i < TOTAL_TURNS; i++) {
      if (cancelledRef.current) break;

      const currentTwinId = twinOrder[i % 2];
      setTypingFor(i % 2 === 0 ? 'A' : 'B');

      let data: { twin_id: string; twin_name: string; text: string };
      try {
        const res = await fetch(`${API}/debate/turn`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ twin_id: currentTwinId, topic: topic.trim(), history }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error((err as { detail?: string }).detail || 'Turn failed');
        }
        data = await res.json();
      } catch (err) {
        if (cancelledRef.current) return; // intentional cancellation — don't show error
        setDebateError(err instanceof Error ? err.message : 'Something went wrong');
        setPageState('setup');
        setTypingFor(null);
        setAnimating(null);
        return;
      }

      if (cancelledRef.current) break;
      setTypingFor(null);

      await animateText(data.twin_id, data.twin_name, data.text, i);
      if (cancelledRef.current) break;

      setAnimating(null);
      setCompletedTurns(prev => [
        ...prev,
        { twin_id: data.twin_id, twin_name: data.twin_name, text: data.text, turnIndex: i },
      ]);
      history.push({ twin_name: data.twin_name, text: data.text });
    }

    if (!cancelledRef.current) {
      setPageState('done');
    }
  }

  function reset() {
    cancelledRef.current = true;
    abortControllerRef.current?.abort();
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setPageState('setup');
    setCompletedTurns([]);
    setAnimating(null);
    setTypingFor(null);
    setDebateError('');
  }

  const initials = (name: string) =>
    name.split(' ').filter(n => n.length > 0).map(n => n[0]).join('').slice(0, 2).toUpperCase();

  const isA = (twin_id: string) => twin_id === twinIdA;

  function TurnBubble({ twin_id, twin_name, text, cursor = false }: {
    twin_id: string; twin_name: string; text: string; cursor?: boolean;
  }) {
    const a = isA(twin_id);
    return (
      <div className={`flex gap-3 ${a ? 'justify-start' : 'justify-end'}`}>
        {a && twinA && (
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center text-white text-xs font-bold shrink-0 mt-1">
            {initials(twinA.name)}
          </div>
        )}
        <div className={`max-w-[72%] rounded-xl px-4 py-3 ${
          a
            ? 'bg-white border border-gray-200 text-gray-800'
            : 'bg-gradient-to-br from-rose-500 to-orange-500 text-white'
        }`}>
          <p className={`text-xs font-medium mb-1 ${a ? 'text-purple-600' : 'text-rose-100'}`}>
            {twin_name}
          </p>
          <p className="text-sm leading-relaxed">
            {text}
            {cursor && <span className="inline-block w-0.5 h-4 bg-current ml-0.5 animate-pulse align-text-bottom" />}
          </p>
        </div>
        {!a && twinB && (
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-rose-500 to-orange-500 flex items-center justify-center text-white text-xs font-bold shrink-0 mt-1">
            {initials(twinB.name)}
          </div>
        )}
      </div>
    );
  }

  function TypingIndicator({ side }: { side: 'A' | 'B' }) {
    const a = side === 'A';
    return (
      <div className={`flex gap-3 ${a ? 'justify-start' : 'justify-end'}`}>
        {a && twinA && (
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center text-white text-xs font-bold shrink-0 mt-1">
            {initials(twinA.name)}
          </div>
        )}
        <div className="bg-white border border-gray-200 rounded-xl px-4 py-3">
          <div className="flex space-x-1.5 items-center h-4">
            <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
            <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
            <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
          </div>
        </div>
        {!a && twinB && (
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-rose-500 to-orange-500 flex items-center justify-center text-white text-xs font-bold shrink-0 mt-1">
            {initials(twinB.name)}
          </div>
        )}
      </div>
    );
  }

  if (!isLoaded || twinsLoading) {
    return (
      <main className="min-h-screen bg-gray-50 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-purple-500" />
      </main>
    );
  }

  const isActive = pageState === 'running' || pageState === 'done';

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-3xl mx-auto px-4 py-10">

        {/* Header */}
        <div className="mb-8">
          <button onClick={() => router.push('/dashboard')}
            className="flex items-center gap-1 text-sm text-gray-400 hover:text-gray-600 mb-4">
            <ArrowLeft className="w-4 h-4" /> Dashboard
          </button>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-purple-600 flex items-center justify-center">
              <Swords className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Persona vs Persona</h1>
              <p className="text-sm text-gray-500">Put two of your twins in a debate</p>
            </div>
          </div>
        </div>

        {twinsError && (
          <div className="mb-6 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-3">
            {twinsError}
          </div>
        )}

        {twins.length < 2 ? (
          <div className="text-center py-16 text-gray-500">
            <p className="mb-3">You need at least 2 twins to start a debate.</p>
            <button onClick={() => router.push('/create')}
              className="text-sm text-purple-600 hover:text-purple-800 underline">
              Create another twin
            </button>
          </div>
        ) : (
          <>
            {/* Setup form — always visible except during active debate */}
            {pageState === 'setup' && (
              <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
                <div className="grid grid-cols-2 gap-4 mb-5">
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1.5">Twin A</label>
                    <select
                      value={twinIdA}
                      onChange={e => setTwinIdA(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-purple-500"
                    >
                      <option value="">Select twin…</option>
                      {twins.filter(t => t.twin_id !== twinIdB).map(t => (
                        <option key={t.twin_id} value={t.twin_id}>{t.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1.5">Twin B</label>
                    <select
                      value={twinIdB}
                      onChange={e => setTwinIdB(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-purple-500"
                    >
                      <option value="">Select twin…</option>
                      {twins.filter(t => t.twin_id !== twinIdA).map(t => (
                        <option key={t.twin_id} value={t.twin_id}>{t.name}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="mb-5">
                  <label className="block text-xs font-medium text-gray-500 mb-1.5">Debate topic</label>
                  <input
                    type="text"
                    value={topic}
                    onChange={e => setTopic(e.target.value)}
                    placeholder="e.g. 'Is remote work better than in-office?'"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-purple-500"
                    onKeyDown={e => e.key === 'Enter' && startDebate()}
                  />
                </div>

                {debateError && (
                  <p className="text-sm text-red-500 mb-3">{debateError}</p>
                )}

                <button
                  onClick={startDebate}
                  disabled={!canStart}
                  className="w-full py-2.5 bg-purple-600 text-white text-sm font-medium rounded-lg hover:bg-purple-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Start Debate
                </button>
              </div>
            )}

            {/* Live debate area */}
            {isActive && twinA && twinB && (
              <div>
                {/* Combatants banner */}
                <div className="flex items-center justify-between mb-6 px-1">
                  <div className="flex items-center gap-2">
                    <div className="w-10 h-10 rounded-full bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center text-white text-sm font-bold">
                      {initials(twinA.name)}
                    </div>
                    <div>
                      <p className="font-semibold text-gray-900 text-sm">{twinA.name}</p>
                      {twinA.title && <p className="text-xs text-gray-400">{twinA.title}</p>}
                    </div>
                  </div>
                  <span className="text-xs font-bold text-gray-400 tracking-widest">VS</span>
                  <div className="flex items-center gap-2 flex-row-reverse">
                    <div className="w-10 h-10 rounded-full bg-gradient-to-br from-rose-500 to-orange-500 flex items-center justify-center text-white text-sm font-bold">
                      {initials(twinB.name)}
                    </div>
                    <div className="text-right">
                      <p className="font-semibold text-gray-900 text-sm">{twinB.name}</p>
                      {twinB.title && <p className="text-xs text-gray-400">{twinB.title}</p>}
                    </div>
                  </div>
                </div>

                {/* Topic pill */}
                <div className="text-center mb-6">
                  <span className="inline-block text-xs text-purple-600 bg-purple-50 border border-purple-100 px-3 py-1 rounded-full">
                    {topic}
                  </span>
                </div>

                {/* Turn feed */}
                <div className="space-y-4">
                  {completedTurns.map(turn => (
                    <TurnBubble
                      key={turn.turnIndex}
                      twin_id={turn.twin_id}
                      twin_name={turn.twin_name}
                      text={turn.text}
                    />
                  ))}

                  {/* Typewriter bubble */}
                  {animating && (
                    <TurnBubble
                      twin_id={animating.twin_id}
                      twin_name={animating.twin_name}
                      text={animating.displayedText}
                      cursor
                    />
                  )}

                  {/* Waiting-for-API dots */}
                  {typingFor && <TypingIndicator side={typingFor} />}
                </div>

                {pageState === 'done' && (
                  <div className="text-center mt-8">
                    <button
                      onClick={reset}
                      className="px-6 py-2.5 bg-gray-100 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-200 transition-colors"
                    >
                      Start a new debate
                    </button>
                  </div>
                )}

                {pageState === 'running' && (
                  <div className="text-center mt-6">
                    <button
                      onClick={reset}
                      className="text-xs text-gray-400 hover:text-gray-600 underline"
                    >
                      Cancel
                    </button>
                  </div>
                )}

                <div ref={bottomRef} />
              </div>
            )}
          </>
        )}

        <p className="text-center text-xs text-gray-400 mt-10">
          Signed in as {user?.firstName || user?.emailAddresses[0]?.emailAddress}
        </p>
      </div>
    </main>
  );
}
