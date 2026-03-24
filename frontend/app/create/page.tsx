'use client';

import { useState, useRef, useEffect } from 'react';
import { ArrowLeft, ArrowRight, Check, Upload, Loader2, Sparkles, ChevronDown } from 'lucide-react';

interface FormData {
  name: string;
  title: string;
  bio: string;
  skills: string;
  experience: string;
  achievements: string;
  communicationStyle: string;
  verbalQuirks: string;
  responseStyle: 'concise' | 'balanced' | 'detailed';
  email: string;
  archetype_id: string;
}

interface Archetype {
  id: string;
  display_name: string;
}

const PRESET_QUIRKS = [
  "Always starts with 'So here's the thing...'",
  "Says 'at the end of the day' a lot",
  "Asks 'what's the worst case?' before agreeing",
  "Thinks out loud before landing on an answer",
  "Short sentences. No fluff.",
  "Uses analogies to explain technical things",
  "Ends with 'does that make sense?'",
  "Brings everything back to first principles",
  "Says 'I don't know' openly when uncertain",
  "Prefers bullet points over paragraphs",
  "Steelmans the opposing view before arguing",
  "Uses 'to be fair' as a filler",
  "Never uses exclamation marks",
  "Starts questions with 'Curious —'",
  "Challenges assumptions before answering",
  "Uses 'the thing is...' a lot",
];

const STEPS = [
  { id: 1, label: 'Basic Info' },
  { id: 2, label: 'Skills & Experience' },
  { id: 3, label: 'Personality' },
  { id: 4, label: 'Done' },
];

const empty: FormData = {
  name: '',
  title: '',
  bio: '',
  skills: '',
  experience: '',
  achievements: '',
  communicationStyle: '',
  verbalQuirks: '',
  responseStyle: 'balanced',
  email: '',
  archetype_id: '',
};

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

