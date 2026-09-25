import {
  BarChart3,
  BookOpen,
  Dumbbell,
  GraduationCap,
  Library,
  Lightbulb,
  Map,
  Sun,
} from 'lucide-react';

/** Sidebar pages, in order. Ctrl/Cmd+1…n jump to them. */
export const NAV = [
  { to: '/today', key: 'today', icon: Sun },
  { to: '/dashboard', key: 'dashboard', icon: BarChart3 },
  { to: '/knowledge', key: 'knowledge', icon: GraduationCap },
  { to: '/notebook', key: 'notebook', icon: BookOpen },
  { to: '/practice', key: 'practice', icon: Dumbbell },
  { to: '/insights', key: 'insights', icon: Lightbulb },
  { to: '/library', key: 'library', icon: Library },
  { to: '/roadmaps', key: 'roadmaps', icon: Map },
] as const;
