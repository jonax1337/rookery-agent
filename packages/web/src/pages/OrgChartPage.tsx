import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { MonitorXIcon, NetworkIcon } from 'lucide-react';

import { api } from '@/lib/api';
import type { Agent, OrgPerformanceEntry } from '@/lib/types';
import { usePageMeta } from '@/components/shell/page-meta';
import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { EmptyState } from '@/components/common/empty-state';
import { Spinner } from '@/components/ui/spinner';
import { useOrgState } from '@/providers/rookery-provider';

/**
 * The organigram, as Mermaid.
 *
 * The hand-rolled tree (cards plus absolutely-positioned line divs) worked
 * but looked exactly like what it was - three bespoke connector divs
 * re-deriving a diagram renderer instead of using one. A flowchart is
 * Mermaid's job, not this component's.
 *
 * Mermaid cannot read the app's oklch design tokens any more than the WebGL
 * memory graph can (`MemoryGraph3D.tsx`), so it gets the identical fix:
 * literal hex colours in a `.org-chart-stage` class in `styles/index.css`,
 * redefined under `.dark`, read back here with `getComputedStyle` and fed
 * into `mermaid.initialize({ themeVariables })`. A `MutationObserver` on the
 * root element's class re-renders the diagram when the theme flips, the
 * same mechanism `useGraphPalette` uses for the other graph.
 *
 * The library itself is a dynamic `import('mermaid')`, not a top-level one -
 * `MemoryGraph3D.tsx` code-splits `3d-force-graph` the same way, so a visitor
 * who never opens either graph page never downloads either library.
 */

interface TreeNode {
  agent: Agent;
  children: TreeNode[];
}

function buildTree(agents: Agent[]): TreeNode[] {
  const byManager = new Map<string | null, Agent[]>();
  for (const agent of agents) {
    const key = agent.managerId ?? null;
    const list = byManager.get(key) ?? [];
    list.push(agent);
    byManager.set(key, list);
  }
  const build = (managerId: string | null): TreeNode[] =>
    (byManager.get(managerId) ?? [])
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((agent) => ({ agent, children: build(agent.id) }));
  return build(null);
}

/**
 * A name or title is free text an agent's own `hire_agent`/`update_agent`
 * call can set, so it is escaped rather than trusted before it goes anywhere
 * near the Mermaid source below - `securityLevel: 'loose'` (required for the
 * `click ... call` navigation) turns off Mermaid's own label sanitising, so
 * this is the only thing standing between that text and the rendered SVG
 * `dangerouslySetInnerHTML` inserts. `"` is escaped so a name can never close
 * the quoted label early and inject a new node or directive; the newline
 * strip closes the same door for a multi-line label doing the same thing one
 * statement later. `<`/`>` stop it from becoming a tag once Mermaid's own
 * (enabled) `htmlLabels` renders the label as HTML.
 */
