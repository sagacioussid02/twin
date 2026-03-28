'use client';

import { useState, useEffect, useRef, type ChangeEvent } from 'react';
import { useAuth } from '@clerk/nextjs';
import { useRouter } from 'next/navigation';
import { Send, Paperclip, Loader2, Check, Lightbulb } from 'lucide-react';
import Link from 'next/link';
import AppNav from '@/components/app-nav';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

const ALL_TOPICS = ['IDENTITY', 'PROFESSIONAL', 'DECISIONS', 'VALUES', 'WORKING_STYLE', 'VOICE'];
const MAX_USER_TURNS = 14;
const MAX_CHARS = 600;

const VOICE_QUIRK_CHIPS = [
  "Always starts with 'So here's the thing...'",
  "Says 'at the end of the day' a lot",
  "Thinks out loud before landing on an answer",
  "Short sentences. No fluff.",
  "Uses analogies to explain technical things",
  "Ends with 'does that make sense?'",
  "Brings everything back to first principles",
  "Says 'I don't know' openly when uncertain",
  "Steelmans the opposing view before arguing",
  "Uses 'to be fair' as a filler",
  "Never uses exclamation marks",
  "Challenges assumptions before answering",
];

interface TopicGuidance {
  label: string;
  what: string;
  sample: string;
  tips: string[];
}

const TOPIC_GUIDANCE: Record<string, TopicGuidance> = {
  IDENTITY: {
    label: 'Who you are',
    what: "Your name, role, and a one-line description of what you do.",
    sample: "I'm Alex Rivera — Staff Engineer at Stripe. I build payment infrastructure and help developers ship faster.",
    tips: [
      "Keep it short — one or two sentences.",
      "Mention your role and the domain you work in.",
    ],
  },
  PROFESSIONAL: {
    label: 'Career background',
    what: "Your experience, key skills, and career highlights.",
    sample: "12 years in backend systems. Currently leading a 15-person platform team at Stripe. Before that: Lyft (pricing engine) and IBM (Watson APIs). Strong in Go, distributed systems, and API design.",
    tips: [
      "You can upload your LinkedIn PDF to fill this in automatically.",
      "Focus on what you've built and the scale you've worked at.",
    ],
  },
  DECISIONS: {
    label: 'How you decide',
    what: "How you approach hard choices — your mental models, risk tolerance, and real examples.",
    sample: "I write the decision out in one paragraph, as if explaining to a smart friend. If I can't do that clearly, I don't understand it yet. I passed on a VP role in 2021 — the money was great but the problem felt manufactured. I stayed put. The startup pivoted twice and laid off half the team six months later.",
    tips: [
      "Share a real past decision — even a small one.",
      "Mention how you handle reversible vs. irreversible choices differently.",
    ],
  },
  VALUES: {
    label: 'What drives you',
    what: "The principles you hold strongly and won't compromise on.",
    sample: "Simplicity over cleverness — I'll delete 200 lines before I add 10. Disagree and commit — I voice concerns once, clearly, then fully back the decision. Skin in the game — I won't ask my team to do something I haven't done.",
    tips: [
      "List 2–4 specific values, not just labels like 'integrity'.",
      "A good value includes a behavior — what you actually *do* because of it.",
    ],
  },
  WORKING_STYLE: {
    label: 'How you work',
    what: "Your collaboration preferences, communication habits, and what you're like as a teammate.",
    sample: "I'm async by default — prefer written docs over meetings. I over-explain in diagrams. I ask 'what problem are we solving?' a lot. I give blunt feedback but always explain the why. I do my best thinking in the morning and protect that time.",
    tips: [
      "Think about what teammates say about working with you.",
      "Mention what conditions help you do your best work.",
    ],
  },
  VOICE: {
    label: 'Your communication style',
    what: "How you talk and write — tone, quirks, and what makes your voice yours.",
    sample: "Short sentences. No filler. I use 'the thing is...' a lot before making a point. I almost never use exclamation marks. I prefer bullet points over paragraphs when the stakes are high. I steelman opposing views before arguing back.",
    tips: [
      "Think about phrases you use often — or that others have pointed out.",
      "Mention how formal or casual your default tone is.",
    ],
  },
};

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

