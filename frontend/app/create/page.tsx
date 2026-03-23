'use client';

import { useState, useRef } from 'react';
import { ArrowLeft, ArrowRight, Check, Upload, Loader2 } from 'lucide-react';

interface FormData {
  // Step 1 — Basic Info
  name: string;
  title: string;
  bio: string;
  email: string;
  // Step 2 — Skills & Experience
  skills: string;
  experience: string;
  achievements: string;
  // Step 3 — Values & Decisions
  coreValues: string;
  decisionStyle: string;
  riskTolerance: string;
  pastDecisions: string;
  // Step 4 — Voice & Style
  communicationStyle: string;
  writingSamples: string;
  blindSpots: string;
}

const STEPS = [
  { id: 1, label: 'Basic Info' },
  { id: 2, label: 'Experience' },
  { id: 3, label: 'Values & Decisions' },
  { id: 4, label: 'Voice & Style' },
  { id: 5, label: 'Done' },
];

const TOTAL_CONTENT_STEPS = 4;

const SAMPLES: Partial<FormData>[] = [
  // Step 1
  {
    name: 'Alex Rivera',
    title: 'Staff Engineer at Stripe',
    bio: "I've spent 12 years building payment infrastructure and developer tools. Started as a backend engineer, moved into platform and now lead a team of 15. I care deeply about developer experience and making complex systems feel simple.",
    email: 'alex@example.com',
  },
  // Step 2
  {
    skills: 'Distributed systems, Go, Rust, Kubernetes, API design, Technical leadership, System design interviews',
    experience: "- Stripe (2019–now): Staff Eng on Payments Platform, led migration of core charge flow to new infra handling $500B/yr\n- Lyft (2016–2019): Senior Eng, built real-time pricing engine from scratch\n- IBM (2013–2016): Backend engineer on Watson APIs",
    achievements: "Reduced payment failure rate by 40% via retry logic redesign. Mentored 8 engineers who got promoted. Speaker at QCon 2022.",
  },
  // Step 3
  {
    coreValues: "- Simplicity over cleverness: I'll delete 200 lines before I add 10\n- Disagree and commit: I voice concerns once, clearly, then fully back the decision\n- Skin in the game: I won't ask my team to do something I haven't done or won't do",
    decisionStyle: "I write out the decision in one paragraph as if explaining to a smart friend. If I can't explain it clearly, I don't understand it well enough yet. I distinguish between reversible and irreversible decisions — fast on reversible, slow on irreversible. I distrust decisions made in meetings.",
    riskTolerance: 'medium',
    pastDecisions: "In 2021 I passed on a VP role at a Series B startup offering 3x my salary. The team was strong but the problem space felt like a solution looking for a problem. I stayed at Stripe. Six months later the startup pivoted twice and laid off half the team.",
  },
  // Step 4
  {
    communicationStyle: "Direct but not harsh. I use short sentences in writing. I over-explain in diagrams. I ask 'what problem are we solving?' a lot — sometimes annoyingly. I prefer async written communication over meetings.",
    writingSamples: 'https://alexrivera.dev/blog/on-simplicity',
    blindSpots: "I underestimate how long non-technical work takes (stakeholder alignment, legal review). I can be impatient with process. I sometimes optimize for technical elegance when 'good enough' would ship faster.",
  },
];

const empty: FormData = {
  name: '', title: '', bio: '', email: '',
  skills: '', experience: '', achievements: '',
  coreValues: '', decisionStyle: '', riskTolerance: '', pastDecisions: '',
  communicationStyle: '', writingSamples: '', blindSpots: '',
};

function Field({ label, required, hint, children }: {
  label: string; required?: boolean; hint?: string; children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">
        {label} {required && <span className="text-purple-500">*</span>}
      </label>
      {children}
      {hint && <p className="text-xs text-gray-400 mt-1">{hint}</p>}
    </div>
  );
}

const inputClass = "w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 text-gray-800";
const textareaClass = `${inputClass} resize-none`;

