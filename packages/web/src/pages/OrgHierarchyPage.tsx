import { useMemo, useRef } from 'react';

import { EyeOffIcon as MonitorXIcon, GitGraphIcon as NetworkIcon } from '@/components/icons';

import { useOrgPerformance } from '@/hooks/useOrgPerformance';
import { useOrgState } from '@/providers/rookery-provider';
import { usePageMeta } from '@/components/shell/page-meta';
import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { EmptyState } from '@/components/common/empty-state';
import { Spinner } from '@/components/ui/spinner';

import { buildDefinition, buildTree } from './org/hierarchy-diagram';
import {
  useAgentNavigationCallback,
  useDiagramPalette,
  useMermaidDiagram,
} from './org/useHierarchyDiagram';

/**
 * The organigram, as Mermaid.
 *
 * A flowchart is Mermaid's job, not a hand-rolled tree of cards and
 * absolutely-positioned connector divs.
 *
 * Mermaid cannot read the app's oklch design tokens any more than the WebGL
 * memory cortex can (`components/memory-cortex`), so it gets the identical fix:
 * literal hex colours in a `.org-hierarchy-stage` class in `styles/index.css`,
 * redefined under `.dark`, read back with `getComputedStyle` and fed
 * into `mermaid.initialize({ themeVariables })`. A `MutationObserver` on the
 * root element's class re-renders the diagram when the theme flips, the
 * same mechanism the cortex uses for the other graph.
 */

const UNNAMED_COMPANY = 'the company';

export function OrgHierarchyPage() {
  usePageMeta({ title: 'Hierarchy' }, []);
  const org = useOrgState();
  const { entries } = useOrgPerformance();
  const stageRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const standings = useMemo(
    () => new Map((entries ?? []).map((entry) => [entry.agent.id, entry])),
    [entries],
  );
  const tree = useMemo(() => buildTree(org.agents), [org.agents]);
  const companyName = org.snapshot?.organization.name ?? UNNAMED_COMPANY;
  const { definition, agentCount } = useMemo(
    () => buildDefinition(tree, companyName, standings),
    [tree, companyName, standings],
  );

  const palette = useDiagramPalette(stageRef);
  useAgentNavigationCallback();
  const status = useMermaidDiagram({
    container: containerRef,
    definition,
    palette,
    enabled: tree.length > 0,
  });

  if (org.loading && org.agents.length === 0) return null;

  if (org.agents.length === 0) {
    return (
      <Fade asChild>
        <div className="px-4 lg:px-6">
          <EmptyState
            icon={NetworkIcon}
            title="Nobody hired yet"
            description="The hierarchy fills in as soon as an agent is hired."
            actionLabel="Hire agent"
            actionTo="/org/agents/new"
          />
        </div>
      </Fade>
    );
  }

  return (
    <div ref={stageRef} className="org-hierarchy-stage px-4 lg:px-6">
      {status === 'unavailable' ? (
        <Fade>
          <EmptyState
            icon={MonitorXIcon}
            title="The diagram could not be drawn"
            description="Something in this browser refused to load or run the chart renderer."
            variant="outline"
          />
        </Fade>
      ) : (
        <Fade asChild>
          <div className="relative">
            {/*
              Unconditionally mounted: the diagram hook writes Mermaid's own
              SVG output (built from our own escaped agent data, see
              `escapeLabel`) straight into this node by ref and wires up its
              click handlers in the same tick.
            */}
            <div
              ref={containerRef}
              className="min-h-64 overflow-x-auto rounded-lg border py-4 [&_svg]:mx-auto [&_svg]:h-auto [&_a]:cursor-pointer"
            />
            {status === 'loading' ? (
              // Fade instead of a plain div, the same way MemoryGraphPage
              // brings its loading chip in: the spinner enters with the
              // frame instead of popping over it.
              <Fade className="absolute inset-0 flex items-center justify-center">
                <Spinner aria-hidden="true" />
              </Fade>
            ) : null}
          </div>
        </Fade>
      )}
      <p className="sr-only" role="note">
        {agentCount} agents in the reporting hierarchy. Use the Agents list for a text version.
      </p>
    </div>
  );
}