function escapeLabel(text: string): string {
  return text
    .replace(/[\r\n]+/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const STAGE_BADGE: Record<1 | 2 | 3, { text: string; colorVar: string }> = {
  1: { text: '⚠ Flagged', colorVar: 'var(--chart-stage-warn)' },
  2: { text: '⚠ On probation', colorVar: 'var(--chart-stage-warn)' },
  3: { text: '⛔ Replacement proposed', colorVar: 'var(--chart-stage-critical)' },
};

interface Palette {
  line: string;
  text: string;
  muted: string;
  nodeBg: string;
  rootBg: string;
  rootBorder: string;
  warn: string;
  critical: string;
}

function readPalette(stage: HTMLElement | null): Palette {
  const style = stage ? getComputedStyle(stage) : null;
  const read = (name: string, fallback: string): string => {
    const value = style?.getPropertyValue(name).trim();
    return value || fallback;
  };
  return {
    line: read('--chart-line', '#3a4049'),
    text: read('--chart-text', '#f2f0ea'),
    muted: read('--chart-muted', '#8aa0b4'),
    nodeBg: read('--chart-node-bg', '#1f2226'),
    rootBg: read('--chart-root-bg', '#1e2240'),
    rootBorder: read('--chart-root-border', '#818cf8'),
    warn: read('--chart-stage-warn', '#f59e0b'),
    critical: read('--chart-stage-critical', '#ef4444'),
  };
}

/** Builds the flowchart source and the id->agent map `click` callbacks resolve against. */
function buildDefinition(
  tree: TreeNode[],
  companyName: string,
  performance: Map<string, OrgPerformanceEntry> | null,
): { definition: string; agentByNodeId: Map<string, string> } {
  const lines = ['flowchart TD'];
  const agentByNodeId = new Map<string, string>();
  let counter = 0;

  lines.push('  root("🤖 Assistant<br/><small>Runs ' + escapeLabel(companyName) + '</small>")');
  lines.push('  class root rootNode');

  const walk = (node: TreeNode, parentId: string): void => {
    const nodeId = 'n' + counter++;
    agentByNodeId.set(nodeId, node.agent.id);
    const stage = performance?.get(node.agent.id)?.performance.stage ?? 0;
    const badge = stage > 0 ? STAGE_BADGE[stage as 1 | 2 | 3] : null;
    const label =
      escapeLabel(node.agent.name) +
      '<br/><small>' +
      escapeLabel(node.agent.title) +
      '</small>' +
      (badge ? '<br/><small style="color:' + badge.colorVar + '">' + badge.text + '</small>' : '');
    lines.push('  ' + nodeId + '("' + label + '")');
    lines.push('  ' + parentId + ' --> ' + nodeId);
    lines.push('  click ' + nodeId + ' call orgChartNavigate("' + node.agent.id + '")');
    if (stage === 3) lines.push('  class ' + nodeId + ' stageCritical');
    else if (stage > 0) lines.push('  class ' + nodeId + ' stageWarn');
    for (const child of node.children) walk(child, nodeId);
  };

  for (const top of tree) walk(top, 'root');

  return { definition: lines.join('\n'), agentByNodeId };
}

export function OrgChartPage() {
  usePageMeta({ title: 'Org chart' }, []);
  const org = useOrgState();
  const navigate = useNavigate();
  const stageRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const renderId = useId().replace(/:/g, '');

  const [performance, setPerformance] = useState<Map<string, OrgPerformanceEntry> | null>(null);
  useEffect(() => {
    api
      .orgPerformance()
      .then((rows) => setPerformance(new Map(rows.map((row) => [row.agent.id, row]))))
      .catch(() => setPerformance(null));
  }, []);

  const activeAgents = useMemo(() => org.agents.filter((agent) => !agent.archived), [org.agents]);
  const tree = useMemo(() => buildTree(activeAgents), [activeAgents]);
  const { definition, agentByNodeId } = useMemo(
    () => buildDefinition(tree, org.snapshot?.organization.name ?? 'the company', performance),
    [tree, org.snapshot?.organization.name, performance],
  );

  // Read the theme's literal colours off `.org-chart-stage` and re-read them
  // whenever the root class changes (light/dark toggle) - see the file
  // comment and `useGraphPalette` in MemoryGraph3D.tsx for why this cannot
  // just be the app's oklch tokens.
  const [palette, setPalette] = useState<Palette>(() => readPalette(null));
  useEffect(() => {
    const update = (): void => setPalette(readPalette(stageRef.current));
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  // The one function `click ... call orgChartNavigate(...)` in the diagram
  // resolves against - kept current via a ref so the diagram never has to
  // be re-rendered just because `navigate` itself got a new identity.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  useEffect(() => {
    (window as unknown as Record<string, unknown>).orgChartNavigate = (agentId: string): void => {
      navigateRef.current('/org/agents/' + agentId);
    };
    return () => {
      delete (window as unknown as Record<string, unknown>).orgChartNavigate;
    };
  }, []);

  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading');

  useEffect(() => {
    if (tree.length === 0) return;
    let cancelled = false;
    setStatus('loading');
    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'loose',
          fontFamily: 'inherit',
          theme: 'base',
          themeVariables: {
            primaryColor: palette.nodeBg,
            primaryTextColor: palette.text,
            primaryBorderColor: palette.line,
            lineColor: palette.line,
            background: 'transparent',
          },
        });
        const result = await mermaid.render(
          'org-chart-' + renderId,
          [
            definition,
            'classDef rootNode fill:' + palette.rootBg + ',stroke:' + palette.rootBorder + ',stroke-width:2px;',
            'classDef stageWarn stroke:' + palette.warn + ',stroke-width:2px;',
            'classDef stageCritical stroke:' + palette.critical + ',stroke-width:2px;',
          ].join('\n'),
        );
        if (cancelled || !containerRef.current) return;
        // Set directly rather than through `dangerouslySetInnerHTML` and
        // `bindFunctions` on the next frame: that round-trip through React
        // state raced the DOM node's own mount (the container only exists
        // once `svg` is set, so the ref could still be null when the
        // deferred call ran) and silently never wired up a single `click`
        // directive - no error, the diagram just stopped being clickable.
        // The container div below is unconditional for exactly this reason:
        // the ref is guaranteed to already be attached when this effect runs.
        containerRef.current.innerHTML = result.svg;
        result.bindFunctions?.(containerRef.current);
        setStatus('ready');
      } catch {
        if (!cancelled) setStatus('unavailable');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [definition, palette, renderId, tree.length]);

  if (org.loading && activeAgents.length === 0) return null;

  if (activeAgents.length === 0) {
    return (
      <Fade asChild>
        <div className="px-4 lg:px-6">
          <EmptyState
            icon={NetworkIcon}
            title="Nobody hired yet"
            description="The org chart fills in as soon as an agent is hired."
            actionLabel="Hire agent"
            actionTo="/org/agents/new"
          />
        </div>
      </Fade>
    );
  }

  return (
    <div ref={stageRef} className="org-chart-stage px-4 lg:px-6">
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
              Unconditionally mounted: the effect above writes Mermaid's own
              SVG output (built from our own escaped agent data, see
              `escapeLabel`) straight into this node by ref and wires up its
              click handlers in the same tick - see the comment there for why
              that stopped being optional.
            */}
            <div
              ref={containerRef}
              className="min-h-64 overflow-x-auto rounded-lg border py-4 [&_svg]:mx-auto [&_svg]:h-auto [&_a]:cursor-pointer"
            />
            {status === 'loading' ? (
              // Fade instead of a plain div, the same way MemoryGraphPage
              // brings its loading chip in: the spinner enters with the
              // frame instead of popping over it, and leaves as abruptly
              // as it always did.
              <Fade className="absolute inset-0 flex items-center justify-center">
                <Spinner aria-hidden="true" />
              </Fade>
            ) : null}
          </div>
        </Fade>
      )}
      <p className="sr-only" role="note">
        {agentByNodeId.size} agents in the reporting chart. Use the Agents list for a text version.
      </p>
    </div>
  );
}