export default function CreatePage() {
  const [step, setStep] = useState(1);
  const [form, setForm] = useState<FormData>(empty);
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [twinResult, setTwinResult] = useState<{ twin_id: string; chat_url: string; name: string } | null>(null);
  const [archetypes, setArchetypes] = useState<Archetype[]>([]);
  const [detectedArchetype, setDetectedArchetype] = useState<string | null>(null);
  const [showArchetypeDropdown, setShowArchetypeDropdown] = useState(false);
  const [selectedQuirks, setSelectedQuirks] = useState<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);

  const toggleQuirk = (quirk: string) =>
    setSelectedQuirks(prev => {
      const next = new Set(prev);
      next.has(quirk) ? next.delete(quirk) : next.add(quirk);
      return next;
    });

  useEffect(() => {
    fetch(`${API}/archetypes`)
      .then(r => r.json())
      .then(d => setArchetypes(d.archetypes || []))
      .catch(() => {});
  }, []);

  const handleLinkedInUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setParsing(true);
    setParseError('');
    setDetectedArchetype(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(`${API}/parse-linkedin`, { method: 'POST', body: formData });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || 'Failed to parse PDF');
      }
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
        archetype_id: data.archetype_id || prev.archetype_id,
      }));
      if (data.archetype_id) {
        setDetectedArchetype(data.archetype_display_name);
      }
    } catch (err: unknown) {
      setParseError(err instanceof Error ? err.message : 'Failed to parse PDF');
    } finally {
      setParsing(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const set = (field: keyof FormData) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm(prev => ({ ...prev, [field]: e.target.value }));

  const canAdvance = () => {
    if (step === 1) return form.name.trim() && form.title.trim() && form.bio.trim();
    if (step === 2) return form.skills.trim() && form.experience.trim();
    if (step === 3) return form.communicationStyle.trim();
    return true;
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    setSubmitError('');
    try {
      const res = await fetch(`${API}/twins`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name,
          title: form.title,
          bio: form.bio,
          skills: form.skills,
          experience: form.experience,
          achievements: form.achievements,
          communicationStyle: form.communicationStyle,
          responseStyle: form.responseStyle,
          verbalQuirks: [
            ...[...selectedQuirks],
            ...(form.verbalQuirks.trim() ? [form.verbalQuirks.trim()] : []),
          ].join('\n'),
          email: form.email,
          archetype_id: form.archetype_id || null,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || 'Failed to create twin');
      }
      const data = await res.json();
      setTwinResult({ twin_id: data.twin_id, chat_url: data.chat_url, name: data.name });
      setStep(4);
    } catch (err: unknown) {
      setSubmitError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  };

  const selectedArchetypeName = archetypes.find(a => a.id === form.archetype_id)?.display_name;

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
            <p className="text-gray-500 mt-1">Fill in your details and we&apos;ll build a personalized AI twin for you.</p>
          </div>

          {/* Step indicators */}
          <div className="flex items-center gap-2 mb-8">
            {STEPS.map((s, i) => (
              <div key={s.id} className="flex items-center gap-2">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium transition-colors ${
                  step > s.id ? 'bg-purple-600 text-white' :
                  step === s.id ? 'bg-purple-100 text-purple-700 border-2 border-purple-600' :
                  'bg-gray-100 text-gray-400'
                }`}>
                  {step > s.id ? <Check className="w-4 h-4" /> : s.id}
                </div>
                <span className={`text-sm ${step === s.id ? 'text-gray-800 font-medium' : 'text-gray-400'}`}>{s.label}</span>
                {i < STEPS.length - 1 && <div className="w-8 h-px bg-gray-200 mx-1" />}
              </div>
            ))}
          </div>

          {/* Form card */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-8">
            {step === 1 && (
              <div className="space-y-5">
                <h2 className="text-xl font-semibold text-gray-800 mb-4">Tell us about yourself</h2>

                {/* LinkedIn PDF upload */}
                <div className="border-2 border-dashed border-purple-200 rounded-lg p-4 bg-purple-50">
                  <p className="text-sm font-medium text-purple-700 mb-2">Have a LinkedIn PDF? Auto-fill from it</p>
                  <p className="text-xs text-gray-500 mb-3">
                    Export your profile from LinkedIn → Me → View Profile → More → Save to PDF
                  </p>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".pdf"
                    onChange={handleLinkedInUpload}
                    className="hidden"
                    id="linkedin-upload"
                  />
                  <label
                    htmlFor="linkedin-upload"
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium cursor-pointer transition-colors w-fit ${
                      parsing ? 'bg-purple-200 text-purple-500 cursor-not-allowed' : 'bg-purple-600 text-white hover:bg-purple-700'
                    }`}
                  >
                    {parsing ? (
                      <><Loader2 className="w-4 h-4 animate-spin" /> Parsing...</>
                    ) : (
                      <><Upload className="w-4 h-4" /> Upload LinkedIn PDF</>
                    )}
                  </label>
                  {parseError && <p className="text-xs text-red-500 mt-2">{parseError}</p>}

                  {/* Archetype detection result */}
                  {detectedArchetype && (
                    <div className="mt-3 flex items-center gap-2">
                      <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-purple-100 text-purple-700 rounded-full text-xs font-medium">
                        <Sparkles className="w-3 h-3" />
                        Detected: {detectedArchetype}
                      </span>
                      <button
                        type="button"
                        onClick={() => setShowArchetypeDropdown(v => !v)}
                        className="text-xs text-gray-500 hover:text-gray-700 underline underline-offset-2"
                      >
                        change
                      </button>
                    </div>
                  )}
                </div>

                {/* Archetype selector — shown when: no auto-detect, or user clicked change */}
                {(showArchetypeDropdown || (!detectedArchetype && archetypes.length > 0)) && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Role Archetype <span className="text-gray-400 font-normal">(optional — shapes twin personality)</span>
                    </label>
                    <div className="relative">
                      <select
                        value={form.archetype_id}
                        onChange={e => {
                          set('archetype_id')(e);
                          const chosen = archetypes.find(a => a.id === e.target.value);
                          setDetectedArchetype(chosen?.display_name || null);
                          setShowArchetypeDropdown(false);
                        }}
                        className="w-full appearance-none px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 text-gray-800 bg-white pr-10"
                      >
                        <option value="">Select a role archetype...</option>
                        {archetypes.map(a => (
                          <option key={a.id} value={a.id}>{a.display_name}</option>
                        ))}
                      </select>
                      <ChevronDown className="absolute right-3 top-2.5 w-4 h-4 text-gray-400 pointer-events-none" />
                    </div>
                    {selectedArchetypeName && (
                      <p className="text-xs text-gray-500 mt-1">
                        The twin&apos;s responses will be reviewed by a {selectedArchetypeName} personality agent.
                      </p>
                    )}
                  </div>
                )}

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Full Name *</label>
                  <input
                    type="text"
                    value={form.name}
                    onChange={set('name')}
                    placeholder="e.g. Jane Smith"
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 text-gray-800"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Professional Title *</label>
                  <input
                    type="text"
                    value={form.title}
                    onChange={set('title')}
                    placeholder="e.g. Senior Software Engineer at Acme"
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 text-gray-800"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Short Bio *</label>
                  <textarea
                    value={form.bio}
                    onChange={set('bio')}
                    rows={4}
                    placeholder="A few sentences about who you are, what you do, and what drives you..."
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 text-gray-800 resize-none"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Email (to receive your twin link)</label>
                  <input
                    type="email"
                    value={form.email}
                    onChange={set('email')}
                    placeholder="you@example.com"
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 text-gray-800"
                  />
                </div>
              </div>
            )}

            {step === 2 && (
              <div className="space-y-5">
                <h2 className="text-xl font-semibold text-gray-800 mb-4">Skills &amp; Experience</h2>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Key Skills *</label>
                  <textarea
                    value={form.skills}
                    onChange={set('skills')}
                    rows={3}
                    placeholder="e.g. Python, Machine Learning, System Design, Product Strategy..."
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 text-gray-800 resize-none"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Work Experience *</label>
                  <textarea
                    value={form.experience}
                    onChange={set('experience')}
                    rows={5}
                    placeholder="List your roles and what you did. e.g.&#10;- Acme Corp (2021–now): Led backend team, scaled API to 10M req/day&#10;- Startup X (2018–2021): Built ML pipeline from scratch..."
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 text-gray-800 resize-none"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Notable Achievements</label>
                  <textarea
                    value={form.achievements}
                    onChange={set('achievements')}
                    rows={3}
                    placeholder="e.g. Published paper at NeurIPS, grew team from 3 to 20, raised $5M seed..."
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 text-gray-800 resize-none"
                  />
                </div>
              </div>
            )}

            {step === 3 && (
              <div className="space-y-5">
                <h2 className="text-xl font-semibold text-gray-800 mb-4">Your Personality &amp; Style</h2>
                {form.archetype_id && selectedArchetypeName && (
                  <div className="flex items-start gap-2 p-3 bg-purple-50 border border-purple-100 rounded-lg text-sm text-purple-700">
                    <Sparkles className="w-4 h-4 mt-0.5 flex-shrink-0" />
                    <span>
                      <strong>{selectedArchetypeName}</strong> archetype will be applied — a personality agent will shape
                      how your twin communicates based on this role&apos;s traits.
                    </span>
                  </div>
                )}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Response length</label>
                  <div className="grid grid-cols-3 gap-2">
                    {([
                      { value: 'concise', label: 'Concise', desc: '1–3 sentences' },
                      { value: 'balanced', label: 'Balanced', desc: '3–6 sentences' },
                      { value: 'detailed', label: 'Detailed', desc: 'Full explanation' },
                    ] as const).map(opt => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => setForm(prev => ({ ...prev, responseStyle: opt.value }))}
                        className={`p-3 rounded-lg border text-left transition-colors ${
                          form.responseStyle === opt.value
                            ? 'bg-purple-600 border-purple-600 text-white'
                            : 'bg-white border-gray-300 text-gray-700 hover:border-purple-400'
                        }`}
                      >
                        <div className="font-medium text-sm">{opt.label}</div>
                        <div className={`text-xs mt-0.5 ${form.responseStyle === opt.value ? 'text-purple-200' : 'text-gray-400'}`}>{opt.desc}</div>
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Communication Style *</label>
                  <textarea
                    value={form.communicationStyle}
                    onChange={set('communicationStyle')}
                    rows={5}
                    placeholder="How do you talk? e.g. Direct and concise, love analogies, use humor, avoid jargon, always ask follow-up questions, prefer big-picture thinking before details..."
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 text-gray-800 resize-none"
                  />
                  <p className="text-xs text-gray-400 mt-1">This shapes how your twin talks — be as specific as you like.</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Verbal quirks <span className="text-gray-400 font-normal">(optional — select any that fit)</span>
                  </label>
                  <div className="flex flex-wrap gap-2 mb-3">
                    {PRESET_QUIRKS.map(quirk => (
                      <button
                        key={quirk}
                        type="button"
                        onClick={() => toggleQuirk(quirk)}
                        className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors text-left ${
                          selectedQuirks.has(quirk)
                            ? 'bg-purple-600 text-white border-purple-600'
                            : 'bg-white text-gray-600 border-gray-300 hover:border-purple-400 hover:text-purple-600'
                        }`}
                      >
                        {quirk}
                      </button>
                    ))}
                  </div>
                  <textarea
                    value={form.verbalQuirks}
                    onChange={set('verbalQuirks')}
                    rows={2}
                    placeholder="Anything else specific to add..."
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 text-gray-800 resize-none text-sm"
                  />
                  <p className="text-xs text-gray-400 mt-1">The human fingerprint — small habits that make this person sound like themselves.</p>
                </div>
              </div>
            )}

            {step === 4 && twinResult && (
              <div className="text-center py-8">
                <div className="w-16 h-16 bg-purple-100 rounded-full flex items-center justify-center mx-auto mb-4">
                  <Check className="w-8 h-8 text-purple-600" />
                </div>
                <h2 className="text-2xl font-semibold text-gray-800 mb-2">Your twin is ready!</h2>
                <p className="text-gray-500 max-w-sm mx-auto mb-6">
                  {twinResult.name}&apos;s AI twin has been created.
                  {form.email ? ` We'll also send the link to ${form.email}.` : ''}
                </p>
                <a
                  href={`/twin?id=${twinResult.twin_id}`}
                  className="inline-flex items-center gap-2 px-6 py-3 bg-purple-600 text-white rounded-lg hover:bg-purple-700 font-medium transition-colors"
                >
                  Chat with {twinResult.name}&apos;s Twin →
                </a>
              </div>
            )}

            {submitError && (
              <p className="text-sm text-red-500 mt-3">{submitError}</p>
            )}

            {/* Navigation */}
            {step < 4 && (
              <div className="flex justify-between mt-8">
                <button
                  onClick={() => setStep(s => s - 1)}
                  disabled={step === 1}
                  className="flex items-center gap-2 px-4 py-2 text-gray-600 hover:text-gray-800 disabled:opacity-0 transition-opacity"
                >
                  <ArrowLeft className="w-4 h-4" /> Back
                </button>
                {step < 3 ? (
                  <button
                    onClick={() => setStep(s => s + 1)}
                    disabled={!canAdvance()}
                    className="flex items-center gap-2 px-6 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    Next <ArrowRight className="w-4 h-4" />
                  </button>
                ) : (
                  <button
                    onClick={handleSubmit}
                    disabled={!canAdvance() || submitting}
                    className="flex items-center gap-2 px-6 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    {submitting ? <><Loader2 className="w-4 h-4 animate-spin" /> Creating...</> : <><Check className="w-4 h-4" /> Create Twin</>}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
