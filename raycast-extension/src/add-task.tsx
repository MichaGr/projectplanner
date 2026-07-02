import {
  Action,
  ActionPanel,
  Form,
  Toast,
  getPreferenceValues,
  openExtensionPreferences,
  open as openInBrowser,
  showToast,
} from "@raycast/api";
import { useEffect, useMemo, useState } from "react";
import { getPlannerApiClient, AuthError, ConfigError } from "./lib/client";
import { formatDate, normalizeDateInput, validateSchedule } from "./lib/date";
import { flattenDestinations } from "./lib/destinations";
import type { DestinationOption } from "./lib/types";

type AddTaskValues = {
  destination: string;
  title: string;
  description: string;
  dueDate: string;
  doDate: string;
  tags: string;
};

const parseTags = (value: string) =>
  value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

export default function Command() {
  const preferences = getPreferenceValues<Preferences>();
  const [options, setOptions] = useState<DestinationOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const client = getPlannerApiClient(preferences);
    client
      .fetchTaskDestinations()
      .then((destinations) => {
        setOptions(flattenDestinations(destinations));
        setError(null);
      })
      .catch((cause) => {
        setError(cause instanceof Error ? cause.message : "Could not load destinations.");
      })
      .finally(() => setIsLoading(false));
  }, [preferences]);

  const initialDestination = options[0]?.value ?? "";
  const optionByValue = useMemo(() => new Map(options.map((option) => [option.value, option] as const)), [options]);

  if (error) {
    return (
      <Form
        actions={
          <ActionPanel>
            <Action title="Open Extension Preferences" onAction={openExtensionPreferences} />
          </ActionPanel>
        }
      >
        <Form.Description
          title="Connection Error"
          text={error}
        />
      </Form>
    );
  }

  return (
    <Form
      isLoading={isLoading}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Create Task"
            onSubmit={async (values: AddTaskValues) => {
              const selected = optionByValue.get(values.destination || initialDestination);
              if (!selected) {
                await showToast({ style: Toast.Style.Failure, title: "Choose a destination first." });
                return;
              }

              const dueDate = normalizeDateInput(values.dueDate);
              const doDate = normalizeDateInput(values.doDate);
              if (values.dueDate.trim() && !dueDate) {
                await showToast({ style: Toast.Style.Failure, title: "Due date must use YYYY-MM-DD." });
                return;
              }
              if (values.doDate.trim() && !doDate) {
                await showToast({ style: Toast.Style.Failure, title: "Do date must use YYYY-MM-DD." });
                return;
              }
              const scheduleError = validateSchedule(doDate, dueDate);
              if (scheduleError) {
                await showToast({ style: Toast.Style.Failure, title: scheduleError });
                return;
              }

              try {
                const client = getPlannerApiClient(preferences);
                const created = await client.createTask({
                  workspaceId: selected.workspaceId,
                  projectId: selected.projectId,
                  parentGroupId: selected.parentGroupId,
                  title: values.title.trim(),
                  description: values.description.trim(),
                  dueDate,
                  doDate,
                  tags: parseTags(values.tags),
                });
                await showToast({
                  style: Toast.Style.Success,
                  title: "Task created",
                  message: `${created.projectTitle} · ${created.title}`,
                });
              } catch (cause) {
                const message =
                  cause instanceof ConfigError || cause instanceof AuthError || cause instanceof Error
                    ? cause.message
                    : "Could not create task.";
                await showToast({ style: Toast.Style.Failure, title: "Create task failed", message });
              }
            }}
          />
          <Action
            title="Open Planner"
            onAction={() => openInBrowser(preferences.serverUrl)}
          />
          <Action title="Open Extension Preferences" onAction={openExtensionPreferences} />
        </ActionPanel>
      }
    >
      <Form.Dropdown id="destination" title="Destination" defaultValue={initialDestination}>
        {options.map((option) => (
          <Form.Dropdown.Item
            key={option.key}
            value={option.value}
            title={option.label}
            keywords={[option.helper]}
          />
        ))}
      </Form.Dropdown>
      <Form.TextField id="title" title="Task Name" placeholder="Ship Raycast support" />
      <Form.TextArea id="description" title="Description" placeholder="Optional task details" />
      <Form.TextField id="dueDate" title="Due Date" placeholder={formatDate("YYYY-MM-DD")} />
      <Form.TextField id="doDate" title="Do Date" placeholder={formatDate("YYYY-MM-DD")} />
      <Form.TextField id="tags" title="Tags" placeholder="Comma-separated tags" />
    </Form>
  );
}
