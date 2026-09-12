import { Navigate, Route, Routes } from 'react-router';
import { AppShell } from '@/components/shell/app-shell';
import { AgentDetailPage } from './pages/AgentDetailPage';
import { AgentFormPage } from './pages/AgentFormPage';
import { AssignmentDetailPage } from './pages/AssignmentDetailPage';
import { AssignmentsPage } from './pages/AssignmentsPage';
import { ChatPage } from './pages/ChatPage';
import { ConversationsPage } from './pages/ConversationsPage';
import { CronDetailPage } from './pages/CronDetailPage';
import { CronFormPage } from './pages/CronFormPage';
import { CronPage } from './pages/CronPage';
import { DashboardPage } from './pages/DashboardPage';
import { GatewayDetailPage } from './pages/GatewayDetailPage';
import { GatewaysPage } from './pages/GatewaysPage';
import { MemoryGraphPage } from './pages/MemoryGraphPage';
import { MemoryLayout } from './pages/MemoryLayout';
import { MemoryListPage } from './pages/MemoryListPage';
import { MemorySleepPage } from './pages/MemorySleepPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { OrgAgentsPage } from './pages/OrgAgentsPage';
import { OrgLayout } from './pages/OrgLayout';
import { OrgProjectsPage } from './pages/OrgProjectsPage';
import { OrgTeamsPage } from './pages/OrgTeamsPage';
import { ProjectFormPage } from './pages/ProjectFormPage';
import { SettingsPage } from './pages/SettingsPage';
import { SkillDetailPage } from './pages/SkillDetailPage';
import { SkillFormPage } from './pages/SkillFormPage';
import { SkillImportPage } from './pages/SkillImportPage';
import { SkillsPage } from './pages/SkillsPage';
import { TaskDetailPage } from './pages/TaskDetailPage';
import { TaskFormPage } from './pages/TaskFormPage';
import { TasksPage } from './pages/TasksPage';
import { TeamFormPage } from './pages/TeamFormPage';
import { ToolDetailPage } from './pages/ToolDetailPage';
import { ToolFormPage } from './pages/ToolFormPage';
import { ToolsPage } from './pages/ToolsPage';
import { VoicePage } from './pages/VoicePage';

/**
 * The route table, and nothing else.
 *
 * Every piece of state this file used to hold lives in `RookeryProvider`, the
 * frame lives in `AppShell`, and the labels live in `lib/nav.ts`. What is left
 * is a list of addresses - no adapters, because no page takes props any more.
 *
 * Two sections are nested layout routes rather than three sibling pages:
 * `/org` and `/memory` each keep a tab strip and a row of headline numbers
 * across their children, so the frame has to survive the tab change. Their
 * *form* and *detail* routes stay siblings on purpose - an agent's page brings
 * its own header and must not appear inside the company's tab frame.
 *
 * Order is documentation, not behaviour: react-router ranks a literal segment
 * above a parameter, so `/skills/new` wins over `/skills/:name` wherever it
 * stands. The literal routes are written first anyway, because the next reader
 * should not have to know that rule to believe the table.
 */
export default function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        {/* ------------------------------ arbeiten ---------------------- */}
        <Route path="/" element={<ChatPage />} />
        <Route path="/c/:sessionId" element={<ChatPage />} />
        <Route path="/chats" element={<ConversationsPage />} />
        <Route path="/dashboard" element={<DashboardPage />} />

        {/* ------------------------------- betrieb ---------------------- */}
        <Route path="/tasks" element={<TasksPage />} />
        <Route path="/tasks/new" element={<TaskFormPage />} />
        <Route path="/tasks/:id" element={<TaskDetailPage />} />
        <Route path="/tasks/:id/edit" element={<TaskFormPage />} />

        <Route path="/assignments" element={<AssignmentsPage />} />
        <Route path="/assignments/:id" element={<AssignmentDetailPage />} />

        <Route path="/cron" element={<CronPage />} />
        <Route path="/cron/new" element={<CronFormPage />} />
        <Route path="/cron/:id" element={<CronDetailPage />} />
        <Route path="/cron/:id/edit" element={<CronFormPage />} />

        <Route path="/gateways" element={<GatewaysPage />} />
        <Route path="/gateways/:id" element={<GatewayDetailPage />} />

        {/* --------------------------------- firma ---------------------- */}
        {/* The three tables share numbers and a tab strip, so they are
            children of one layout; `/org` itself is only the way in. */}
        <Route path="/org" element={<OrgLayout />}>
          <Route index element={<Navigate to="/org/agents" replace />} />
          <Route path="agents" element={<OrgAgentsPage />} />
          <Route path="teams" element={<OrgTeamsPage />} />
          <Route path="projects" element={<OrgProjectsPage />} />
        </Route>
        {/* Siblings, not children: these bring their own header and would sit
            crookedly inside the tab frame. */}
        <Route path="/org/agents/new" element={<AgentFormPage />} />
        <Route path="/org/agents/:id" element={<AgentDetailPage />} />
        <Route path="/org/agents/:id/edit" element={<AgentFormPage />} />
        <Route path="/org/teams/new" element={<TeamFormPage />} />
        <Route path="/org/teams/:id/edit" element={<TeamFormPage />} />
        <Route path="/org/projects/new" element={<ProjectFormPage />} />
        <Route path="/org/projects/:id/edit" element={<ProjectFormPage />} />

        {/* ----------------------------- gedächtnis --------------------- */}
        {/* The three children read the shared "Merken" dialog out of the
            layout's outlet context - they only work underneath it. */}
        <Route path="/memory" element={<MemoryLayout />}>
          <Route index element={<MemoryListPage />} />
          <Route path="graph" element={<MemoryGraphPage />} />
          <Route path="sleep" element={<MemorySleepPage />} />
        </Route>

        {/* ------------------------------ werkzeuge --------------------- */}
        <Route path="/tools" element={<ToolsPage />} />
        <Route path="/tools/new" element={<ToolFormPage />} />
        <Route path="/tools/:id" element={<ToolDetailPage />} />

        <Route path="/skills" element={<SkillsPage />} />
        <Route path="/skills/new" element={<SkillFormPage />} />
        <Route path="/skills/import" element={<SkillImportPage />} />
        <Route path="/skills/:name" element={<SkillDetailPage />} />
        <Route path="/skills/:name/edit" element={<SkillFormPage />} />

        {/* --------------------------- einstellungen -------------------- */}
        {/* `/settings` has no content of its own. The redirect names the first
            section here so the address bar never shows a page that is only a
            forwarding step; `SettingsPage` still catches an unknown section. */}
        <Route path="/settings" element={<Navigate to="/settings/identity" replace />} />
        <Route path="/settings/:section" element={<SettingsPage />} />

        {/* A mistyped link keeps its address and says so, inside the frame -
            the header and the rail are the two ways back. */}
        <Route path="*" element={<NotFoundPage />} />
      </Route>

      {/* Hands-free has no sidebar and no header: a sibling, not a child.
          A literal segment outranks the catch-all above, so this still wins. */}
      <Route path="/voice" element={<VoicePage />} />
    </Routes>
  );
}
