'use client';

import { useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import TwinChat from '@/components/twin-chat';

interface TwinRecord {
  twin_id: string;
  name: string;
  title: string;
  archetype_id: string | null;
  archetype_display_name: string | null;
}

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

function TwinPageInner() {
  const searchParams = useSearchParams();
  const id = searchParams.get('id');
  const [twin, setTwin] = useState<TwinRecord | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!id) { setError('No twin ID provided.'); return; }
    fetch(`${API}/twins/${id}`)
      .then(r => { if (!r.ok) throw new Error('Twin not found'); return r.json(); })
      .then(setTwin)
      .catch(() => setError('Twin not found.'));
  }, [id]);

  if (error) {
    return (
      <main className="min-h-screen bg-gradient-to-br from-slate-50 to-gray-100 flex items-center justify-center">
        <div className="text-center">
          <p className="text-gray-500 mb-4">{error}</p>
          <a href="/create" className="text-purple-600 hover:text-purple-800 underline underline-offset-2">Create a new twin</a>
        </div>
      </main>
    );
  }

  if (!twin) {
    return (
      <main className="min-h-screen bg-gradient-to-br from-slate-50 to-gray-100 flex items-center justify-center">
        <div className="text-gray-400 text-sm">Loading twin...</div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-50 to-gray-100">
      <div className="container mx-auto px-4 py-8">
        <div className="max-w-4xl mx-auto">
          <div className="mb-6 flex items-center justify-between">
            <a href="/" className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1">
              <ArrowLeft className="w-4 h-4" /> Home
            </a>
            {twin.archetype_display_name && (
              <span className="text-xs text-purple-600 bg-purple-50 border border-purple-100 px-3 py-1 rounded-full">
                ✨ {twin.archetype_display_name} personality
              </span>
            )}
          </div>
          <h1 className="text-3xl font-bold text-center text-gray-800 mb-1">{twin.name}&apos;s AI Twin</h1>
          <p className="text-center text-gray-500 text-sm mb-8">{twin.title}</p>
          <div className="h-[600px]">
            <TwinChat twinId={twin.twin_id} twinName={twin.name} />
          </div>
        </div>
      </div>
    </main>
  );
}

export default function TwinPage() {
  return (
    <Suspense fallback={
      <main className="min-h-screen bg-gradient-to-br from-slate-50 to-gray-100 flex items-center justify-center">
        <div className="text-gray-400 text-sm">Loading...</div>
      </main>
    }>
      <TwinPageInner />
    </Suspense>
  );
}
