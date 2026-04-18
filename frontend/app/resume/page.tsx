'use client';

import { useState, useRef, useEffect, Suspense } from 'react';
import type { KeyboardEvent, ChangeEvent } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useAuth } from '@clerk/nextjs';
import { Send, Upload, FileText, Sparkles, Download, Loader2, CheckCircle2 } from 'lucide-react';
import AppNav from '@/components/app-nav';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

const ALL_TOPICS = ['TECH_STACK', 'EDUCATION', 'CAREER_HISTORY', 'ACCOMPLISHMENTS', 'TARGET_ROLE'];
const TOPIC_LABELS: Record<string, string> = {
  TECH_STACK: 'Tech Stack',
  EDUCATION: 'Education',
  CAREER_HISTORY: 'Career',
  ACCOMPLISHMENTS: 'Wins',
  TARGET_ROLE: 'Target Role',
};

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

interface FieldUpdates {
  tech_stack?: string;
  education?: string;
  career_history?: string;
  accomplishments?: string;
  target_role?: string;
}

type Phase = 'setup' | 'interview' | 'generate';

function ResumeBuilder() {
  const searchParams = useSearchParams();
  const twin_id = searchParams.get('twin_id');
  const router = useRouter();
  const { getToken, isSignedIn, isLoaded } = useAuth();

  const [phase, setPhase] = useState<Phase>('setup');
  const [twinName, setTwinName] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [topicsCovered, setTopicsCovered] = useState<string[]>([]);
  const [fieldsCollected, setFieldsCollected] = useState<Record<string, string>>({});
  const [linkedinParsed, setLinkedinParsed] = useState<Record<string, string> | null>(null);
  const [jobDescription, setJobDescription] = useState<Record<string, string> | null>(null);
  const [linkedinUploading, setLinkedinUploading] = useState(false);
  const [jdUploading, setJdUploading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generated, setGenerated] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const startedRef = useRef(false);
  const linkedinRef = useRef<HTMLInputElement>(null);
  const jdRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isLoaded && !isSignedIn) router.replace('/sign-in');
  }, [isLoaded, isSignedIn, router]);

  // Load twin data to pre-populate fields
  useEffect(() => {
    if (!twin_id || !isSignedIn) return;
    fetch(`${API}/twin/${twin_id}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data) return;
        setTwinName(data.name || '');
        const pre: Record<string, string> = {};
        const autoTopics: string[] = [];
        if (data.name) pre.name = data.name;
        if (data.title) pre.title = data.title;
        if (data.skills) { pre.tech_stack = data.skills; autoTopics.push('TECH_STACK'); }
        if (data.experience) { pre.career_history = data.experience; autoTopics.push('CAREER_HISTORY'); }
        if (data.achievements) { pre.accomplishments = data.achievements; autoTopics.push('ACCOMPLISHMENTS'); }
        setFieldsCollected(pre);
        setTopicsCovered(autoTopics);
      })
      .catch(() => {});
  }, [twin_id, isSignedIn]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Start interview automatically once phase switches
  useEffect(() => {
    if (phase !== 'interview' || startedRef.current || messages.length > 0) return;
    startedRef.current = true;
    callInterview('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const handleLinkedinUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLinkedinUploading(true);
    try {
      const token = await getToken();
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`${API}/parse-linkedin`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      if (res.ok) {
        const data = await res.json();
        setLinkedinParsed(data);
        // Merge into fields and auto-mark topics
        setFieldsCollected(prev => {
          const next = { ...prev };
          if (data.name) next.name = data.name;
          if (data.title) next.title = data.title;
          if (data.skills) next.tech_stack = data.skills;
          if (data.experience) next.career_history = data.experience;
          if (data.achievements) next.accomplishments = data.achievements;
          return next;
        });
        setTopicsCovered(prev => {
          const next = new Set(prev);
          if (data.skills) next.add('TECH_STACK');
          if (data.experience) next.add('CAREER_HISTORY');
          if (data.achievements) next.add('ACCOMPLISHMENTS');
          return [...next];
        });
      }
    } catch { /* ignore */ } finally {
      setLinkedinUploading(false);
      if (linkedinRef.current) linkedinRef.current.value = '';
    }
  };

  const handleJdUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setJdUploading(true);
    try {
      const token = await getToken();
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`${API}/resume/parse-jd`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      if (res.ok) {
        const data = await res.json();
        setJobDescription(data);
        setFieldsCollected(prev => ({
          ...prev,
          target_role: data.role || prev.target_role || '',
          job_description: data.raw_text || '',
        }));
      }
    } catch { /* ignore */ } finally {
      setJdUploading(false);
      if (jdRef.current) jdRef.current.value = '';
    }
  };

  const callInterview = async (userText: string) => {
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
      const res = await fetch(`${API}/resume/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          history: newHistory.map(m => ({ role: m.role, content: m.content })),
          topics_covered: topicsCovered,
          fields_collected: fieldsCollected,
          linkedin_parsed: linkedinParsed,
        }),
      });
      if (!res.ok) throw new Error('Request failed');
      const data = await res.json();

      setMessages(prev => [...prev, { id: crypto.randomUUID(), role: 'assistant', content: data.message }]);
      if (data.topics_covered?.length) setTopicsCovered(data.topics_covered);
      if (data.field_updates && Object.keys(data.field_updates).length) {
        setFieldsCollected(prev => {
          const next = { ...prev };
          for (const [k, v] of Object.entries(data.field_updates as FieldUpdates)) {
            if (v) next[k] = v as string;
          }
          return next;
        });
      }
      if (data.done) setPhase('generate');
    } catch {
      setMessages(prev => [...prev, {
        id: crypto.randomUUID(), role: 'assistant',
        content: 'Something went wrong. Please try again.',
      }]);
    } finally {
      setSending(false);
    }
  };

  const handleGenerate = async () => {
    if (generating) return;
    setGenerating(true);
    try {
      const token = await getToken();
      const allFields = {
        ...fieldsCollected,
        ...(jobDescription ? { job_description: jobDescription.raw_text || '' } : {}),
      };
      const res = await fetch(`${API}/resume/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ fields_collected: allFields }),
      });
      if (!res.ok) throw new Error('Generation failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const name = (fieldsCollected.name || 'resume').replace(/\s+/g, '_');
      a.download = `${name}_resume.docx`;
      a.click();
      URL.revokeObjectURL(url);
      setGenerated(true);
    } catch {
      alert('Resume generation failed. Please try again.');
    } finally {
      setGenerating(false);
    }
  };

  const handleSend = () => {
    if (!input.trim() || sending) return;
    callInterview(input.trim());
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  if (!isLoaded || (!isSignedIn)) {
    return (
      <main className="min-h-screen bg-gradient-to-br from-slate-50 to-gray-100 flex items-center justify-center">
        <div className="flex gap-2">
          {[0, 1, 2].map(i => (
            <div key={i} className={`w-2 h-2 bg-purple-400 rounded-full animate-bounce`} style={{ animationDelay: `${i * 100}ms` }} />
          ))}
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-50 to-gray-100">
      <AppNav />
      <div className="container mx-auto px-4 py-8">
        <div className="max-w-2xl mx-auto">

          {/* Header */}
          <div className="mb-6 flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-emerald-500 to-teal-500 flex items-center justify-center">
              <FileText className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-gray-800">
                Build your resume{twinName ? ` — ${twinName}` : ''}
              </h1>
              <p className="text-sm text-gray-500">
                {phase === 'setup' && 'Upload optional files, then start the interview'}
                {phase === 'interview' && '5 quick questions, then we generate your .docx'}
                {phase === 'generate' && 'Ready to build your resume'}
              </p>
            </div>
          </div>

          {/* ── Phase 1: Setup ─────────────────────────────────────────────── */}
          {phase === 'setup' && (
            <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
              {twinName && (
                <div className="flex items-center gap-2 text-sm text-emerald-700 bg-emerald-50 border border-emerald-100 px-4 py-2.5 rounded-lg">
                  <Sparkles className="w-4 h-4 shrink-0" />
                  Using <strong>{twinName}&apos;s</strong> data as a head start — some questions will be skipped.
                </div>
              )}

              <div className="space-y-3">
                <p className="text-sm font-medium text-gray-700">Optional: upload files to save time</p>

                {/* LinkedIn upload */}
                <div
                  className="flex items-center justify-between border border-dashed border-gray-300 rounded-lg px-4 py-3 cursor-pointer hover:border-purple-400 hover:bg-purple-50 transition-colors"
                  onClick={() => linkedinRef.current?.click()}
                >
                  <div className="flex items-center gap-3">
                    <Upload className="w-4 h-4 text-gray-400" />
                    <div>
                      <p className="text-sm font-medium text-gray-700">LinkedIn PDF</p>
                      <p className="text-xs text-gray-400">Auto-fills skills and experience</p>
                    </div>
                  </div>
                  {linkedinUploading ? (
                    <Loader2 className="w-4 h-4 animate-spin text-purple-500" />
                  ) : linkedinParsed ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                  ) : (
                    <span className="text-xs text-gray-400">PDF only</span>
                  )}
                </div>
                <input ref={linkedinRef} type="file" accept=".pdf" className="hidden" onChange={handleLinkedinUpload} />

                {/* JD upload */}
                <div
                  className="flex items-center justify-between border border-dashed border-gray-300 rounded-lg px-4 py-3 cursor-pointer hover:border-teal-400 hover:bg-teal-50 transition-colors"
                  onClick={() => jdRef.current?.click()}
                >
                  <div className="flex items-center gap-3">
                    <Upload className="w-4 h-4 text-gray-400" />
                    <div>
                      <p className="text-sm font-medium text-gray-700">Job Description PDF</p>
                      <p className="text-xs text-gray-400">Tailors the resume to the target role</p>
                    </div>
                  </div>
                  {jdUploading ? (
                    <Loader2 className="w-4 h-4 animate-spin text-teal-500" />
                  ) : jobDescription ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                  ) : (
                    <span className="text-xs text-gray-400">PDF only</span>
                  )}
                </div>
                <input ref={jdRef} type="file" accept=".pdf" className="hidden" onChange={handleJdUpload} />
              </div>

              {topicsCovered.length > 0 && (
                <div className="text-xs text-gray-400">
                  Pre-filled from your twin: {topicsCovered.map(t => TOPIC_LABELS[t]).join(', ')} — those steps will be skipped.
                </div>
              )}

              <button
                onClick={() => setPhase('interview')}
                className="w-full py-2.5 bg-slate-700 text-white text-sm font-medium rounded-lg hover:bg-slate-800 transition-colors"
              >
                Start interview
              </button>
            </div>
          )}

          {/* ── Phase 2: Interview ─────────────────────────────────────────── */}
          {phase === 'interview' && (
            <>
              {/* Progress dots */}
              <div className="flex items-center gap-1.5 mb-4">
                {ALL_TOPICS.map(topic => (
                  <div
                    key={topic}
                    className={`h-1.5 flex-1 rounded-full transition-colors ${topicsCovered.includes(topic) ? 'bg-emerald-500' : 'bg-gray-200'}`}
                    title={TOPIC_LABELS[topic]}
                  />
                ))}
              </div>

              <div className="bg-white rounded-xl shadow-sm border border-gray-100 flex flex-col" style={{ height: '520px' }}>
                <div className="bg-gradient-to-r from-emerald-600 to-teal-600 text-white p-4 rounded-t-xl">
                  <p className="font-semibold text-sm">Resume interview</p>
                  <p className="text-xs text-emerald-100 mt-0.5">
                    {ALL_TOPICS.length - topicsCovered.length} topic{ALL_TOPICS.length - topicsCovered.length !== 1 ? 's' : ''} remaining
                  </p>
                </div>

                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                  {messages.map(m => (
                    <div key={m.id} className={`flex gap-3 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      {m.role === 'assistant' && (
                        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-emerald-500 to-teal-500 flex items-center justify-center shrink-0">
                          <FileText className="w-4 h-4 text-white" />
                        </div>
                      )}
                      <div className={`max-w-[80%] rounded-lg p-3 text-sm ${m.role === 'user' ? 'bg-slate-700 text-white' : 'bg-gray-50 border border-gray-200 text-gray-800'}`}>
                        <p className="whitespace-pre-wrap">{m.content}</p>
                      </div>
                    </div>
                  ))}

                  {sending && (
                    <div className="flex gap-3 justify-start">
                      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-emerald-500 to-teal-500 flex items-center justify-center shrink-0">
                        <FileText className="w-4 h-4 text-white" />
                      </div>
                      <div className="bg-gray-50 border border-gray-200 rounded-lg p-3">
                        <div className="flex space-x-1.5">
                          {[0, 1, 2].map(i => (
                            <div key={i} className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: `${i * 100}ms` }} />
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                  <div ref={messagesEndRef} />
                </div>

                <div className="border-t border-gray-100 p-4">
                  <div className="flex gap-2 items-end">
                    <textarea
                      value={input}
                      onChange={e => setInput(e.target.value)}
                      onKeyDown={handleKeyDown}
                      placeholder="Type your answer… (Shift+Enter for new line)"
                      rows={3}
                      className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 text-gray-800 text-sm resize-none"
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
              </div>
            </>
          )}

          {/* ── Phase 3: Generate ──────────────────────────────────────────── */}
          {phase === 'generate' && (
            <div className="bg-white rounded-xl border border-gray-200 p-8 text-center space-y-6">
              <div className="w-14 h-14 rounded-full bg-gradient-to-br from-emerald-500 to-teal-500 flex items-center justify-center mx-auto">
                <CheckCircle2 className="w-7 h-7 text-white" />
              </div>
              <div>
                <h2 className="text-lg font-bold text-gray-800 mb-1">Interview complete</h2>
                <p className="text-sm text-gray-500">
                  {jobDescription ? (
                    <>Tailoring resume to <strong>{jobDescription.role || 'target role'}</strong>{jobDescription.company ? ` at ${jobDescription.company}` : ''}.</>
                  ) : (
                    'Building a general-purpose resume from your answers.'
                  )}
                </p>
              </div>

              {/* Summary of collected data */}
              <div className="text-left bg-gray-50 rounded-lg p-4 space-y-1.5">
                {Object.entries({
                  'Tech Stack': fieldsCollected.tech_stack,
                  'Education': fieldsCollected.education,
                  'Career History': fieldsCollected.career_history,
                  'Accomplishments': fieldsCollected.accomplishments,
                  'Target Role': fieldsCollected.target_role,
                }).filter(([, v]) => v).map(([label, value]) => (
                  <div key={label} className="flex gap-2 text-xs">
                    <span className="text-gray-400 w-28 shrink-0">{label}</span>
                    <span className="text-gray-600 truncate">{String(value).slice(0, 80)}{String(value).length > 80 ? '…' : ''}</span>
                  </div>
                ))}
              </div>

              {generated ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-center gap-2 text-emerald-600 text-sm font-medium">
                    <Download className="w-4 h-4" />
                    Resume downloaded!
                  </div>
                  <button
                    onClick={() => router.push('/dashboard')}
                    className="text-sm text-gray-500 hover:text-gray-700 underline"
                  >
                    Back to dashboard
                  </button>
                </div>
              ) : (
                <button
                  onClick={handleGenerate}
                  disabled={generating}
                  className="w-full py-3 bg-slate-700 text-white text-sm font-medium rounded-lg hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
                >
                  {generating ? (
                    <><Loader2 className="w-4 h-4 animate-spin" /> Building your resume…</>
                  ) : (
                    <><Download className="w-4 h-4" /> Generate Resume (.docx)</>
                  )}
                </button>
              )}
            </div>
          )}

        </div>
      </div>
    </main>
  );
}

export default function ResumePage() {
  return (
    <Suspense fallback={
      <main className="min-h-screen bg-gradient-to-br from-slate-50 to-gray-100 flex items-center justify-center">
        <div className="flex gap-2">
          {[0, 1, 2].map(i => (
            <div key={i} className="w-2 h-2 bg-purple-400 rounded-full animate-bounce" style={{ animationDelay: `${i * 100}ms` }} />
          ))}
        </div>
      </main>
    }>
      <ResumeBuilder />
    </Suspense>
  );
}
