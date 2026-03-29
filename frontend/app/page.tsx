'use client';

import { useState, useEffect } from 'react';
import { useAuth, UserButton } from '@clerk/nextjs';
import Link from 'next/link';
import Twin from '@/components/twin';

interface PublicPersona {
  twin_id: string;
  name: string;
  title: string;
  tagline: string;
  era: string;
  chat_url: string;
}

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

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
    <span className="inline-block font-semibold text-lg">
      {isLoading ? '✨ Loading...' : displayText}
      <span className="animate-pulse">|</span>
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

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-50 to-gray-100">
      {/* Nav */}
      <nav className="flex items-center justify-between px-6 py-4 max-w-4xl mx-auto">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 bg-gradient-to-br from-purple-500 to-indigo-600 rounded-lg flex items-center justify-center shadow-sm">
            <span className="text-white text-xs font-bold">P</span>
          </div>
          <span className="font-bold text-gray-800 tracking-tight">Personas</span>
        </div>
        <div className="flex items-center gap-3">
          {isSignedIn ? (
            <>
              <Link href="/dashboard" className="text-sm text-purple-600 hover:text-purple-800 font-medium">Dashboard</Link>
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
        <div className="max-w-4xl mx-auto">
          <h1 className="text-4xl font-bold text-center text-gray-800 mb-2">
            Sidd&apos;s AI Twin
          </h1>
          <div className="text-center text-gray-600 mb-8 h-6">
            <StreamingTagline />
          </div>

          <div className="h-[600px]">
            <Twin />
          </div>

          {/* Famous personas */}
          {publicPersonas.length > 0 && (
            <div className="mt-10">
              <p className="text-center text-xs font-semibold text-gray-400 uppercase tracking-widest mb-4">
                Or chat with a historical persona
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {publicPersonas.map(p => (
                  <Link
                    key={p.twin_id}
                    href={p.chat_url}
                    className="group bg-white rounded-xl border border-gray-200 p-5 flex flex-col gap-2 hover:border-purple-300 hover:shadow-sm transition-all"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center text-white font-bold text-sm shrink-0">
                        {p.name.split(' ').map(n => n[0]).join('').slice(0, 2)}
                      </div>
                      <div className="min-w-0">
                        <p className="font-semibold text-gray-900 text-sm">{p.name}</p>
                        <p className="text-xs text-gray-500 truncate">{p.era}</p>
                      </div>
                    </div>
                    <p className="text-xs text-gray-600 leading-relaxed">{p.tagline}</p>
                    <span className="text-xs text-purple-600 font-medium group-hover:underline mt-auto">
                      Start conversation →
                    </span>
                  </Link>
                ))}
              </div>
              <p className="text-center text-xs text-gray-400 mt-3">Free preview: 2 questions · Sign up for unlimited access</p>
            </div>
          )}

          <footer className="mt-8 text-center text-sm text-gray-500 space-y-2">
            <p>Your AI Companion Awaits</p>
            <Link
              href="/create"
              className="inline-block text-purple-600 hover:text-purple-800 font-medium underline underline-offset-2"
            >
              Create your own persona →
            </Link>
            <p className="text-xs text-gray-400 pt-4">© 2026 Binosus LLC · All rights reserved</p>
          </footer>
        </div>
      </div>
    </main>
  );
}