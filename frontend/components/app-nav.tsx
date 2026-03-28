'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { UserButton } from '@clerk/nextjs';
import { LayoutDashboard, Plus, Swords } from 'lucide-react';

const NAV_LINKS = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/create', label: 'Create Twin', icon: Plus },
  { href: '/debate', label: 'Debate', icon: Swords },
];

export default function AppNav() {
  const pathname = usePathname();

  return (
    <header className="bg-white border-b border-gray-200 px-5 py-3 flex items-center justify-between shrink-0">
      <div className="flex items-center gap-5">
        <Link href="/dashboard" className="flex items-center gap-2 shrink-0">
          <div className="w-7 h-7 bg-purple-600 rounded-lg flex items-center justify-center">
            <span className="text-white text-xs font-bold">T</span>
          </div>
          <span className="font-semibold text-gray-800 text-sm hidden sm:block">AI Twin</span>
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

      <UserButton />
    </header>
  );
}