function GuidancePanel({ topicsCovered }: { topicsCovered: string[] }) {
  const activeTopic = ALL_TOPICS.find(t => !topicsCovered.includes(t)) || ALL_TOPICS[ALL_TOPICS.length - 1];
  const guidance = TOPIC_GUIDANCE[activeTopic];

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4 text-sm">
      <div className="flex items-center gap-1.5 mb-3">
        <Lightbulb className="w-3.5 h-3.5 text-purple-500 shrink-0" />
        <span className="text-xs font-medium text-purple-600 uppercase tracking-wide">
          {guidance.label}
        </span>
      </div>
      <p className="text-gray-500 text-xs mb-3 leading-relaxed">{guidance.what}</p>
      <div className="bg-gray-50 border border-gray-100 rounded-lg p-3 mb-3">
        <p className="text-xs text-gray-400 font-medium mb-1">Example answer</p>
        <p className="text-xs text-gray-700 leading-relaxed italic">&ldquo;{guidance.sample}&rdquo;</p>
      </div>
      <ul className="space-y-1">
        {guidance.tips.map((tip, i) => (
          <li key={i} className="text-xs text-gray-500 flex gap-1.5">
            <span className="text-purple-400 shrink-0">·</span>
            {tip}
          </li>
        ))}
      </ul>
    </div>
  );
}

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
  const [userTurnCount, setUserTurnCount] = useState(0);
  const [showInlineGuidance, setShowInlineGuidance] = useState(false);

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

  function buildPayload(fields: FieldUpdates): Record<string, unknown> {
    return {
      name: fields.name || '',
      title: fields.title || '',
      bio: fields.bio || '',
      email: '',
      skills: fields.skills || '',
      experience: fields.experience || '',
      achievements: fields.achievements || '',
      coreValues: fields.coreValues || '',
      decisionStyle: fields.decisionStyle || '',
      riskTolerance: fields.riskTolerance || 'medium',
      pastDecisions: fields.pastDecisions || '',
      communicationStyle: fields.communicationStyle || '',
      writingSamples: '',
      blindSpots: fields.blindSpots || '',
      verbalQuirks: fields.verbalQuirks || '',
      responseStyle: fields.responseStyle || 'balanced',
      archetype_id: fields.archetype_id ?? null,
    };
  }

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

      // Defensive guard: if the message looks like a raw JSON blob (backend parse failure
      // leaked through), replace it with a safe fallback so the user never sees raw JSON.
      let aiMessage: string = data.message || '';
      if (aiMessage.trim().startsWith('{') || aiMessage.trim().startsWith('```')) {
        try {
          const stripped = aiMessage.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '');
          const nested = JSON.parse(stripped);
          aiMessage = typeof nested.message === 'string' ? nested.message : "Got it, let me keep going.";
        } catch {
          aiMessage = "Got it, let me keep going.";
        }
      }

      const updatedFields: FieldUpdates = { ...fields, ...(data.field_updates || {}) };
      const updatedTopics: string[] = data.topics_covered || topics;

      setFieldsCollected(updatedFields);
      setTopicsCovered(updatedTopics);
      setMessages(prev => [...prev, { role: 'ai', content: aiMessage }]);
      setApiHistory(prev => [...prev, { role: 'assistant', content: aiMessage }]);

      const shouldCreate = data.done || updatedTopics.length >= ALL_TOPICS.length;
      if (shouldCreate) {
        setPhase('creating');
        await submitTwin(data.twin_payload || buildPayload(updatedFields), token);
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
    setUserTurnCount(n => n + 1);
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
      const cleanedParsedFields = Object.fromEntries(
        Object.entries(parsedFields).filter(([, value]) => value !== undefined)
      ) as FieldUpdates;
      const newFields = { ...fieldsCollected, ...cleanedParsedFields };
      setLinkedinParsed(data);
      setFieldsCollected(newFields);

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

  async function createManually() {
    const token = await getToken();
    if (!token) { router.push('/sign-in'); return; }
    setPhase('creating');
    await submitTwin(buildPayload(fieldsCollected), token);
  }

  const canCreateManually = phase === 'chat' && !sending &&
    (topicsCovered.length >= 4 || userTurnCount >= MAX_USER_TURNS);

  const activeTopic = ALL_TOPICS.find(t => !topicsCovered.includes(t));

  // Detect if the AI's last message has no question — need to nudge continuation
  const lastAiMessage = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'ai') {
        return messages[i];
      }
    }
    return undefined;
  })();
  const aiStalled = !!(phase === 'chat' && !sending &&
    lastAiMessage && !lastAiMessage.content.trim().endsWith('?') && activeTopic);

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <AppNav />

      {/* Page title bar */}
      <div className="bg-white border-b border-gray-100 px-5 py-2.5 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <span className="font-medium text-gray-700 text-sm">Create your twin</span>
          {/* Progress dots */}
          {phase === 'chat' && (
            <div className="flex items-center gap-1" title={`${topicsCovered.length} of ${ALL_TOPICS.length} topics covered`}>
              {ALL_TOPICS.map(t => (
                <div
                  key={t}
                  className={`w-1.5 h-1.5 rounded-full transition-colors ${
                    topicsCovered.includes(t) ? 'bg-purple-500' : 'bg-gray-300'
                  }`}
                />
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-3">
          {/* Guidance toggle on mobile */}
          {phase === 'chat' && activeTopic && (
            <button
              onClick={() => setShowInlineGuidance(v => !v)}
              className="lg:hidden flex items-center gap-1 text-xs text-purple-600 hover:text-purple-800"
            >
              <Lightbulb className="w-3.5 h-3.5" />
              Tips
            </button>
          )}
          <Link
            href="/create/form"
            className="text-xs text-gray-400 hover:text-purple-600 transition-colors"
          >
            Fill the form in detail instead →
          </Link>
        </div>
      </div>

      {/* Main layout */}
      <div className="flex-1 flex overflow-hidden">

        {/* Chat column */}
        <main className="flex-1 flex flex-col overflow-hidden">

          {/* Chat area */}
          <div className="flex-1 overflow-y-auto px-4 py-6 max-w-2xl w-full mx-auto lg:max-w-none">
            {phase === 'loading' && (
              <div className="flex items-center justify-center h-32">
                <Loader2 className="w-5 h-5 animate-spin text-purple-400" />
              </div>
            )}

            <div className="space-y-4 max-w-2xl mx-auto">
              {(() => {
                let lastAiIndex = -1;
                for (let i = messages.length - 1; i >= 0; i--) {
                  if (messages[i].role === 'ai') { lastAiIndex = i; break; }
                }
                return messages.map((msg, i) => {
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
                const isLastAi = isAi && i === lastAiIndex;
                return (
                  <div key={i}>
                    <div className={`flex gap-3 ${isAi ? 'justify-start' : 'justify-end'}`}>
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
                    {/* Inline guidance on mobile — shown below the last AI message */}
                    {isLastAi && showInlineGuidance && activeTopic && phase === 'chat' && (
                      <div className="lg:hidden mt-3 ml-10">
                        <GuidancePanel topicsCovered={topicsCovered} />
                      </div>
                    )}
                  </div>
                );
              });
              })()}

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

              {phase === 'creating' && (
                <div className="flex justify-center py-4">
                  <div className="flex items-center gap-2 text-sm text-gray-500 bg-white border border-gray-200 rounded-full px-4 py-2">
                    <Loader2 className="w-4 h-4 animate-spin text-purple-500" />
                    Building your twin…
                  </div>
                </div>
              )}

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

          {/* Stall nudge — AI acknowledged without asking next question */}
          {aiStalled && !canCreateManually && (
            <div className="bg-amber-50 border-t border-amber-100 px-4 py-2 shrink-0">
              <div className="max-w-2xl mx-auto flex items-center justify-between">
                <p className="text-xs text-amber-700">Looks like the next question got lost — tap to continue.</p>
                <button
                  disabled={sending}
                  onClick={async () => {
                    if (sending) return;
                    setSending(true);
                    const token = await getToken();
                    if (!token) {
                      setSending(false);
                      router.push('/sign-in');
                      return;
                    }
                    const nudge: ApiHistoryItem = { role: 'user', content: 'Please continue with the next question.' };
                    const newHistory = [...apiHistory, nudge];
                    setApiHistory(newHistory);

                    // Keep UI transcript and turn counting in sync with backend history
                    setMessages(prevMessages => [
                      ...prevMessages,
                      { role: 'user', content: nudge.content },
                    ]);
                    setUserTurnCount(prevCount => prevCount + 1);
                    await callOnboard(newHistory, fieldsCollected, topicsCovered, linkedinParsed, token);
                  }}
                  className="text-xs font-medium px-3 py-1.5 bg-amber-500 text-white rounded-lg hover:bg-amber-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Continue →
                </button>
              </div>
            </div>
          )}

          {/* Manual create banner */}
          {canCreateManually && (
            <div className="bg-white border-t border-purple-100 px-4 py-2 shrink-0">
              <div className="max-w-2xl mx-auto flex items-center justify-between">
                <p className="text-xs text-gray-400">
                  {topicsCovered.length >= ALL_TOPICS.length
                    ? "You've covered everything!"
                    : `${topicsCovered.length}/${ALL_TOPICS.length} topics covered — you can create now or keep going`}
                </p>
                <button
                  onClick={createManually}
                  className="text-xs font-medium px-3 py-1.5 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors"
                >
                  Create my twin →
                </button>
              </div>
            </div>
          )}

          {/* Input area */}
          {(phase === 'chat' || phase === 'loading') && (
            <div className="bg-white border-t border-gray-200 px-4 py-3 shrink-0">
              <div className="max-w-2xl mx-auto space-y-2">

                {/* VOICE topic: preset verbal quirk chips */}
                {activeTopic === 'VOICE' && phase === 'chat' && !sending && (
                  <div className="flex flex-wrap gap-1.5">
                    {VOICE_QUIRK_CHIPS.map(chip => (
                      <button
                        key={chip}
                        onClick={() =>
                          setInput(prev => {
                            const next = prev ? `${prev}, ${chip}` : chip;
                            return next.length > MAX_CHARS ? next.slice(0, MAX_CHARS) : next;
                          })
                        }
                        className="text-xs px-2.5 py-1 rounded-full border border-gray-200 text-gray-600 hover:border-purple-400 hover:text-purple-700 hover:bg-purple-50 transition-colors"
                      >
                        {chip}
                      </button>
                    ))}
                  </div>
                )}

                <div className="flex items-end gap-2">
                  {!linkedinParsed && (
                    <>
                      <div className="flex flex-col items-center gap-0.5 shrink-0 mb-1">
                        <button
                          onClick={() => fileInputRef.current?.click()}
                          disabled={parsing || sending}
                          title="Upload LinkedIn PDF to skip background questions"
                          className="p-2 text-gray-400 hover:text-purple-600 disabled:opacity-40 transition-colors rounded-lg hover:bg-gray-100"
                        >
                          {parsing ? (
                            <Loader2 className="w-5 h-5 animate-spin" />
                          ) : (
                            <Paperclip className="w-5 h-5" />
                          )}
                        </button>
                        <span className="text-[10px] text-gray-400 leading-none">LinkedIn</span>
                      </div>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept=".pdf"
                        onChange={handleLinkedIn}
                        className="hidden"
                      />
                    </>
                  )}

                  {linkedinParsed && (
                    <div className="mb-1 flex items-center gap-1 text-xs text-purple-600 bg-purple-50 border border-purple-200 rounded-full px-2.5 py-1 shrink-0">
                      <Check className="w-3 h-3" /> LinkedIn
                    </div>
                  )}

                  <div className="flex-1 relative">
                    <textarea
                      ref={inputRef}
                      value={input}
                      onChange={e => setInput(e.target.value.slice(0, MAX_CHARS))}
                      onKeyDown={e => {
                        if (
                          e.key === 'Enter' &&
                          !e.shiftKey &&
                          !sending &&
                          phase !== 'loading' &&
                          !parsing &&
                          input.trim()
                        ) {
                          e.preventDefault();
                          sendMessage();
                        }
                      }}
                      placeholder="Type your answer…"
                      rows={1}
                      disabled={sending || phase === 'loading' || parsing}
                      className="w-full resize-none px-4 py-2.5 border border-gray-300 rounded-xl text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-purple-500 disabled:opacity-50 leading-relaxed"
                    />
                    {input.length > MAX_CHARS * 0.8 && (
                      <span className={`absolute bottom-1.5 right-2.5 text-[10px] ${
                        input.length >= MAX_CHARS ? 'text-red-400' : 'text-gray-400'
                      }`}>
                        {MAX_CHARS - input.length}
                      </span>
                    )}
                  </div>

                  <button
                    onClick={sendMessage}
                    disabled={!input.trim() || sending || phase === 'loading' || parsing}
                    className="mb-1 p-2 bg-purple-600 text-white rounded-xl hover:bg-purple-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
                  >
                    <Send className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          )}
        </main>

        {/* Desktop guidance sidebar */}
        {phase === 'chat' && activeTopic && (
          <aside className="hidden lg:block w-72 xl:w-80 shrink-0 border-l border-gray-200 bg-gray-50 overflow-y-auto p-4">
            <GuidancePanel topicsCovered={topicsCovered} />
          </aside>
        )}
      </div>
    </div>
  );
}
