'use client';

import { useState, useRef, useEffect } from 'react';
import type { KeyboardEvent } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useAuth } from '@clerk/nextjs';
import { Send, Sparkles } from 'lucide-react';
import AppNav from '@/components/app-nav';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

interface FieldUpdates {
  pastDecisions?: string;
  nonNegotiables?: string;
  softPreferences?: string;
  mindChange?: string;
}

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

export default function DeepenPage() {
  const { twin_id } = useParams<{ twin_id: string }>();
  const router = useRouter();
  const { getToken, isSignedIn, isLoaded } = useAuth();

  const [twinName, setTwinName] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [topicsCovered, setTopicsCovered] = useState<string[]>([]);
  const [fieldsCollected, setFieldsCollected] = useState<Record<string, string>>({});
  const [done, setDone] = useState(false);
  const [loadError, setLoadError] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const startedRef = useRef(false);

  // Redirect if not signed in once auth loads
  useEffect(() => {
    if (isLoaded && !isSignedIn) router.replace('/sign-in');
  }, [isLoaded, isSignedIn, router]);

  // Load twin name for the header
  useEffect(() => {
    if (!twin_id) return;
    fetch(`${API}/twin/${twin_id}`)
      .then(r => {
        if (!r.ok) throw new Error('not found');
        return r.json();
      })
      .then(data => setTwinName(data.name || ''))
      .catch(() => setLoadError("Couldn't load twin."));
  }, [twin_id]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Kick off the session automatically once we have auth — useRef guards against
  // the double-invoke that React Strict Mode causes in development.
  useEffect(() => {
    if (!isSignedIn || startedRef.current || messages.length > 0 || done) return;
    startedRef.current = true;
    callDeepen('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSignedIn]);

  const callDeepen = async (userText: string) => {
    if (sending) return;
    setSending(true);

    const token = await getToken();
    if (!token) { setSending(false); router.push('/sign-in'); return; }

    const newHistory = userText
      ? [...messages, { id: crypto.randomUUID(), role: 'user' as const, content: userText }]
      : messages;

    if (userText) {
      setMessages(newHistory);
      setInput('');
    }

    try {
      const res = await fetch(`${API}/twin/${twin_id}/deepen/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          history: newHistory.map(m => ({ role: m.role, content: m.content })),
          topics_covered: topicsCovered,
          fields_collected: fieldsCollected,
        }),
      });

      if (!res.ok) throw new Error('Request failed');
      const data = await res.json();

      setMessages(prev => [
        ...prev,
        { id: crypto.randomUUID(), role: 'assistant', content: data.message },
      ]);

      if (data.topics_covered?.length) setTopicsCovered(data.topics_covered);
      if (data.field_updates && Object.keys(data.field_updates).length) {
        setFieldsCollected(prev => {
          const next = { ...prev };
          for (const [k, v] of Object.entries(data.field_updates as FieldUpdates)) {
            if (v) {
              if (k === 'pastDecisions' && next[k]) {
                next[k] = next[k] + '\n\n' + v;
              } else {
                next[k] = v as string;
              }
            }
          }
          return next;
        });
      }

      if (data.done) setDone(true);
    } catch {
      setMessages(prev => [
        ...prev,
        { id: crypto.randomUUID(), role: 'assistant', content: 'Something went wrong. Please try again.' },
      ]);
    } finally {
      setSending(false);
    }
  };

  const handleSend = () => {
    if (!input.trim() || sending || done) return;
    callDeepen(input.trim());
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  if (!isLoaded || (!isSignedIn && !loadError)) {
    return (
      <main className="min-h-screen bg-gradient-to-br from-slate-50 to-gray-100 flex items-center justify-center">
        <div className="flex gap-2">
          <div className="w-2 h-2 bg-purple-400 rounded-full animate-bounce" />
          <div className="w-2 h-2 bg-purple-400 rounded-full animate-bounce delay-100" />
          <div className="w-2 h-2 bg-purple-400 rounded-full animate-bounce delay-200" />
        </div>
      </main>
    );
  }

  if (loadError) {
    return (
      <main className="min-h-screen bg-gradient-to-br from-slate-50 to-gray-100 flex items-center justify-center">
        <div className="text-center">
          <p className="text-gray-500 mb-4">{loadError}</p>
          <button onClick={() => router.push('/dashboard')} className="text-purple-600 underline text-sm">Back to dashboard</button>
        </div>
      </main>
    );
  }

  const firstName = twinName.split(' ')[0] || 'your twin';

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-50 to-gray-100">
      <AppNav />
      <div className="container mx-auto px-4 py-8">
        <div className="max-w-2xl mx-auto">

          {/* Header */}
          <div className="mb-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center">
              <Sparkles className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-gray-800">Deepen {firstName}&apos;s twin</h1>
              <p className="text-sm text-gray-500">3 quick questions to sharpen how your twin reasons</p>
            </div>
          </div>

          {/* Progress dots */}
          <div className="flex items-center gap-2 mb-4">
            {['PAST_DECISIONS', 'NON_NEGOTIABLES', 'MIND_CHANGE'].map(topic => (
              <div
                key={topic}
                className={`h-1.5 flex-1 rounded-full transition-colors ${topicsCovered.includes(topic) ? 'bg-purple-500' : 'bg-gray-200'}`}
              />
            ))}
          </div>

          {/* Chat */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 flex flex-col" style={{ height: '480px' }}>
            <div className="bg-gradient-to-r from-purple-600 to-blue-600 text-white p-4 rounded-t-xl">
              <p className="font-semibold text-sm">Depth interview</p>
              <p className="text-xs text-purple-100 mt-0.5">Your answers will improve how your twin handles hard questions</p>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {messages.map(m => (
                <div key={m.id} className={`flex gap-3 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  {m.role === 'assistant' && (
                    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center shrink-0">
                      <Sparkles className="w-4 h-4 text-white" />
                    </div>
                  )}
                  <div className={`max-w-[80%] rounded-lg p-3 text-sm ${m.role === 'user' ? 'bg-slate-700 text-white' : 'bg-gray-50 border border-gray-200 text-gray-800'}`}>
                    <p className="whitespace-pre-wrap">{m.content}</p>
                  </div>
                </div>
              ))}

              {sending && (
                <div className="flex gap-3 justify-start">
                  <div className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center shrink-0">
                    <Sparkles className="w-4 h-4 text-white" />
                  </div>
                  <div className="bg-gray-50 border border-gray-200 rounded-lg p-3">
                    <div className="flex space-x-1.5">
                      <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" />
                      <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce delay-100" />
                      <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce delay-200" />
                    </div>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {done ? (
              <div className="border-t border-gray-100 p-4 bg-purple-50 rounded-b-xl text-center">
                <p className="text-sm font-medium text-purple-700 mb-2">Twin updated</p>
                <p className="text-xs text-gray-500 mb-3">
                  {firstName}&apos;s reasoning has been sharpened with your new answers.
                </p>
                <button
                  onClick={() => router.push('/dashboard')}
                  className="px-4 py-2 bg-purple-600 text-white text-sm rounded-lg hover:bg-purple-700 transition-colors"
                >
                  Back to dashboard
                </button>
              </div>
            ) : (
              <div className="border-t border-gray-100 p-4">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Type your answer..."
                    className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 text-gray-800 text-sm"
                    disabled={sending}
                  />
                  <button
                    onClick={handleSend}
                    disabled={!input.trim() || sending}
                    className="px-4 py-2 bg-slate-700 text-white rounded-lg hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    <Send className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}
          </div>

        </div>
      </div>
    </main>
  );
}