export default function CreatePage() {
  const [step, setStep] = useState(1);
  const [form, setForm] = useState<FormData>(empty);
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  interface PersonalityModel {
    personality_summary?: string;
    decision_framework?: string;
    core_values?: string[];
    decision_heuristics?: string[];
    [key: string]: unknown;
  }
  const [twinResult, setTwinResult] = useState<{ twin_id: string; personality_model: PersonalityModel } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const set = (field: keyof FormData) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      setForm(prev => ({ ...prev, [field]: e.target.value }));

  const handleLinkedInUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setParsing(true);
    setParseError('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'}/parse-linkedin`, {
        method: 'POST', body: fd,
      });
      if (!res.ok) { const err = await res.json(); throw new Error(err.detail || 'Failed to parse PDF'); }
      const data = await res.json();
      setForm(prev => ({
        ...prev,
        name: data.name || prev.name,
        title: data.title || prev.title,
        bio: data.bio || prev.bio,
        skills: data.skills || prev.skills,
        experience: data.experience || prev.experience,
        achievements: data.achievements || prev.achievements,
        communicationStyle: data.communicationStyle || prev.communicationStyle,
      }));
    } catch (err: unknown) {
      setParseError(err instanceof Error ? err.message : 'Failed to parse PDF');
    } finally {
      setParsing(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const canAdvance = () => {
    if (step === 1) return form.name.trim() && form.title.trim() && form.bio.trim();
    if (step === 2) return form.skills.trim() && form.experience.trim();
    if (step === 3) return form.coreValues.trim() && form.decisionStyle.trim();
    if (step === 4) return form.communicationStyle.trim();
    return true;
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    setSubmitError('');
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'}/create-twin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || 'Failed to create twin');
      }
      const data = await res.json();
      setTwinResult(data);
      setStep(5);
    } catch (err: unknown) {
      setSubmitError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-50 to-gray-100">
      <div className="container mx-auto px-4 py-12">
        <div className="max-w-2xl mx-auto">

          {/* Header */}
          <div className="mb-8">
            <a href="/" className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1 mb-4">
              <ArrowLeft className="w-4 h-4" /> Back to Sidd&apos;s Twin
            </a>
            <h1 className="text-3xl font-bold text-gray-800">Create Your AI Twin</h1>
            <p className="text-gray-500 mt-1">
              Your twin will answer &quot;What would I do?&quot; — so the more you share, the more accurate it gets.
            </p>
          </div>

          {/* Step indicators */}
          <div className="flex items-center mb-8 overflow-x-auto pb-1">
            {STEPS.map((s, i) => (
              <div key={s.id} className="flex items-center shrink-0">
                <div className="flex flex-col items-center gap-1">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium transition-colors ${
                    step > s.id ? 'bg-purple-600 text-white' :
                    step === s.id ? 'bg-purple-100 text-purple-700 border-2 border-purple-600' :
                    'bg-gray-100 text-gray-400'
                  }`}>
                    {step > s.id ? <Check className="w-4 h-4" /> : s.id}
                  </div>
                  <span className={`text-xs whitespace-nowrap ${step === s.id ? 'text-gray-800 font-medium' : 'text-gray-400'}`}>
                    {s.label}
                  </span>
                </div>
                {i < STEPS.length - 1 && <div className="w-8 h-px bg-gray-200 mx-2 mb-4 shrink-0" />}
              </div>
            ))}
          </div>

          {/* Form card */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-8">

            {/* ── Step 1: Basic Info ── */}
            {step === 1 && (
              <div className="space-y-5">
                <div className="flex items-center justify-between">
                  <h2 className="text-xl font-semibold text-gray-800">Tell us about yourself</h2>
                  <button onClick={() => setForm(p => ({ ...p, ...SAMPLES[0] }))} className="text-xs text-purple-500 hover:text-purple-700 underline">Fill sample</button>
                </div>

                <div className="border-2 border-dashed border-purple-200 rounded-lg p-4 bg-purple-50">
                  <p className="text-sm font-medium text-purple-700 mb-1">Have a LinkedIn PDF? Auto-fill from it</p>
                  <p className="text-xs text-gray-500 mb-3">
                    LinkedIn → Me → View Profile → More → Save to PDF
                  </p>
                  <input ref={fileInputRef} type="file" accept=".pdf" onChange={handleLinkedInUpload} className="hidden" id="linkedin-upload" />
                  <label htmlFor="linkedin-upload" className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium cursor-pointer transition-colors w-fit ${
                    parsing ? 'bg-purple-200 text-purple-500 cursor-not-allowed' : 'bg-purple-600 text-white hover:bg-purple-700'
                  }`}>
                    {parsing ? <><Loader2 className="w-4 h-4 animate-spin" /> Parsing...</> : <><Upload className="w-4 h-4" /> Upload LinkedIn PDF</>}
                  </label>
                  {parseError && <p className="text-xs text-red-500 mt-2">{parseError}</p>}
                </div>

                <Field label="Full Name" required>
                  <input type="text" value={form.name} onChange={set('name')} placeholder="e.g. Jane Smith" className={inputClass} />
                </Field>
                <Field label="Professional Title" required>
                  <input type="text" value={form.title} onChange={set('title')} placeholder="e.g. Senior Engineer at Acme" className={inputClass} />
                </Field>
                <Field label="Short Bio" required hint="Who you are, what you do, what drives you.">
                  <textarea value={form.bio} onChange={set('bio')} rows={4} placeholder="I'm a..." className={textareaClass} />
                </Field>
                <Field label="Email" hint="We'll send your twin link here.">
                  <input type="email" value={form.email} onChange={set('email')} placeholder="you@example.com" className={inputClass} />
                </Field>
              </div>
            )}

            {/* ── Step 2: Skills & Experience ── */}
            {step === 2 && (
              <div className="space-y-5">
                <div className="flex items-center justify-between">
                  <h2 className="text-xl font-semibold text-gray-800">Skills &amp; Experience</h2>
                  <button onClick={() => setForm(p => ({ ...p, ...SAMPLES[1] }))} className="text-xs text-purple-500 hover:text-purple-700 underline">Fill sample</button>
                </div>
                <Field label="Key Skills" required hint="The more specific, the better your twin's domain knowledge.">
                  <textarea value={form.skills} onChange={set('skills')} rows={3}
                    placeholder="e.g. Python, System Design, Product Strategy, ML infrastructure..."
                    className={textareaClass} />
                </Field>
                <Field label="Work Experience" required hint="Roles you've held and what you actually did there.">
                  <textarea value={form.experience} onChange={set('experience')} rows={6}
                    placeholder={"- Acme (2021–now): Led backend team, scaled API to 10M req/day\n- Startup X (2018–21): Built ML pipeline from scratch, hired first 5 engineers"}
                    className={textareaClass} />
                </Field>
                <Field label="Notable Achievements" hint="Things you're proud of — shipped, built, won, or learned.">
                  <textarea value={form.achievements} onChange={set('achievements')} rows={3}
                    placeholder="e.g. Published at NeurIPS, grew team from 3→20, open source project with 2k stars..."
                    className={textareaClass} />
                </Field>
              </div>
            )}

            {/* ── Step 3: Values & Decisions ── */}
            {step === 3 && (
              <div className="space-y-5">
                <div className="flex items-start justify-between">
                  <div>
                    <h2 className="text-xl font-semibold text-gray-800">Values &amp; Decision-Making</h2>
                    <p className="text-sm text-gray-500 mt-1">This is the core of your twin — how you think and what you stand for.</p>
                  </div>
                  <button onClick={() => setForm(p => ({ ...p, ...SAMPLES[2] }))} className="text-xs text-purple-500 hover:text-purple-700 underline shrink-0 ml-4">Fill sample</button>
                </div>

                <Field label="Core Values" required hint="What principles guide your decisions? List 3–6 values and briefly explain each.">
                  <textarea value={form.coreValues} onChange={set('coreValues')} rows={5}
                    placeholder={"e.g.\n- Speed over perfection: ship fast, iterate\n- People first: I'll take a pay cut to work with great people\n- Ownership: I'd rather ask forgiveness than permission"}
                    className={textareaClass} />
                </Field>

                <Field label="How you make decisions" required hint="Walk us through your actual decision-making process.">
                  <textarea value={form.decisionStyle} onChange={set('decisionStyle')} rows={4}
                    placeholder={"e.g. I first identify what's reversible vs irreversible. For reversible decisions I move fast. For irreversible ones I sleep on it, write out pros/cons, and talk to one trusted person. I tend to be contrarian and distrust consensus..."}
                    className={textareaClass} />
                </Field>

                <Field label="Risk tolerance">
                  <select value={form.riskTolerance} onChange={set('riskTolerance')} className={inputClass}>
                    <option value="">Select one...</option>
                    <option value="low">Low — I prefer certainty and proven paths</option>
                    <option value="medium">Medium — calculated risks with clear upside</option>
                    <option value="high">High — I'd bet big if I believe in something</option>
                  </select>
                </Field>

                <Field
                  label="A hard decision you've made"
                  hint="Describe 1–2 real choices — what the situation was, what you chose, and why. This teaches your twin your actual judgment."
                >
                  <textarea value={form.pastDecisions} onChange={set('pastDecisions')} rows={5}
                    placeholder={"e.g. In 2022 I turned down a $50k raise to join a 5-person startup. My reasoning: the equity upside was larger but more importantly I was stagnating and needed the forcing function of building from zero again. Regrets: none so far..."}
                    className={textareaClass} />
                </Field>
              </div>
            )}

            {/* ── Step 4: Voice & Style ── */}
            {step === 4 && (
              <div className="space-y-5">
                <div className="flex items-start justify-between">
                  <div>
                    <h2 className="text-xl font-semibold text-gray-800">Voice &amp; Style</h2>
                    <p className="text-sm text-gray-500 mt-1">How your twin sounds and where its blind spots are.</p>
                  </div>
                  <button onClick={() => setForm(p => ({ ...p, ...SAMPLES[3] }))} className="text-xs text-purple-500 hover:text-purple-700 underline shrink-0 ml-4">Fill sample</button>
                </div>

                <Field label="Communication style" required hint="How do you actually talk and write? Be specific.">
                  <textarea value={form.communicationStyle} onChange={set('communicationStyle')} rows={4}
                    placeholder={"e.g. Direct, sometimes blunt. I use short sentences. I love analogies to explain complex things. I swear occasionally in casual settings. I ask a lot of 'why' questions. I hate small talk but will geek out for hours on a problem..."}
                    className={textareaClass} />
                </Field>

                <Field label="Writing samples or links" hint="Paste URLs to your blog, tweets, LinkedIn posts, or essays — anything that captures your voice.">
                  <textarea value={form.writingSamples} onChange={set('writingSamples')} rows={3}
                    placeholder={"e.g.\nhttps://yourblog.com/post-about-ai\nhttps://x.com/you/status/...\nor paste a paragraph of your own writing here..."}
                    className={textareaClass} />
                </Field>

                <Field label="Blind spots &amp; biases" hint="What are you bad at? What biases do you know you have? Honesty here makes your twin more accurate.">
                  <textarea value={form.blindSpots} onChange={set('blindSpots')} rows={4}
                    placeholder={"e.g. I tend to over-index on technical elegance and under-weight business reality. I'm impatient with slow decision-makers. I can be overly optimistic about timelines. I sometimes dismiss ideas from non-technical people too quickly..."}
                    className={textareaClass} />
                </Field>
              </div>
            )}

            {/* ── Step 5: Done ── */}
            {step === 5 && (
              <div className="space-y-6">
                <div className="text-center">
                  <div className="w-16 h-16 bg-purple-100 rounded-full flex items-center justify-center mx-auto mb-4">
                    <Check className="w-8 h-8 text-purple-600" />
                  </div>
                  <h2 className="text-2xl font-semibold text-gray-800 mb-1">Your twin is ready!</h2>
                  {twinResult && (
                    <a
                      href={`/twin?id=${twinResult.twin_id}`}
                      className="mt-2 inline-flex items-center gap-2 px-5 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors text-sm font-medium"
                    >
                      Talk to your twin →
                    </a>
                  )}
                  <p className="text-gray-400 text-xs mt-2">Save this link — it&apos;s the only way back to your twin.</p>
                </div>

                {twinResult && (
                  <div className="border border-purple-100 rounded-lg bg-purple-50 p-5 space-y-4">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-semibold text-purple-800">Personality Model Preview</p>
                      <span className="text-xs text-gray-400 font-mono">ID: {twinResult.twin_id}</span>
                    </div>

                    {twinResult.personality_model.personality_summary && (
                      <div>
                        <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Summary</p>
                        <p className="text-sm text-gray-700">{twinResult.personality_model.personality_summary}</p>
                      </div>
                    )}

                    {twinResult.personality_model.decision_framework && (
                      <div>
                        <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Decision Framework</p>
                        <p className="text-sm text-gray-700">{twinResult.personality_model.decision_framework}</p>
                      </div>
                    )}

                    {Array.isArray(twinResult.personality_model.core_values) && (
                      <div>
                        <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Core Values</p>
                        <div className="flex flex-wrap gap-2">
                          {twinResult.personality_model.core_values!.map((v, i) => (
                            <span key={i} className="text-xs bg-white border border-purple-200 text-purple-700 px-2 py-1 rounded-full">{v}</span>
                          ))}
                        </div>
                      </div>
                    )}

                    {Array.isArray(twinResult.personality_model.decision_heuristics) && (
                      <div>
                        <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Decision Heuristics</p>
                        <ul className="space-y-1">
                          {twinResult.personality_model.decision_heuristics!.map((h, i) => (
                            <li key={i} className="text-sm text-gray-700 flex gap-2"><span className="text-purple-400">→</span>{h}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Navigation */}
            {step <= TOTAL_CONTENT_STEPS && (
              <div className="flex justify-between mt-8">
                <button
                  onClick={() => setStep(s => s - 1)}
                  disabled={step === 1}
                  className="flex items-center gap-2 px-4 py-2 text-gray-600 hover:text-gray-800 disabled:opacity-0 transition-opacity"
                >
                  <ArrowLeft className="w-4 h-4" /> Back
                </button>
                {step < TOTAL_CONTENT_STEPS ? (
                  <button
                    onClick={() => setStep(s => s + 1)}
                    disabled={!canAdvance()}
                    className="flex items-center gap-2 px-6 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    Next <ArrowRight className="w-4 h-4" />
                  </button>
                ) : (
                  <div className="flex flex-col items-end gap-2">
                    {submitError && <p className="text-xs text-red-500">{submitError}</p>}
                    <button
                      onClick={handleSubmit}
                      disabled={!canAdvance() || submitting}
                      className="flex items-center gap-2 px-6 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      {submitting ? <><Loader2 className="w-4 h-4 animate-spin" /> Building twin...</> : <>Submit <Check className="w-4 h-4" /></>}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
