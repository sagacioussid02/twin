'use client';

import { useState, useRef, useEffect, Suspense } from 'react';
import type { KeyboardEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import { useAuth } from '@clerk/nextjs';
import { Send, User, ArrowLeft } from 'lucide-react';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

interface TwinProfile {
  twin_id: string;
  name: string;
  title: string;
  personality_summary: string;
  core_values: string[];
  archetype_display_name?: string;
}

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

function TwinChat() {
  const searchParams = useSearchParams();
  const id = searchParams.get('id');
  const { getToken, isSignedIn } = useAuth();

  const [profile, setProfile] = useState<TwinProfile | null>(null);
  const [profileError, setProfileError] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  // session_id is only used for anonymous users; authenticated users get a
  // stable server-derived session keyed by their identity + twin_id.
  const [sessionId, setSessionId] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!id) { setProfileError('No twin ID provided.'); return; }
    fetch(`${API}/twin/${id}`)
      .then(r => {
        if (!r.ok) throw new Error('Twin not found');
        return r.json();
      })
      .then(setProfile)
      .catch(() => setProfileError("This twin doesn't exist or has been removed."));
  }, [id]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendMessage = async () => {
    if (!input.trim() || isLoading) return;

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: input,
      timestamp: new Date(),
    };
    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

    try {
      const token = isSignedIn ? await getToken() : null;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const res = await fetch(`${API}/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          message: input,
          twin_id: id,
          // Always send session_id when available so the backend can fall back
          // to it if token validation fails (expired, JWKS misconfig, etc.),
          // preserving within-page continuity. Backend ignores it when it
          // successfully derives a stable authenticated session key.
          ...(sessionId ? { session_id: sessionId } : {}),
        }),
      });
      if (!res.ok) throw new Error('Failed to send');
      const data = await res.json();
      if (!sessionId) setSessionId(data.session_id);
      setMessages(prev => [...prev, {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: data.response,
        timestamp: new Date(),
      }]);
    } catch {
      setMessages(prev => [...prev, {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: 'Sorry, something went wrong. Please try again.',
        timestamp: new Date(),
      }]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  if (profileError) {
    return (
      <main className="min-h-screen bg-gradient-to-br from-slate-50 to-gray-100 flex items-center justify-center">
        <div className="text-center">
          <p className="text-gray-500 mb-4">{profileError}</p>
          <a href="/create" className="text-purple-600 underline text-sm">Create your own twin</a>
        </div>
      </main>
    );
  }

  if (!profile) {
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

  const initials = profile.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
  const firstName = profile.name.split(' ')[0];

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-50 to-gray-100">
      <div className="container mx-auto px-4 py-8">
        <div className="max-w-4xl mx-auto">

          {/* Header */}
          <div className="mb-4">
            <a href="/create" className="text-sm text-gray-400 hover:text-gray-600 flex items-center gap-1 mb-4">
              <ArrowLeft className="w-4 h-4" /> Create your own
            </a>
            <div className="flex items-start gap-4">
              <div className="w-14 h-14 rounded-full bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center text-white text-xl font-bold shrink-0">
                {initials}
              </div>
              <div className="flex-1 min-w-0">
                <h1 className="text-2xl font-bold text-gray-800">{profile.name}&apos;s AI Twin</h1>
                {profile.title && <p className="text-sm text-gray-500 mt-0.5">{profile.title}</p>}
                {profile.archetype_display_name && (
                  <span className="inline-block mt-1 text-xs text-purple-600 bg-purple-50 border border-purple-100 px-2.5 py-0.5 rounded-full">
                    <span aria-hidden="true">✨</span> {profile.archetype_display_name} personality
                  </span>
                )}
                {profile.personality_summary && (
                  <p className="text-sm text-gray-600 mt-2 leading-relaxed">{profile.personality_summary}</p>
                )}
                {profile.core_values.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {profile.core_values.slice(0, 4).map((v, i) => (
                      <span key={i} className="text-xs bg-purple-50 border border-purple-100 text-purple-600 px-2 py-0.5 rounded-full">{v}</span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Chat */}
          <div className="h-[520px] flex flex-col bg-white rounded-xl shadow-sm border border-gray-100">
            <div className="bg-gradient-to-r from-purple-600 to-blue-600 text-white p-4 rounded-t-xl">
              <p className="font-semibold">Talk to {firstName}&apos;s Twin</p>
              <p className="text-xs text-purple-100 mt-0.5">Ask anything — including &quot;what would you do?&quot;</p>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {messages.length === 0 && (
                <div className="text-center text-gray-400 mt-10 space-y-3">
                  <div className="w-12 h-12 rounded-full bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center text-white text-lg font-bold mx-auto">
                    {initials}
                  </div>
                  <p className="font-medium text-gray-600">Hi, I&apos;m {firstName}&apos;s AI Twin</p>
                  <div className="flex flex-wrap gap-2 justify-center max-w-sm mx-auto">
                    {[
                      'What would you do if you had to choose between X and Y?',
                      'How do you approach hard decisions?',
                      'Tell me about yourself',
                    ].map((q, i) => (
                      <button key={i} onClick={() => setInput(q)}
                        className="text-xs bg-gray-50 border border-gray-200 text-gray-600 px-3 py-1.5 rounded-full hover:bg-purple-50 hover:border-purple-200 hover:text-purple-600 transition-colors">
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {messages.map(message => (
                <div key={message.id} className={`flex gap-3 ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  {message.role === 'assistant' && (
                    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center text-white text-xs font-bold shrink-0">
                      {initials}
                    </div>
                  )}
                  <div className={`max-w-[70%] rounded-lg p-3 ${message.role === 'user' ? 'bg-slate-700 text-white' : 'bg-gray-50 border border-gray-200 text-gray-800'}`}>
                    <p className="whitespace-pre-wrap text-sm">{message.content}</p>
                    <p className={`text-xs mt-1 ${message.role === 'user' ? 'text-slate-300' : 'text-gray-400'}`}>
                      {message.timestamp.toLocaleTimeString()}
                    </p>
                  </div>
                  {message.role === 'user' && (
                    <div className="w-8 h-8 bg-gray-600 rounded-full flex items-center justify-center shrink-0">
                      <User className="w-4 h-4 text-white" />
                    </div>
                  )}
                </div>
              ))}

              {isLoading && (
                <div className="flex gap-3 justify-start">
                  <div className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center text-white text-xs font-bold shrink-0">
                    {initials}
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

            <div className="border-t border-gray-100 p-4">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={`Ask ${firstName} anything...`}
                  className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 text-gray-800 text-sm"
                  disabled={isLoading}
                />
                <button
                  onClick={sendMessage}
                  disabled={!input.trim() || isLoading}
                  className="px-4 py-2 bg-slate-700 text-white rounded-lg hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <Send className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>

          <p className="text-center text-xs text-gray-400 mt-4">
            Want your own?{' '}
            <a href="/create" className="text-purple-500 hover:text-purple-700 underline">Create your AI twin</a>
          </p>
        </div>
      </div>
    </main>
  );
}

export default function TwinPage() {
  return (
    <Suspense fallback={
      <main className="min-h-screen bg-gradient-to-br from-slate-50 to-gray-100 flex items-center justify-center">
        <div className="flex gap-2">
          <div className="w-2 h-2 bg-purple-400 rounded-full animate-bounce" />
          <div className="w-2 h-2 bg-purple-400 rounded-full animate-bounce delay-100" />
          <div className="w-2 h-2 bg-purple-400 rounded-full animate-bounce delay-200" />
        </div>
      </main>
    }>
      <TwinChat />
    </Suspense>
  );
}
