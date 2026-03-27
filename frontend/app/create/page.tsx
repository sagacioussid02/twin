'use client';

import { useState, useEffect, useRef, type ChangeEvent } from 'react';
import { useAuth } from '@clerk/nextjs';
import { useRouter } from 'next/navigation';
import { Send, Paperclip, Loader2, Check } from 'lucide-react';
import Link from 'next/link';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

interface Message {
  role: 'ai' | 'user' | 'status';
  content: string;
}

interface ApiHistoryItem {
  role: 'user' | 'assistant';
  content: string;
}

interface FieldUpdates {
  name?: string;
  title?: string;
  bio?: string;
  skills?: string;
  experience?: string;
  achievements?: string;
  coreValues?: string;
  decisionStyle?: string;
  riskTolerance?: string;
  pastDecisions?: string;
  communicationStyle?: string;
  blindSpots?: string;
  verbalQuirks?: string;
  responseStyle?: string;
  archetype_id?: string | null;
  [key: string]: string | null | undefined;
}

type Phase = 'loading' | 'chat' | 'creating' | 'done';

export default function CreatePage() {
  const { getToken } = useAuth();
  const router = useRouter();

  const [phase, setPhase] = useState<Phase>('loading');
  const [messages, setMessages] = useState<Message[]>([]);
  const [apiHistory, setApiHistory] = useState<ApiHistoryItem[]>([]);
  const [fieldsCollected, setFieldsCollected] = useState<FieldUpdates>({});
  const [topicsCovered, setTopicsCovered] = useState<string[]>([]);
  const [linkedinParsed, setLinkedinParsed] = useState<Record<string, unknown> | null>(null);

  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [createError, setCreateError] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending]);

  // Auto-resize textarea
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [input]);

  // Fetch opening message on mount
  useEffect(() => {
    let cancelled = false;
    async function init() {
      let redirected = false;
      try {
        const token = await getToken();
        if (!token) { router.push('/sign-in'); redirected = true; return; }
        const res = await fetch(`${API}/onboard/message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ history: [], fields_collected: {}, topics_covered: [] }),
        });
        if (!res.ok) throw new Error('start failed');
        const data = await res.json();
        if (cancelled) return;
        setMessages([{ role: 'ai', content: data.message }]);
        if (data.field_updates) setFieldsCollected(prev => ({ ...prev, ...data.field_updates }));
        if (data.topics_covered) setTopicsCovered(data.topics_covered);
      } catch {
        if (cancelled) return;
        // Fallback opening so the page is never blank
        setMessages([{
          role: 'ai',
          content: "Hey! Let's build your AI twin. Before we dive in — got your LinkedIn PDF? I can read it and skip the professional background questions. Hit the 📎 below to attach, or just type skip to go from scratch.",
        }]);
      } finally {
        if (!cancelled && !redirected) setPhase('chat');
      }
    }
    init();
    return () => { cancelled = true; };
  }, [getToken, router]);

  async function callOnboard(
    newApiHistory: ApiHistoryItem[],
    fields: FieldUpdates,
    topics: string[],
    linkedin: Record<string, unknown> | null,
    token: string,
  ) {
    setSending(true);
    try {
      const res = await fetch(`${API}/onboard/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          history: newApiHistory,
          linkedin_parsed: linkedin,
          fields_collected: fields,
          topics_covered: topics,
        }),
      });
      if (!res.ok) throw new Error('response failed');
      const data = await res.json();

      const updatedFields: FieldUpdates = { ...fields, ...(data.field_updates || {}) };
      const updatedTopics: string[] = data.topics_covered || topics;

      setFieldsCollected(updatedFields);
      setTopicsCovered(updatedTopics);
      setMessages(prev => [...prev, { role: 'ai', content: data.message }]);
      setApiHistory(prev => [...prev, { role: 'assistant', content: data.message }]);

      if (data.done && data.twin_payload) {
        setPhase('creating');
        await submitTwin(data.twin_payload, token);
      }
    } catch {
      setMessages(prev => [...prev, {
        role: 'ai',
        content: "Sorry, something went wrong on my end. Could you repeat that?",
      }]);
    } finally {
      setSending(false);
    }
  }

  async function submitTwin(payload: Record<string, unknown>, token: string) {
    try {
      const res = await fetch(`${API}/create-twin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { detail?: string }).detail || 'Failed to create twin');
      }
      setPhase('done');
      setTimeout(() => router.push('/dashboard'), 2200);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create twin');
      setPhase('chat');
    }
  }

  async function sendMessage() {
    const text = input.trim();
    if (!text || sending || phase !== 'chat') return;
    const token = await getToken();
    if (!token) { router.push('/sign-in'); return; }

    setInput('');
    const newMsg: Message = { role: 'user', content: text };
    const newApiItem: ApiHistoryItem = { role: 'user', content: text };
    setMessages(prev => [...prev, newMsg]);
    const newHistory = [...apiHistory, newApiItem];
    setApiHistory(newHistory);

    await callOnboard(newHistory, fieldsCollected, topicsCovered, linkedinParsed, token);
  }

  async function handleLinkedIn(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (fileInputRef.current) fileInputRef.current.value = '';

    const token = await getToken();
    if (!token) { router.push('/sign-in'); return; }

    setParsing(true);
    setMessages(prev => [...prev,
      { role: 'user', content: '📎 LinkedIn PDF attached' },
      { role: 'status', content: 'Reading your LinkedIn profile…' },
    ]);

    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(`${API}/parse-linkedin`, { method: 'POST', body: formData });
      if (!res.ok) throw new Error('parse failed');
      const data = await res.json();

      const parsedFields: FieldUpdates = {
        name: data.name, title: data.title, bio: data.bio,
        skills: data.skills, experience: data.experience, achievements: data.achievements,
        archetype_id: data.archetype_id ?? null,
      };
      const newFields = { ...fieldsCollected, ...parsedFields };
      setLinkedinParsed(data);
      setFieldsCollected(newFields);

      // Remove status bubble
      setMessages(prev => prev.filter(m => m.role !== 'status'));

      const attachMsg = '📎 LinkedIn PDF attached';
      const newHistory: ApiHistoryItem[] = [...apiHistory, { role: 'user', content: attachMsg }];
      setApiHistory(newHistory);
      await callOnboard(newHistory, newFields, topicsCovered, data, token);
    } catch {
      setMessages(prev => [
        ...prev.filter(m => m.role !== 'status'),
        { role: 'ai', content: "Hmm, had trouble reading that PDF. No worries — let's just go from scratch." },
      ]);
    } finally {
      setParsing(false);
    }
  }

  return (
    <main className="min-h-screen bg-gray-50 flex flex-col">

      {/* Top bar */}
      <header className="bg-white border-b border-gray-200 px-5 py-3.5 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 bg-purple-600 rounded-lg flex items-center justify-center">
            <span className="text-white text-xs font-bold">T</span>
          </div>
          <span className="font-semibold text-gray-800 text-sm">Create your twin</span>
        </div>
        <Link
          href="/create/form"
          className="text-xs text-gray-400 hover:text-purple-600 transition-colors"
        >
          Fill the form in detail instead →
        </Link>
      </header>

      {/* Chat area */}
      <div className="flex-1 overflow-y-auto px-4 py-6 max-w-2xl w-full mx-auto">
        {phase === 'loading' && (
          <div className="flex items-center justify-center h-32">
            <Loader2 className="w-5 h-5 animate-spin text-purple-400" />
          </div>
        )}

        <div className="space-y-4">
          {messages.map((msg, i) => {
            if (msg.role === 'status') {
              return (
                <div key={i} className="flex justify-center">
                  <span className="text-xs text-gray-400 italic flex items-center gap-1.5">
                    <Loader2 className="w-3 h-3 animate-spin" /> {msg.content}
                  </span>
                </div>
              );
            }
            const isAi = msg.role === 'ai';
            return (
              <div key={i} className={`flex gap-3 ${isAi ? 'justify-start' : 'justify-end'}`}>
                {isAi && (
                  <div className="w-7 h-7 rounded-full bg-purple-600 flex items-center justify-center text-white text-xs font-bold shrink-0 mt-1">
                    T
                  </div>
                )}
                <div className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                  isAi
                    ? 'bg-white border border-gray-200 text-gray-800'
                    : 'bg-purple-600 text-white'
                }`}>
                  {msg.content}
                </div>
              </div>
            );
          })}

          {/* AI typing indicator */}
          {sending && (
            <div className="flex gap-3 justify-start">
              <div className="w-7 h-7 rounded-full bg-purple-600 flex items-center justify-center text-white text-xs font-bold shrink-0 mt-1">
                T
              </div>
              <div className="bg-white border border-gray-200 rounded-2xl px-4 py-3">
                <div className="flex space-x-1.5 items-center h-4">
                  <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                  <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                  <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
              </div>
            </div>
          )}

          {/* Creating state */}
          {phase === 'creating' && (
            <div className="flex justify-center py-4">
              <div className="flex items-center gap-2 text-sm text-gray-500 bg-white border border-gray-200 rounded-full px-4 py-2">
                <Loader2 className="w-4 h-4 animate-spin text-purple-500" />
                Building your twin…
              </div>
            </div>
          )}

          {/* Done state */}
          {phase === 'done' && (
            <div className="flex justify-center py-4">
              <div className="flex items-center gap-2 text-sm text-purple-700 bg-purple-50 border border-purple-200 rounded-full px-4 py-2">
                <Check className="w-4 h-4" />
                Twin created! Redirecting to dashboard…
              </div>
            </div>
          )}

          {createError && (
            <div className="text-center text-sm text-red-500 bg-red-50 border border-red-200 rounded-lg px-4 py-3">
              {createError} —{' '}
              <button
                onClick={() => setCreateError('')}
                className="underline hover:no-underline"
              >
                dismiss
              </button>
            </div>
          )}
        </div>

        <div ref={bottomRef} />
      </div>

      {/* Input area */}
      {(phase === 'chat' || phase === 'loading') && (
        <div className="bg-white border-t border-gray-200 px-4 py-3 shrink-0">
          <div className="max-w-2xl mx-auto flex items-end gap-2">

            {/* LinkedIn attach button — hide after upload */}
            {!linkedinParsed && (
              <>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={parsing || sending}
                  title="Attach LinkedIn PDF"
                  className="mb-1 p-2 text-gray-400 hover:text-purple-600 disabled:opacity-40 transition-colors rounded-lg hover:bg-gray-100 shrink-0"
                >
                  {parsing ? (
                    <Loader2 className="w-5 h-5 animate-spin" />
                  ) : (
                    <Paperclip className="w-5 h-5" />
                  )}
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf"
                  onChange={handleLinkedIn}
                  className="hidden"
                />
              </>
            )}

            {/* Linked-in uploaded badge */}
            {linkedinParsed && (
              <div className="mb-1 flex items-center gap-1 text-xs text-purple-600 bg-purple-50 border border-purple-200 rounded-full px-2.5 py-1 shrink-0">
                <Check className="w-3 h-3" /> LinkedIn
              </div>
            )}

            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  sendMessage();
                }
              }}
              placeholder="Type your answer…"
              rows={1}
              disabled={sending || phase === 'loading'}
              className="flex-1 resize-none px-4 py-2.5 border border-gray-300 rounded-xl text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-purple-500 disabled:opacity-50 leading-relaxed"
            />

            <button
              onClick={sendMessage}
              disabled={!input.trim() || sending || phase === 'loading'}
              className="mb-1 p-2 bg-purple-600 text-white rounded-xl hover:bg-purple-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
