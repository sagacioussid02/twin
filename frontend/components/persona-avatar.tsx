'use client';

import { useMemo, useState } from 'react';

type Props = {
  name: string;
  seed: string;
  imageUrl?: string;
  className?: string;
  textClassName?: string;
};

const PALETTES = [
  { bg: 'from-sky-500 via-cyan-500 to-emerald-400', accent: 'bg-white/20', detail: 'bg-slate-950/20' },
  { bg: 'from-fuchsia-500 via-violet-500 to-indigo-500', accent: 'bg-white/20', detail: 'bg-slate-950/20' },
  { bg: 'from-amber-400 via-orange-500 to-rose-500', accent: 'bg-white/20', detail: 'bg-slate-950/20' },
  { bg: 'from-emerald-500 via-teal-500 to-sky-500', accent: 'bg-white/20', detail: 'bg-slate-950/20' },
  { bg: 'from-pink-500 via-rose-500 to-red-500', accent: 'bg-white/20', detail: 'bg-slate-950/20' },
  { bg: 'from-slate-700 via-slate-800 to-slate-950', accent: 'bg-white/10', detail: 'bg-amber-300/30' },
];

function hashSeed(seed: string) {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function initialsForName(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'P';
  return parts.slice(0, 2).map(part => part[0]?.toUpperCase() ?? '').join('');
}

export default function PersonaAvatar({
  name,
  seed,
  imageUrl,
  className = 'w-14 h-14',
  textClassName = 'text-sm',
}: Props) {
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null);

  const design = useMemo(() => {
    const hash = hashSeed(seed || name);
    return {
      palette: PALETTES[hash % PALETTES.length],
      rotate: (hash % 18) - 9,
      bubbleA: 18 + (hash % 30),
      bubbleB: 12 + ((hash >>> 3) % 22),
      waveOffset: 18 + ((hash >>> 5) % 28),
    };
  }, [name, seed]);

  const initials = initialsForName(name);
  const showImage = !!imageUrl && failedImageUrl !== imageUrl;

  return (
    <div className={`relative overflow-hidden rounded-2xl isolate bg-gradient-to-br ${design.palette.bg} ${className}`}>
      {showImage ? (
        <img
          src={imageUrl}
          alt={name}
          className="w-full h-full object-cover"
          onError={() => setFailedImageUrl(imageUrl ?? null)}
        />
      ) : (
        <>
          <div
            className={`absolute -top-3 -right-2 rounded-full ${design.palette.accent}`}
            style={{ width: `${design.bubbleA}px`, height: `${design.bubbleA}px` }}
          />
          <div
            className={`absolute bottom-2 -left-2 rounded-full ${design.palette.accent}`}
            style={{ width: `${design.bubbleB}px`, height: `${design.bubbleB}px` }}
          />
          <div
            className={`absolute inset-x-0 bottom-0 h-[46%] ${design.palette.detail}`}
            style={{
              clipPath: `polygon(0 ${design.waveOffset}%, 18% 0, 38% 24%, 58% 4%, 78% 24%, 100% 10%, 100% 100%, 0 100%)`,
              transform: `rotate(${design.rotate}deg) scale(1.1)`,
            }}
          />
          <div className="absolute inset-0 flex items-center justify-center">
            <span className={`font-semibold tracking-[0.18em] text-white drop-shadow-sm ${textClassName}`}>
              {initials}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
