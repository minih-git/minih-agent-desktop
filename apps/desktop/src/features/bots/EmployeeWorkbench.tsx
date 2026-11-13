import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { BotListItem, TaskView } from "@minih-agent/shared";
import { taskTitleFromUtterance } from "@minih-agent/shared";
import { Button, Input, Select } from "../../components/ui";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { BotFormCard } from "./BotFormCard";
import { draftFromBot } from "./bot-draft";
import { botInitials, taskStageLabelKey, taskStatusTone } from "./bot-status";
import { taskRepoName } from "./BotTaskList";
import { TaskWorkspaceStatus } from "./TaskWorkspaceStatus";
import { useTasks } from "./use-tasks";

/**
 * One employee's workbench (ADR bot-sessions-and-steward §7, prototype ②).
 *
 * It answers the two questions a person has about an employee: what is it
 * holding, and what should it do next. The list is the employee's tasks — one
 * row per task, with its repository, branch, stage, origin and time — and the
 * new-task field starts another one directly, without a card, because the
 * person is the one asking.
 *
 * A new task is: create it (the host makes the task and its session in one
 * transaction), then send the typed text as the first user message of that
 * session and start the turn. Nothing here re-implements sending; the composer's
 * own `sendPrompt` does it.
 *
 * Sections and the profile form live in their own files, so this one stays the
 * container: header, tabs, and the data each tab reads.
 */
