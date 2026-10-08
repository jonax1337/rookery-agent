import { AGENT_STAGE_LABEL } from '@/lib/format';
import { groupBy } from '@/lib/group-by';
import type { Agent, OrgPerformanceEntry } from '@/lib/types';

/** What the page can say about one flagged agent, beyond the label. */
type FlaggedStage = 1 | 2 | 3;

const STAGE_BADGE: Record<FlaggedStage, { glyph: string; colorVar: string }> = {
  1: { glyph: '⚠', colorVar: 'var(--chart-stage-warn)' },
  2: { glyph: '⚠', colorVar: 'var(--chart-stage-warn)' },
  3: { glyph: '⛔', colorVar: 'var(--chart-stage-critical)' },
};

/** The name every `click ... call` in the diagram resolves on `window`. */
export const NAVIGATE_CALLBACK = 'orgHierarchyNavigate';

export interface TreeNode {
  agent: Agent;
  children: TreeNode[];
}

/**
 * Agents under the assistant, each level sorted by name.
 *
 * An agent whose manager is no longer listed (archived) reports to the
 * assistant, the way the Agents table shows it - dropping it would take its
 * whole subtree off the chart.
 */
export function buildTree(agents: readonly Agent[]): TreeNode[] {
  const listed = new Set(agents.map((agent) => agent.id));
  const reportsOf = groupBy(agents, (agent) =>
    agent.managerId && listed.has(agent.managerId) ? agent.managerId : '',
  );
  const build = (managerId: string): TreeNode[] =>
    (reportsOf.get(managerId) ?? [])
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((agent) => ({ agent, children: build(agent.id) }));
  return build('');
}

/**
 * A name or title is free text an agent's own `hire_agent`/`update_agent`
 * call can set, so it is escaped rather than trusted before it goes anywhere
 * near the Mermaid source below - `securityLevel: 'loose'` (required for the
 * `click ... call` navigation) turns off Mermaid's own label sanitising, so
 * this is the only thing standing between that text and the rendered SVG
 * that is inserted into the page. `"` is escaped so a name can never close
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

/** The flowchart source, and how many agents it draws. */
export function buildDefinition(
  tree: readonly TreeNode[],
  companyName: string,
  standings: ReadonlyMap<string, OrgPerformanceEntry>,
): { definition: string; agentCount: number } {
  const lines = ['flowchart TD'];
  let agentCount = 0;

  lines.push('  root("🤖 Assistant<br/><small>Runs ' + escapeLabel(companyName) + '</small>")');
  lines.push('  class root rootNode');

  const walk = (node: TreeNode, parentId: string): void => {
    const nodeId = 'n' + agentCount++;
    const stage = standings.get(node.agent.id)?.performance.stage ?? 0;
    lines.push('  ' + nodeId + '("' + nodeLabel(node.agent, stage) + '")');
    lines.push('  ' + parentId + ' --> ' + nodeId);
    lines.push('  click ' + nodeId + ' call ' + NAVIGATE_CALLBACK + '("' + node.agent.id + '")');
    if (stage === 3) lines.push('  class ' + nodeId + ' stageCritical');
    else if (stage > 0) lines.push('  class ' + nodeId + ' stageWarn');
    for (const child of node.children) walk(child, nodeId);
  };

  for (const top of tree) walk(top, 'root');

  return { definition: lines.join('\n'), agentCount };
}

function nodeLabel(agent: Agent, stage: 0 | 1 | 2 | 3): string {
  const label = escapeLabel(agent.name) + '<br/><small>' + escapeLabel(agent.title) + '</small>';
  if (stage === 0) return label;
  const { glyph, colorVar } = STAGE_BADGE[stage];
  return (
    label +
    '<br/><small style="color:' + colorVar + '">' + glyph + ' ' + AGENT_STAGE_LABEL[stage] + '</small>'
  );
}
