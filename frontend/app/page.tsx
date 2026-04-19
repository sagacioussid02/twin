'use client';

import { useState, useEffect } from 'react';
import { useAuth, UserButton } from '@clerk/nextjs';
import Link from 'next/link';
import PersonaAvatar from '@/components/persona-avatar';
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
  return <img src="/personas-logo.svg" alt="" aria-hidden="true" className={className} />;
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

          {/* Horizontal personas strip */}
          {publicPersonas.length > 0 && (
            <div className="mb-6 rounded-2xl border border-indigo-100 bg-indigo-50/60 px-5 pt-4 pb-3 shadow-sm">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-indigo-500">Public personas</p>
                  <h2 className="text-sm font-semibold text-gray-800 mt-0.5">Borrow a point of view</h2>
                </div>
                <p className="text-xs text-gray-400 hidden sm:block">Free preview: 5 questions · Sign up for unlimited access</p>
              </div>
              <div className="overflow-hidden relative">
                <div className="pointer-events-none absolute left-0 inset-y-0 w-8 bg-gradient-to-r from-indigo-50/60 to-transparent z-10" />
                <div className="pointer-events-none absolute right-0 inset-y-0 w-8 bg-gradient-to-l from-indigo-50/60 to-transparent z-10" />
                <div className="flex animate-marquee-x" style={{ width: 'max-content' }}>
                  {marqueePersonas.map((p, index) => (
                    <Link
                      key={`${p.twin_id}-${index}`}
                      href={p.chat_url}
                      className="group flex-shrink-0 mr-3 flex items-center gap-3 rounded-xl border border-indigo-100 bg-white px-4 py-2.5 hover:border-indigo-300 hover:shadow-sm transition-all"
                      style={{ minWidth: '200px' }}
                    >
                      <PersonaAvatar
                        name={p.name}
                        seed={p.twin_id}
                        imageUrl={p.image_url}
                        className="w-9 h-9 shrink-0"
                        textClassName="text-xs"
                      />
                      <div className="min-w-0">
                        <p className="font-semibold text-gray-900 text-sm truncate">{p.name}</p>
                        <p className="text-xs text-gray-400 truncate">{p.era}</p>
                        <span className="text-xs text-indigo-500 group-hover:text-indigo-700 font-medium">Chat →</span>
                      </div>
                    </Link>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Main chat */}
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

          <footer className="mt-8 text-center text-sm text-gray-500 space-y-2">
            <p>Personas turns expertise into a living conversation.</p>
            <p className="text-xs text-gray-400 pt-4">© 2026 Binosus LLC · All rights reserved</p>
          </footer>
        </div>
      </div>
    </main>
  );
}