export function EmployeeWorkbench({
  employee,
  onOpenTask,
}: {
  employee: BotListItem;
  onOpenTask: (task: TaskView) => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"tasks" | "done" | "profile" | "memory">("tasks");
  // One fixed window per mount: a `Date.now()` in the render body would change
  // the query key on every paint and refetch forever.
  const [weekAgo] = useState(() => Date.now() - 7 * 24 * 60 * 60 * 1000);
  const open = useTasks(employee.sessionId);
  const archived = useTasks(employee.sessionId, {
    includeArchived: true,
    // The "done" tab is a window, not a history: a week is what a person still
    // remembers asking for.
    since: weekAgo,
  });

  const openTasks = open.tasks.filter((task) => !task.archivedAt);
  const waiting = openTasks.filter((task) => taskStatusTone(task) === "attention");
  const inProgress = openTasks.filter((task) => taskStatusTone(task) === "busy");
  const done = archived.tasks.filter((task) => Boolean(task.archivedAt));
  const name = employee.profile.name || employee.title;

  return (
    <div className="employee-workbench" data-testid="employee-workbench" data-employee={employee.sessionId}>
      <header className="employee-workbench-head">
        <span className="employee-workbench-avatar" aria-hidden>
          {employee.profile.avatar?.trim() || botInitials(name)}
        </span>
        <div className="employee-workbench-title">
          <h1>{name}</h1>
          <div className="employee-workbench-sub">
            <span>{employee.profile.duty ?? t("bots.workbench.noDuty")}</span>
            <span aria-hidden>·</span>
            <span>{employee.modelKey ?? t("bots.workbench.modelInherited")}</span>
            <span aria-hidden>·</span>
            <span>{permissionLabel(employee.profile.permissionMode, t)}</span>
            <span aria-hidden>·</span>
            {/* One scope in this slice: an employee works everywhere it is
                allowed to. Per-repository overrides are a later change. */}
            <span>{t("bots.workbench.scopeAll")}</span>
          </div>
        </div>
        <span className={`employee-workbench-waiting ${waiting.length > 0 ? "attention" : ""}`}>
          {t("bots.workbench.waitingCount", { count: waiting.length })}
        </span>
      </header>

      <NewTaskField employee={employee} />

      <div className="employee-workbench-tabs" role="tablist" aria-label={t("bots.workbench.tabs")}>
        <TabButton active={tab === "tasks"} onClick={() => setTab("tasks")} id="tasks">
          {t("bots.workbench.tabTasks")}
          <span className="employee-workbench-tab-count">{openTasks.length}</span>
        </TabButton>
        <TabButton active={tab === "done"} onClick={() => setTab("done")} id="done">
          {t("bots.workbench.tabDone")}
          <span className="employee-workbench-tab-count">{done.length}</span>
        </TabButton>
        <TabButton active={tab === "profile"} onClick={() => setTab("profile")} id="profile">
          {t("bots.workbench.tabProfile")}
        </TabButton>
        <TabButton active={tab === "memory"} onClick={() => setTab("memory")} id="memory">
          {t("bots.workbench.tabMemory")}
        </TabButton>
      </div>

      {tab === "tasks" ? (
        <div className="employee-workbench-section" role="tabpanel" aria-label={t("bots.workbench.tabTasks")}>
          <TaskGroup
            title={t("bots.workbench.waiting")}
            tasks={waiting}
            onOpenTask={onOpenTask}
            empty={t("bots.workbench.nothingWaiting")}
          />
          <TaskGroup
            title={t("bots.workbench.inProgress")}
            tasks={inProgress}
            onOpenTask={onOpenTask}
            empty={t("bots.workbench.nothingInProgress")}
          />
        </div>
      ) : null}

      {tab === "done" ? (
        <div className="employee-workbench-section" role="tabpanel" aria-label={t("bots.workbench.tabDone")}>
          <TaskGroup
            title={t("bots.workbench.recentlyDone")}
            tasks={done}
            onOpenTask={onOpenTask}
            empty={t("bots.workbench.nothingDone")}
          />
        </div>
      ) : null}

      {tab === "profile" ? (
        <div className="employee-workbench-section" role="tabpanel" aria-label={t("bots.workbench.tabProfile")}>
          <EmployeeProfile employee={employee} />
        </div>
      ) : null}

      {tab === "memory" ? (
        <div className="employee-workbench-section" role="tabpanel" aria-label={t("bots.workbench.tabMemory")}>
          {/* Memory is the next slice; this states that plainly rather than
              showing an empty list that looks like a bug. */}
          <div className="employee-workbench-empty" data-testid="employee-memory-empty">
            {t("bots.workbench.memoryEmpty")}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  id,
  children,
}: {
  active: boolean;
  onClick: () => void;
  id: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      id={`employee-tab-${id}`}
      aria-selected={active}
      className={`employee-workbench-tab ${active ? "active" : ""}`}
      data-workbench-tab={id}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/**
 * One group of tasks.
 *
 * The empty line is deliberate: a section that disappears teaches nothing about
 * whether the employee is idle or the view failed.
 */
function TaskGroup({
  title,
  tasks,
  onOpenTask,
  empty,
}: {
  title: string;
  tasks: readonly TaskView[];
  onOpenTask: (task: TaskView) => void;
  empty: string;
}) {
  const { t, i18n } = useTranslation();
  return (
    <section className="employee-task-group">
      <h2>{title}</h2>
      {tasks.length === 0 ? (
        <div className="employee-workbench-empty">{empty}</div>
      ) : (
        <ul className="employee-task-list">
          {tasks.map((task) => {
            const tone = taskStatusTone(task);
            const repo = taskRepoName(task);
            const when = new Date(task.archivedAt ?? task.createdAt);
            return (
              <li key={task.id}>
                <button
                  type="button"
                  className={`employee-task-row ${tone}`}
                  data-employee-task={task.id}
                  data-task-tone={tone}
                  data-task-stage={task.stage}
                  data-task-archived={task.archivedAt ? "" : undefined}
                  onClick={() => onOpenTask(task)}
                >
                  <span className="employee-task-title">
                    {task.title}
                    {repo ? <span className="employee-task-repo"> · {repo}</span> : null}
                    {/* The branch, its start point, the delivery route and the
                        workspace state come from one component, so this row and
                        the task header cannot describe the same folder
                        differently. */}
                    <TaskWorkspaceStatus task={task} />
                  </span>
                  {task.latestProgress ? (
                    <span className="employee-task-progress">{task.latestProgress}</span>
                  ) : null}
                  <span className="employee-task-meta">
                    <span className={`employee-task-stage ${tone}`}>{t(taskStageLabelKey(task.stage))}</span>
                    <span>
                      {task.origin === "steward"
                        ? t("bots.workbench.originSteward")
                        : t("bots.workbench.originDirect")}
                    </span>
                    <span>{when.toLocaleDateString(i18n.language)}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * The direct dispatch: pick a repository, type, press Enter.
 *
 * No card. A card exists because a model decided what the person meant and the
 * person has to confirm it; here the person already said exactly what they want,
 * to a named employee, so the confirmation would only be of their own sentence.
 */
function NewTaskField({ employee }: { employee: BotListItem }) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [projectPath, setProjectPath] = useState("");
  const [busy, setBusy] = useState(false);
  // True while the host prepares the new task's workspace: the task exists, but
  // no turn may start until the folder is ready, so the field says what it is
  // waiting for instead of looking stuck.
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const projects = useProjects();
  const selectSession = useAppStore((state) => state.selectSession);
  const sendPrompt = useAppStore((state) => state.sendPrompt);

  const options = projects;
  // The employee's own project is the default: that is the repository it was
  // hired to read, and asking again for every task would be noise.
  useEffect(() => {
    if (projectPath || !employee.projectPath) return;
    setProjectPath(employee.projectPath);
  }, [employee.projectPath, projectPath]);

  const submit = useCallback(async () => {
    const utterance = text.trim();
    if (!utterance || busy) return;
    setBusy(true);
    setError(null);
    setPreparing(Boolean(projectPath));
    try {
      const created = await api.createTask({
        employeeSessionId: employee.sessionId,
        title: taskTitleFromUtterance(utterance) || t("bots.workbench.untitledTask"),
        origin: "direct",
        projectPath: projectPath || null,
        sourceUtterance: utterance,
      });
      setPreparing(false);
      setText("");
      // Opening first is what makes the first message land in this task rather
      // than wherever the person was before.
      await selectSession(created.task.sessionId);
      const accepted = await sendPrompt(utterance, undefined, created.task.sessionId);
      if (!accepted) {
        setError(t("bots.workbench.sendFailed"));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPreparing(false);
      setBusy(false);
    }
  }, [busy, employee.sessionId, projectPath, selectSession, sendPrompt, t, text]);

  return (
    <div className="employee-workbench-new" data-workbench-new-error={error ? "" : undefined}>
      <div className="employee-workbench-new-row">
        <Input
          value={text}
          aria-label={t("bots.workbench.newTaskPlaceholder", {
            name: employee.profile.name || employee.title,
          })}
          placeholder={t("bots.workbench.newTaskPlaceholder", {
            name: employee.profile.name || employee.title,
          })}
          data-workbench-new-task=""
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey) return;
            event.preventDefault();
            void submit();
          }}
        />
        <Select
          aria-label={t("bots.workbench.repository")}
          value={projectPath}
          data-workbench-repository=""
          onChange={(event) => setProjectPath(event.target.value)}
        >
          <option value="">{t("bots.workbench.noRepository")}</option>
          {options.map((project) => (
            <option key={project.path} value={project.path}>
              {project.name || taskRepoName({ projectPath: project.path })}
            </option>
          ))}
        </Select>
        <Button
          type="button"
          disabled={busy || text.trim().length === 0}
          data-workbench-start=""
          onClick={() => void submit()}
        >
          {t("bots.workbench.start")}
        </Button>
      </div>
      {preparing ? (
        <div className="employee-workbench-preparing" data-workbench-preparing="">
          {t("bots.tasks.workspacePreparing")}
        </div>
      ) : null}
      <div className="employee-workbench-new-hint">
        {error ?? t("bots.workbench.newTaskHint")}
      </div>
    </div>
  );
}

/** The permission tier in the person's own words, as the settings page names it. */
function permissionLabel(
  mode: "inherit" | "ask" | "accept-edits" | "auto",
  t: (key: string) => string,
): string {
  switch (mode) {
    case "ask":
      return t("bots.settings.permissionAsk");
    case "accept-edits":
      return t("bots.settings.permissionAcceptEdits");
    case "auto":
      return t("bots.settings.permissionAuto");
    default:
      return t("chat.permissionInherit");
  }
}

/**
 * The repositories a person can choose.
 *
 * Read once per surface from the project list the shell already owns: a task is
 * bound to a project, and a project picker that re-read the list on every open
 * would be a second source of truth about which repositories exist.
 */
function useProjects(): { path: string; name: string }[] {
  const [projects, setProjects] = useState<{ path: string; name: string }[]>([]);
  useEffect(() => {
    let live = true;
    void api
      .listProjects()
      .then((result) => {
        if (!live) return;
        setProjects(result.projects.map((project) => ({ path: project.path, name: project.name })));
      })
      // A failed read leaves only "no repository": starting a task without one
      // is allowed, so the form still works.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return projects;
}

/** The profile tab edits the employee through the form the settings page uses. */
function EmployeeProfile({ employee }: { employee: BotListItem }) {
  const { t } = useTranslation();
  const projects = useProjects();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <BotFormCard
      initial={draftFromBot(employee)}
      definitions={[]}
      projects={projects}
      title={t("bots.settings.editTitle")}
      busy={busy}
      error={error}
      onCancel={() => setError(null)}
      onSubmit={(profile, projectPath) => {
        setBusy(true);
        setError(null);
        void api
          .updateBot({ sessionId: employee.sessionId, profile, projectPath })
          .then(() => setBusy(false))
          .catch((cause: unknown) => {
            setBusy(false);
            setError(cause instanceof Error ? cause.message : String(cause));
          });
      }}
    />
  );
}
