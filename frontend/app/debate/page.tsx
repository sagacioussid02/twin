'use client';

import { useState, useEffect, useRef } from 'react';
import { useAuth, useUser } from '@clerk/nextjs';
import { useRouter } from 'next/navigation';
import { Swords, ArrowLeft, Loader2 } from 'lucide-react';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

interface Twin {
  twin_id: string;
  name: string;
  title: string;
  archetype_display_name?: string;
}

interface DebateTurn {
  twin_id: string;
  twin_name: string;
  turn_number: number;
  text: string;
}

type PageState = 'setup' | 'loading' | 'result';

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

  // Debate result — turns are revealed progressively
  const [turns, setTurns] = useState<DebateTurn[]>([]);
  const [visibleCount, setVisibleCount] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Redirect to sign-in if unauthenticated
  useEffect(() => {
    if (isLoaded && !isSignedIn) router.push('/sign-in');
  }, [isLoaded, isSignedIn, router]);

  // Load user's twins
  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
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

  // Progressively reveal turns once debate result arrives
  useEffect(() => {
    if (turns.length === 0 || pageState !== 'result') return;
    setVisibleCount(0);
    let i = 0;
    const interval = setInterval(() => {
      i += 1;
      setVisibleCount(i);
      if (i >= turns.length) clearInterval(interval);
    }, 1200);
    return () => clearInterval(interval);
  }, [turns, pageState]);

  // Auto-scroll as turns appear
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [visibleCount]);

  const twinA = twins.find(t => t.twin_id === twinIdA);
  const twinB = twins.find(t => t.twin_id === twinIdB);
  const canStart = twinIdA && twinIdB && twinIdA !== twinIdB && topic.trim();

  async function startDebate() {
    if (!canStart) return;
    setPageState('loading');
    setDebateError('');
    setTurns([]);
    setVisibleCount(0);
    try {
      const token = await getToken();
      if (!token) { router.push('/sign-in'); return; }
      const res = await fetch(`${API}/chat/debate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ twin_id_a: twinIdA, twin_id_b: twinIdB, topic: topic.trim() }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || 'Debate failed');
      }
      const data = await res.json();
      setTurns(data.turns || []);
      setPageState('result');
    } catch (err) {
      setDebateError(err instanceof Error ? err.message : 'Something went wrong');
      setPageState('setup');
    }
  }

  function reset() {
    setPageState('setup');
    setTurns([]);
    setVisibleCount(0);
    setDebateError('');
  }

  const initials = (name: string) =>
    name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();

  if (!isLoaded || twinsLoading) {
    return (
      <main className="min-h-screen bg-gray-50 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-purple-500" />
      </main>
    );
  }

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
            {/* Setup form */}
            {pageState !== 'loading' && (
              <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
                <div className="grid grid-cols-2 gap-4 mb-5">
                  {/* Twin A */}
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1.5">Twin A</label>
                    <select
                      value={twinIdA}
                      onChange={e => setTwinIdA(e.target.value)}
                      disabled={pageState === 'result'}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-purple-500 disabled:opacity-50"
                    >
                      <option value="">Select twin…</option>
                      {twins.filter(t => t.twin_id !== twinIdB).map(t => (
                        <option key={t.twin_id} value={t.twin_id}>{t.name}</option>
                      ))}
                    </select>
                  </div>

                  {/* Twin B */}
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1.5">Twin B</label>
                    <select
                      value={twinIdB}
                      onChange={e => setTwinIdB(e.target.value)}
                      disabled={pageState === 'result'}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-purple-500 disabled:opacity-50"
                    >
                      <option value="">Select twin…</option>
                      {twins.filter(t => t.twin_id !== twinIdA).map(t => (
                        <option key={t.twin_id} value={t.twin_id}>{t.name}</option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Topic */}
                <div className="mb-5">
                  <label className="block text-xs font-medium text-gray-500 mb-1.5">Debate topic</label>
                  <input
                    type="text"
                    value={topic}
                    onChange={e => setTopic(e.target.value)}
                    disabled={pageState === 'result'}
                    placeholder="e.g. 'Is remote work better than in-office?'"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-purple-500 disabled:opacity-50"
                    onKeyDown={e => e.key === 'Enter' && startDebate()}
                  />
                </div>

                {debateError && (
                  <p className="text-sm text-red-500 mb-3">{debateError}</p>
                )}

                {pageState === 'setup' ? (
                  <button
                    onClick={startDebate}
                    disabled={!canStart}
                    className="w-full py-2.5 bg-purple-600 text-white text-sm font-medium rounded-lg hover:bg-purple-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    Start Debate
                  </button>
                ) : (
                  <button
                    onClick={reset}
                    className="w-full py-2.5 bg-gray-100 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-200 transition-colors"
                  >
                    Start over
                  </button>
                )}
              </div>
            )}

            {/* Loading state */}
            {pageState === 'loading' && (
              <div className="text-center py-16">
                <Loader2 className="w-8 h-8 animate-spin text-purple-500 mx-auto mb-4" />
                <p className="text-gray-600 font-medium">
                  {twinA?.name} and {twinB?.name} are debating…
                </p>
                <p className="text-sm text-gray-400 mt-1">This usually takes 20–30 seconds</p>
              </div>
            )}

            {/* Debate result */}
            {pageState === 'result' && twinA && twinB && (
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

                {/* Turns */}
                <div className="space-y-4">
                  {turns.slice(0, visibleCount).map(turn => {
                    const isA = turn.twin_id === twinIdA;
                    return (
                      <div key={turn.turn_number}
                        className={`flex gap-3 ${isA ? 'justify-start' : 'justify-end'} animate-fade-in`}>
                        {isA && (
                          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center text-white text-xs font-bold shrink-0 mt-1">
                            {initials(twinA.name)}
                          </div>
                        )}
                        <div className={`max-w-[72%] rounded-xl px-4 py-3 ${
                          isA
                            ? 'bg-white border border-gray-200 text-gray-800'
                            : 'bg-gradient-to-br from-rose-500 to-orange-500 text-white'
                        }`}>
                          <p className={`text-xs font-medium mb-1 ${isA ? 'text-purple-600' : 'text-rose-100'}`}>
                            {turn.twin_name}
                          </p>
                          <p className="text-sm leading-relaxed">{turn.text}</p>
                        </div>
                        {!isA && (
                          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-rose-500 to-orange-500 flex items-center justify-center text-white text-xs font-bold shrink-0 mt-1">
                            {initials(twinB.name)}
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {/* Typing indicator while more turns are pending */}
                  {visibleCount < turns.length && (
                    <div className={`flex gap-3 ${visibleCount % 2 === 0 ? 'justify-start' : 'justify-end'}`}>
                      {visibleCount % 2 === 0 && (
                        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center text-white text-xs font-bold shrink-0 mt-1">
                          {initials(twinA.name)}
                        </div>
                      )}
                      <div className="bg-white border border-gray-200 rounded-xl px-4 py-3">
                        <div className="flex space-x-1.5">
                          <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" />
                          <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce delay-100" />
                          <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce delay-200" />
                        </div>
                      </div>
                      {visibleCount % 2 !== 0 && (
                        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-rose-500 to-orange-500 flex items-center justify-center text-white text-xs font-bold shrink-0 mt-1">
                          {initials(twinB.name)}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Done — start over */}
                {visibleCount >= turns.length && (
                  <div className="text-center mt-8">
                    <button onClick={reset}
                      className="px-6 py-2.5 bg-gray-100 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-200 transition-colors">
                      Start a new debate
                    </button>
                  </div>
                )}

                <div ref={bottomRef} />
              </div>
            )}
          </>
        )}

        {/* Link from dashboard footer */}
        <p className="text-center text-xs text-gray-400 mt-10">
          Signed in as {user?.firstName || user?.emailAddresses[0]?.emailAddress}
        </p>
      </div>
    </main>
  );
}
