import { forwardRef } from 'react';
import {
  AudioLinesIcon,
  BrainIcon,
  BriefcaseBusinessIcon as Building2Icon,
  CpuIcon,
  DownloadIcon as ImportIcon,
  MailboxIcon,
  PaletteIcon,
  RadioTowerIcon,
  RefreshCwIcon,
  SlidersHorizontalIcon,
  UserIcon as UserRoundIcon,
} from '@/components/icons';
import type { IconComponent } from '@/components/icons';

export interface SectionMeta {
  slug: string;
  label: string;
  /** One line under the section title. Says what the section decides. */
  description: string;
  icon: IconComponent;
  /** Set for an entry that leaves the dialog for a page of its own. */
  href?: string;
}

export interface SectionGroup {
  label: string;
  sections: readonly SectionMeta[];
}

/*
  Three of the section icons exist as animate-ui variants; they play their
  small gesture when the navigation is hovered. The forwardRef wrapper is
  needed because `SectionMeta.icon` is typed as IconComponent and rendered
  without props - the same trick as AnimatedPlugZapIcon in EmptyState.
*/
const AnimatedUserRoundIcon = forwardRef<SVGSVGElement>(function AnimatedUserRoundIcon() {
  return <UserRoundIcon />;
});

const AnimatedSlidersHorizontalIcon = forwardRef<SVGSVGElement>(
  function AnimatedSlidersHorizontalIcon() {
    return <SlidersHorizontalIcon />;
  },
);

const AnimatedAudioLinesIcon = forwardRef<SVGSVGElement>(function AnimatedAudioLinesIcon() {
  return <AudioLinesIcon />;
});

export const GROUPS: readonly SectionGroup[] = [
  {
    label: 'Assistant',
    sections: [
      {
        slug: 'profile',
        label: 'Profile',
        description: 'The assistant name, how it addresses you, and its profile files.',
        icon: AnimatedUserRoundIcon,
      },
      {
        slug: 'behavior',
        label: 'Behavior',
        description: 'How much effort a new conversation spends, and what it may do.',
        icon: AnimatedSlidersHorizontalIcon,
      },
      {
        slug: 'voice',
        label: 'Voice',
        description: 'How spoken replies are generated and how they sound.',
        icon: AnimatedAudioLinesIcon,
      },
      {
        slug: 'memory',
        label: 'Memory',
        description: 'What is remembered and how much context the assistant recalls.',
        icon: BrainIcon,
      },
    ],
  },
  {
    label: 'Models',
    sections: [
      {
        slug: 'providers',
        label: 'Providers',
        description: 'Who answers by default, who takes over when quota runs out, and more providers.',
        icon: CpuIcon,
      },
    ],
  },
  {
    label: 'Work',
    sections: [
      {
        slug: 'org',
        label: 'Organization',
        description: 'Limits for agent work and delegation.',
        icon: Building2Icon,
      },
    ],
  },
  {
    label: 'Connections',
    sections: [
      {
        slug: 'mailboxes',
        label: 'Mailboxes',
        description: 'Mailboxes Rookery watches, and the schedule each one fires.',
        icon: MailboxIcon,
      },
      {
        slug: 'gateways',
        label: 'Telegram & gateways',
        description: 'Chat channels outside this app.',
        icon: RadioTowerIcon,
        href: '/gateways',
      },
    ],
  },
  {
    label: 'App',
    sections: [
      {
        slug: 'appearance',
        label: 'Appearance',
        description: 'Display and detail preferences for this browser only.',
        icon: PaletteIcon,
      },
      {
        slug: 'import',
        label: 'Import',
        description: 'Bring your assistant from OpenClaw or Hermes.',
        icon: ImportIcon,
      },
      {
        slug: 'updates',
        label: 'Updates',
        description: 'Which version runs here, and how new versions are installed.',
        icon: RefreshCwIcon,
      },
    ],
  },
];

export const SECTIONS: readonly SectionMeta[] = GROUPS.flatMap((group) => group.sections);

/** Where `/settings` alone lands. */
export const FIRST_SECTION_SLUG = 'profile';

/**
 * Addresses that existed before the regrouping, and the German ones before
 * that. A bookmark or an older link lands where it meant to go instead of on
 * the first section.
 */
const LEGACY_SLUGS: Record<string, string> = {
  identity: 'profile',
  defaults: 'providers',
  listeners: 'mailboxes',
  migration: 'import',
  identitaet: 'profile',
  standardwerte: 'providers',
  sprache: 'voice',
  gedaechtnis: 'memory',
  firma: 'org',
  ansicht: 'appearance',
};

/** Resolves any slug the dialog was opened with to one it can show. */
export function resolveSettingsSection(slug: string | undefined): string {
  if (!slug) return FIRST_SECTION_SLUG;
  const moved = LEGACY_SLUGS[slug] ?? slug;
  return SECTIONS.some((entry) => entry.slug === moved && !entry.href) ? moved : FIRST_SECTION_SLUG;
}
