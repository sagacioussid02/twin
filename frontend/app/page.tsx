'use client';

import { useState, useEffect } from 'react';
import { useAuth, UserButton } from '@clerk/nextjs';
import Link from 'next/link';
import Twin from '@/components/twin';
import { Sparkles } from 'lucide-react';

interface PublicPersona {
  twin_id: string;
  name: string;
  title: string;
  tagline: string;
  era: string;
  image_url?: string;
  chat_url: string;
}

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

function PersonasLogo({ className = 'w-7 h-7' }: { className?: string }) {
  return <img src="/personas-logo.svg" alt="Personas logo" className={className} />;
}

function StreamingTagline() {
  const [taglines, setTaglines] = useState<string[]>([]);
  const [displayText, setDisplayText] = useState('');
  const [taglineIndex, setTaglineIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  // Fetch taglines from backend on mount
  useEffect(() => {
    const fetchTaglines = async () => {
      try {
        const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'}/taglines`);
        const data = await response.json();
        setTaglines(data.taglines || []);
        setIsLoading(false);
      } catch (error) {
        console.error('Error fetching taglines:', error);
        // Fallback taglines
        setTaglines([
          "Coffee with this guy",
          "Resumes are old school",
          "Your digital brainpower unleashed",
          "The future of collaboration is here",
          "AI that gets you",
          "Your second brain in action",
          "Talk to your smarter self",
          "Meet Sidd 2.0",
          "Intelligence amplified",
          "Your AI just leveled up"
        ]);
        setIsLoading(false);
      }
    };

    fetchTaglines();
  }, []);

  // Streaming effect for taglines
  useEffect(() => {
    if (taglines.length === 0) return;

    const currentTagline = taglines[taglineIndex];
    let currentIndex = 0;

    const interval = setInterval(() => {
      if (currentIndex <= currentTagline.length) {
        setDisplayText(currentTagline.substring(0, currentIndex));
        currentIndex++;
      } else {
        clearInterval(interval);
        setTimeout(() => {
          setTaglineIndex((prev) => (prev + 1) % taglines.length);
          setDisplayText('');
        }, 2000);
      }
    }, 50);

    return () => clearInterval(interval);
  }, [taglineIndex, taglines]);

  return (
    <span className="inline-block font-semibold text-base text-gray-500">
      {isLoading ? '' : displayText}
      <span className="animate-pulse text-purple-400">|</span>
    </span>
  );
}

export default function Home() {
  const { isSignedIn } = useAuth();
  const [publicPersonas, setPublicPersonas] = useState<PublicPersona[]>([]);

  useEffect(() => {
    fetch(`${API}/public-personas`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.personas) setPublicPersonas(data.personas); })
      .catch((error) => {
        console.error('Failed to load public personas:', error);
      });
  }, []);

  const marqueePersonas = publicPersonas.length > 0 ? [...publicPersonas, ...publicPersonas] : [];

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(59,130,246,0.18),_transparent_28%),radial-gradient(circle_at_top_right,_rgba(249,115,22,0.18),_transparent_24%),linear-gradient(180deg,_#f8fafc_0%,_#eef2ff_42%,_#f8fafc_100%)]">
      {/* Nav */}
      <nav className="flex items-center justify-between px-6 py-4 max-w-7xl mx-auto">
        <div className="flex items-center gap-2">
          <div className="w-9 h-9 rounded-xl shadow-md shadow-sky-200/60 overflow-hidden">
            <PersonasLogo className="w-full h-full" />
          </div>
          <span className="font-bold text-gray-800 tracking-tight">Personas</span>
        </div>
        <div className="flex items-center gap-3">
          {isSignedIn ? (
            <>
              <Link href="/dashboard" className="text-sm bg-purple-600 hover:bg-purple-700 text-white px-4 py-1.5 rounded-lg font-medium transition-colors">Dashboard</Link>
              <UserButton />
            </>
          ) : (
            <>
              <Link href="/sign-in" className="text-sm text-gray-600 hover:text-gray-900">Sign in</Link>
              <Link href="/sign-up" className="text-sm bg-gradient-to-r from-purple-600 to-indigo-600 text-white px-4 py-1.5 rounded-lg hover:opacity-90 transition-opacity font-medium">Get started</Link>
            </>
          )}
        </div>
      </nav>

      <div className="container mx-auto px-4 py-8">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-8">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-sky-200 bg-white/70 text-xs font-semibold uppercase tracking-[0.24em] text-sky-700 shadow-sm">
              <Sparkles className="w-3.5 h-3.5" />
              Your judgment, on demand
            </div>
            <h1 className="text-4xl md:text-5xl font-bold text-center text-gray-900 mt-4 mb-2 tracking-tight">
              Meet personas that think like real people
            </h1>
            <div className="text-center mb-2 h-7">
              <StreamingTagline />
            </div>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.35fr)_340px] gap-6 items-start">
            <section className="space-y-4">
              <div className="bg-white/60 border border-white rounded-3xl p-3 shadow-[0_24px_80px_-42px_rgba(15,23,42,0.45)] backdrop-blur-sm">
                <div className="h-[420px]">
                  <Twin />
                </div>
              </div>
              <div className="text-center text-sm text-gray-500 space-y-2">
                <p>Start with Sidd&apos;s persona, then build one trained on your own voice and decisions.</p>
                <Link
                  href="/create"
                  className="inline-block text-sky-700 hover:text-sky-900 font-medium underline underline-offset-2"
                >
                  Create your own persona →
                </Link>
              </div>
            </section>

            {publicPersonas.length > 0 && (
              <aside className="relative overflow-hidden rounded-[28px] border border-slate-200 bg-slate-950 text-white shadow-[0_24px_80px_-42px_rgba(15,23,42,0.75)]">
                <div className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-slate-950 via-slate-950/85 to-transparent z-10" />
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-slate-950 via-slate-950/85 to-transparent z-10" />
                <div className="px-5 pt-5 pb-3 border-b border-white/10">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-sky-300">Public personas</p>
                  <h2 className="text-lg font-semibold mt-1">Borrow a point of view</h2>
                  <p className="text-sm text-slate-300 mt-1">Historical and iconic minds rotating beside Sidd&apos;s chat.</p>
                </div>
                <div className="relative h-[470px] overflow-hidden">
                  <div className="animate-personas-marquee py-4">
                    {marqueePersonas.map((p, index) => (
                      <Link
                        key={`${p.twin_id}-${index}`}
                        href={p.chat_url}
                        className="group mx-4 mb-4 block rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur-sm hover:bg-white/10 hover:border-sky-300/40 transition-all"
                      >
                        <div className="flex items-center gap-3">
                          <div className="w-14 h-14 rounded-2xl overflow-hidden bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center text-white font-bold text-sm shrink-0 border border-white/10">
                            {p.image_url ? (
                              <img src={p.image_url} alt={p.name} className="w-full h-full object-cover" />
                            ) : (
                              p.name.split(' ').map(n => n[0]).join('').slice(0, 2)
                            )}
                          </div>
                          <div className="min-w-0">
                            <p className="font-semibold text-white text-sm">{p.name}</p>
                            <p className="text-xs text-slate-400 truncate">{p.era}</p>
                          </div>
                        </div>
                        <p className="text-sm text-slate-300 leading-relaxed mt-3">{p.tagline}</p>
                        <span className="mt-3 inline-flex text-xs font-medium text-sky-300 group-hover:text-sky-200">
                          Start conversation →
                        </span>
                      </Link>
                    ))}
                  </div>
                </div>
                <p className="px-5 pb-5 text-center text-xs text-slate-400">Free preview: 5 questions · Sign up for unlimited access</p>
              </aside>
            )}
          </div>

          <footer className="mt-8 text-center text-sm text-gray-500 space-y-2">
            <p>Personas turns expertise into a living conversation.</p>
            <p className="text-xs text-gray-400 pt-4">© 2026 Binosus LLC · All rights reserved</p>
          </footer>
        </div>
      </div>
    </main>
  );
}
