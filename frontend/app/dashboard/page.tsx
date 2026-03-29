'use client';

import { useUser, useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { Plus, MessageSquare, ExternalLink, Sparkles } from "lucide-react";
import AppNav from "@/components/app-nav";
import { useEffect, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

type DepthScore = 'Basic' | 'Developed' | 'Deep';

interface Twin {
  twin_id: string;
  name: string;
  title: string;
  archetype_display_name?: string;
  created_at: string;
  chat_url: string;
  depth_score?: DepthScore;
}

const DEPTH_STYLES: Record<DepthScore, { pill: string; label: string }> = {
  Basic:     { pill: 'bg-gray-100 text-gray-500 border-gray-200',         label: 'Basic' },
  Developed: { pill: 'bg-blue-50 text-blue-600 border-blue-100',          label: 'Developed' },
  Deep:      { pill: 'bg-purple-50 text-purple-600 border-purple-100',    label: 'Deep' },
};

export default function DashboardPage() {
  const { user } = useUser();
  const { getToken, isSignedIn, isLoaded } = useAuth();
  const [twins, setTwins] = useState<Twin[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      setLoading(false);
      return;
    }

    async function fetchTwins() {
      try {
        const token = await getToken();
        if (!token) {
          setError("Unable to retrieve auth token.");
          return;
        }
        const res = await fetch(`${API}/users/me/twins`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          throw new Error(`Request failed: ${res.status} ${res.statusText}`);
        }
        const data = await res.json();
        setTwins(data.twins || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load twins.");
      } finally {
        setLoading(false);
      }
    }
    fetchTwins();
  }, [isLoaded, isSignedIn, getToken]);

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <AppNav />

      <main className="max-w-4xl mx-auto px-6 py-10 flex-1">
        {/* Welcome */}
        <div className="mb-8">
          <div className="inline-flex items-center gap-2 bg-purple-50 border border-purple-100 text-purple-700 text-xs font-medium px-3 py-1 rounded-full mb-3">
            <span className="w-1.5 h-1.5 bg-purple-500 rounded-full animate-pulse" />
            Your workspace
          </div>
          <h1 className="text-2xl font-bold text-gray-900">
            Welcome back{user?.firstName ? `, ${user.firstName}` : ""}
          </h1>
          <p className="text-gray-500 mt-1">Build, refine, and share your personas</p>
        </div>

        {/* Twins grid */}
        {error && (
          <div className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-3">
            {error}
          </div>
        )}
        {loading ? (
          <div className="text-gray-400 text-sm">Loading...</div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Existing twins */}
            {twins.map(twin => (
              <div key={twin.twin_id} className="bg-white rounded-xl border border-gray-200 p-5 flex flex-col gap-3">
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold text-gray-900">{twin.name}</h3>
                    <p className="text-sm text-gray-500 mt-0.5">{twin.title}</p>
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      {twin.archetype_display_name && (
                        <span className="text-xs text-purple-600 bg-purple-50 border border-purple-100 px-2 py-0.5 rounded-full">
                          {twin.archetype_display_name}
                        </span>
                      )}
                      {twin.depth_score && DEPTH_STYLES[twin.depth_score] && (
                        <span className={`text-xs border px-2 py-0.5 rounded-full ${DEPTH_STYLES[twin.depth_score].pill}`}>
                          {DEPTH_STYLES[twin.depth_score].label}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex gap-2 mt-auto pt-2 border-t border-gray-100">
                  <Link
                    href={twin.chat_url}
                    className="flex items-center gap-1.5 text-xs text-purple-600 hover:text-purple-800 font-medium"
                  >
                    <MessageSquare className="w-3.5 h-3.5" />
                    Chat
                  </Link>
                  <Link
                    href={`/deepen?twin_id=${twin.twin_id}`}
                    className="flex items-center gap-1.5 text-xs text-indigo-500 hover:text-indigo-700 font-medium"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    Deepen
                  </Link>
                  <button
                    onClick={() => navigator.clipboard.writeText(`${window.location.origin}${twin.chat_url}`)}
                    className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 ml-auto"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    Copy link
                  </button>
                </div>
              </div>
            ))}

            {/* Create new twin card */}
            {twins.length < 2 && (
              <Link
                href="/create"
                className="bg-white rounded-xl border-2 border-dashed border-gray-200 p-5 flex flex-col items-center justify-center gap-2 hover:border-purple-400 hover:bg-purple-50 transition-colors group"
              >
                <div className="w-10 h-10 rounded-full bg-gray-100 group-hover:bg-purple-100 flex items-center justify-center transition-colors">
                  <Plus className="w-5 h-5 text-gray-400 group-hover:text-purple-600" />
                </div>
                <span className="text-sm font-medium text-gray-500 group-hover:text-purple-600">
                  Create a new persona
                </span>
                <span className="text-xs text-gray-400">
                  {twins.length}/2 twins used
                </span>
              </Link>
            )}

            {twins.length === 0 && (
              <div className="col-span-2 text-center py-8 text-gray-400 text-sm">
                You don&apos;t have any twins yet. Create your first one!
              </div>
            )}
          </div>
        )}
      </main>
      <footer className="text-center text-xs text-gray-400 py-6 border-t border-gray-100">
        © 2026 Binosus LLC · All rights reserved
      </footer>
    </div>
  );
}
