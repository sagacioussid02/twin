'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { UserButton, useAuth } from '@clerk/nextjs';
import { LayoutDashboard, Plus, Swords } from 'lucide-react';

const NAV_LINKS = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/create', label: 'Create Persona', icon: Plus },
  { href: '/debate', label: 'Debate', icon: Swords },
];

export default function AppNav() {
  const pathname = usePathname();
  const { isLoaded, isSignedIn } = useAuth();

  return (
    <header className="bg-white/80 backdrop-blur border-b border-gray-200/80 px-5 py-3 flex items-center justify-between shrink-0 sticky top-0 z-30">
      <div className="flex items-center gap-5">
        <Link href="/dashboard" className="flex items-center gap-2 shrink-0 group">
          <div className="w-7 h-7 bg-gradient-to-br from-purple-500 to-indigo-600 rounded-lg flex items-center justify-center shadow-sm group-hover:shadow-purple-200 transition-shadow">
            <span className="text-white text-xs font-bold tracking-tight">P</span>
          </div>
          <span className="font-bold text-gray-800 text-sm hidden sm:block tracking-tight">
            Personas
          </span>
        </Link>

        <nav className="flex items-center gap-1">
          {NAV_LINKS.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || pathname.startsWith(href + '/');
            return (
              <Link
                key={href}
                href={href}
                aria-label={label}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  active
                    ? 'bg-purple-50 text-purple-700'
                    : 'text-gray-500 hover:text-gray-800 hover:bg-gray-100'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span className="hidden sm:block">{label}</span>
              </Link>
            );
          })}
        </nav>
      </div>

      <div className="flex items-center gap-3">
        {isLoaded && isSignedIn && <UserButton />}
        {isLoaded && !isSignedIn && (
          <Link href="/sign-in" className="text-sm text-gray-500 hover:text-purple-600 font-medium transition-colors">
            Sign in
          </Link>
        )}
      </div>
    </header>
  );
}
